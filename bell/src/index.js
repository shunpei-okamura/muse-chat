// Muse対応チャットの呼び鈴（v4.15）
// Render から届いた写し（発言・依頼・送信取消）を、各Museのリスナーへ WebSocket で即座に流す。
// 直近分（48時間・1,000件まで）を保持し、再接続時に after=<番号> 以降を再生する。
// WebSocket はハイバネーションで受けるので、配信が無い間はオブジェクトが休止して課金されない。
import { DurableObject } from 'cloudflare:workers';

const KEEP_MS = 48 * 60 * 60 * 1000;
const KEEP_MAX = 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const MAX_BODY = 256 * 1024;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const bearer = (req) => (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// 長さ以外の情報を漏らさない比較
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/publish' || pathname === '/listen' || pathname === '/health') {
      const stub = env.BELL.get(env.BELL.idFromName('main'));
      return stub.fetch(request);
    }
    return json({ error: 'not found' }, 404);
  },
};

export class Bell extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      no INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, room_id TEXT, audience TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS seats (seat_id TEXT PRIMARY KEY, token_sha256 TEXT NOT NULL, room_ids TEXT NOT NULL)`);
    // 最新の番号は専用の表に持つ（イベントが全部消えても番号が戻らないように）
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`);
    this.sql.exec(`INSERT OR IGNORE INTO meta (k, v) SELECT 'last_no', COALESCE(MAX(no), 0) FROM events`);
    // リスナーの "ping" にはオブジェクトを起こさずに "pong" を返す
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/publish' && request.method === 'POST') return this.publish(request);
    if (pathname === '/listen') return this.listen(request, searchParams);
    if (pathname === '/health') return json({ ok: true, last_no: this.lastNo(), events: this.count(), sockets: this.ctx.getWebSockets().length });
    return json({ error: 'not found' }, 404);
  }

  lastNo() { return this.sql.exec("SELECT v FROM meta WHERE k = 'last_no'").one().v; }
  count() { return this.sql.exec('SELECT COUNT(*) AS n FROM events').one().n; }

  async publish(request) {
    if (!this.env.BELL_SECRET || !safeEqual(bearer(request), this.env.BELL_SECRET)) return json({ error: 'unauthorized' }, 401);
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'invalid json' }, 400); }
    const events = Array.isArray(body && body.events) ? body.events : [];
    for (const ev of events) {
      if (!ev || typeof ev.type !== 'string') continue;
      if (ev.type === 'seats') { this.replaceSeats(ev.data && ev.data.seats); continue; }
      const audience = Array.isArray(ev.audience) ? ev.audience.filter(a => typeof a === 'string') : [];
      const at = Date.now();
      const no = this.lastNo() + 1;
      this.sql.exec('INSERT INTO events (no, type, room_id, audience, data, at) VALUES (?, ?, ?, ?, ?, ?)',
        no, ev.type, ev.room_id || null, JSON.stringify(audience), JSON.stringify(ev.data || {}), at);
      this.sql.exec("UPDATE meta SET v = ? WHERE k = 'last_no'", no);
      const frame = JSON.stringify({ no, type: ev.type, room_id: ev.room_id || null, data: ev.data || {}, at: new Date(at).toISOString() });
      for (const seat of audience) {
        for (const ws of this.ctx.getWebSockets(seat)) { try { ws.send(frame); } catch { /* 切れた接続は close で片付く */ } }
      }
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
    return json({ ok: true, last_no: this.lastNo() });
  }

  // 席と連携トークンのハッシュを全件置き換える。無効になった接続は閉じる
  replaceSeats(seats) {
    if (!Array.isArray(seats)) return;
    this.sql.exec('DELETE FROM seats');
    for (const s of seats) {
      if (!s || typeof s.seat_id !== 'string' || typeof s.token_sha256 !== 'string') continue;
      this.sql.exec('INSERT OR REPLACE INTO seats (seat_id, token_sha256, room_ids) VALUES (?, ?, ?)',
        s.seat_id, s.token_sha256, JSON.stringify(Array.isArray(s.room_ids) ? s.room_ids : []));
    }
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      const row = this.sql.exec('SELECT token_sha256 FROM seats WHERE seat_id = ?', a.seat_id || '').toArray()[0];
      if (!row || row.token_sha256 !== a.token_sha256) { try { ws.close(4001, 'seat revoked'); } catch { /* ignore */ } }
    }
  }

  async listen(request, params) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'websocket required' }, 426);
    const token = bearer(request);
    if (!token) return json({ error: 'unauthorized' }, 401);
    const hash = await sha256hex(token);
    const row = this.sql.exec('SELECT seat_id FROM seats WHERE token_sha256 = ?', hash).toArray()[0];
    if (!row) return json({ error: 'unauthorized' }, 401);
    const seatId = row.seat_id;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [seatId]);
    server.serializeAttachment({ seat_id: seatId, token_sha256: hash });
    server.send(JSON.stringify({ type: 'hello', seat_id: seatId, last_no: this.lastNo() }));

    // 取りこぼし分の再生（その席宛のものだけ、古い順）
    const after = Number(params.get('after'));
    if (Number.isFinite(after) && after >= 0 && params.has('after')) {
      const rows = this.sql.exec('SELECT no, type, room_id, audience, data, at FROM events WHERE no > ? ORDER BY no', after).toArray();
      for (const r of rows) {
        if (!JSON.parse(r.audience).includes(seatId)) continue;
        server.send(JSON.stringify({ no: r.no, type: r.type, room_id: r.room_id, data: JSON.parse(r.data), at: new Date(r.at).toISOString(), replay: true }));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage() { /* リスナーからの送信は使わない（ping は自動応答） */ }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* ignore */ } }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch { /* ignore */ } }

  // 古いイベントの削除（48時間より前、または新しい順に1,000件を超えた分）
  async alarm() {
    this.sql.exec('DELETE FROM events WHERE at < ?', Date.now() - KEEP_MS);
    this.sql.exec('DELETE FROM events WHERE no <= ?', this.lastNo() - KEEP_MAX);
    if (this.count() > 0) await this.ctx.storage.setAlarm(Date.now() + PRUNE_EVERY_MS);
  }
}
