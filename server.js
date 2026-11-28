'use strict';
// Muse対応チャット server v4.1
// - 永続化: Upstash を「メタ情報1キー + ルームごとのメッセージリスト」に分割（旧キーから自動移行）
// - 読み込み失敗時は起動しない／保存失敗は検知して再試行（空DBでの上書きを防ぐ）
// - 送信取消（24時間以内）
// - ブリッジ即応: 長ポーリング /api/bridge/wait、考え中表示、Museの在席状況、依頼の期限切れ
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ENV_FILE = path.join(ROOT, '.env');

// ---------- .env ----------
function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  if (!env.BRIDGE_TOKEN && !process.env.BRIDGE_TOKEN) {
    env.BRIDGE_TOKEN = crypto.randomBytes(24).toString('hex');
    const port = env.PORT || '8377';
    try { fs.writeFileSync(ENV_FILE, `PORT=${port}\nBRIDGE_TOKEN=${env.BRIDGE_TOKEN}\n`, { mode: 0o600 }); } catch { /* ignore */ }
  }
  if (process.env.PORT) env.PORT = String(process.env.PORT);
  if (process.env.BRIDGE_TOKEN) env.BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
  return env;
}
const ENV = loadEnv();
const PORT = parseInt(ENV.PORT || '8377', 10);
const BRIDGE_TOKEN = ENV.BRIDGE_TOKEN;

// ---------- settings ----------
const UNSEND_WINDOW_MS = 24 * 60 * 60 * 1000;               // 送信取消できる期間
const REQ_TTL_MS = Number(process.env.MUSE_REQUEST_TTL_MS) || 24 * 60 * 60 * 1000; // v4.8: Muse依頼の有効期限（全種別24時間に統一）
const PICK_RETRY_MS = 5 * 60 * 1000;                          // 受け取り後この時間返信がなければ再配布
const LIVE_WINDOW_MS = 60 * 1000;                             // 見張り役が接続中とみなす時間
const POLLING_WINDOW_MS = 20 * 60 * 1000;                     // 巡回で拾ってくれる見込みの時間
const KEEP_DONE_REQ_MS = 7 * 24 * 60 * 60 * 1000;             // 処理済み依頼を保持する期間

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// v4.24: 回答期限 due は 'YYYY-MM-DD' または null。形式が違う値は null として扱う（後方互換）
function isValidDue(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')); }
function normalizeDue(v) { return isValidDue(v) ? v : null; }
// リクエストボディの due を解釈する。キーが無ければ undefined（変更しない）、null/'' はクリア(null)、有効な日付文字列はその値、それ以外は 'invalid'
function parseDueField(body) { if (!body || !('due' in body)) return undefined; const v = body.due; if (v === null || v === '') return null; return isValidDue(v) ? v : 'invalid'; }
// ---------- v4.26: 投票・申告・フェーズ・種別・決着・リアクション ----------
const TASK_PHASES = ['intake', 'conditions', 'candidates', 'voting', 'decided', 'parked'];
const TASK_KINDS = ['decision', 'ops'];
const VOTE_CHOICES = ['yes', 'yes_conditional', 'no', 'hold'];
const STANCE_TEMPS = ['high', 'mid', 'low'];
const HUMAN_REACTIONS = ['👍', '👀', '✅'];
const MUSE_REACTIONS = ['👀'];
const normalizePhase = (v) => (TASK_PHASES.includes(v) ? v : 'intake');
const normalizeKind = (v) => (TASK_KINDS.includes(v) ? v : 'decision');
function normalizeVotes(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => x && VOTE_CHOICES.includes(x.choice)).map(x => ({
    ownerId: x.ownerId || null, seatName: String(x.seatName || 'Muse').slice(0, 40),
    choice: x.choice, option: x.option ? String(x.option).slice(0, 60) : null,
    condition: x.condition ? String(x.condition).slice(0, 200) : null,
    registeredBy: x.registeredBy === 'human' ? 'human' : 'muse',
    updatedAt: x.updatedAt || null,
    proposalAt: x.proposalAt || null,
  }));
}
// v4.27: proposal（現在の提案）。{ text, updatedAt, updatedBy } または null（未設定）
function normalizeProposal(v) {
  if (!v || typeof v !== 'object') return null;
  const text = String(v.text || '').trim().slice(0, 300);
  if (!text) return null;
  return { text, updatedAt: v.updatedAt || null, updatedBy: v.updatedBy ? String(v.updatedBy).slice(0, 40) : null };
}
function proposalAtOf(t) { const p = normalizeProposal(t && t.proposal); return p ? (p.updatedAt || null) : null; }
// 現在の提案への票だけ（proposal未設定時は proposalAt=null の旧票＝後方互換）
function currentVotes(t) { const at = proposalAtOf(t); return normalizeVotes(t.votes).filter(v => (v.proposalAt || null) === at); }
// body の proposal を解釈。キー無し=undefined(変更しない)、null/''/{text:''}=クリア(null)、文字列/ {text}=その文、それ以外='invalid'
function parseProposalField(body) {
  if (!body || !('proposal' in body)) return undefined;
  const v = body.proposal;
  if (v === null || v === '') return null;
  if (typeof v === 'string') { const tx = v.trim().slice(0, 300); return tx ? tx : null; }
  if (v && typeof v === 'object') { const tx = String(v.text || '').trim().slice(0, 300); return tx ? tx : null; }
  return 'invalid';
}
// 提案を適用。文が変わったら既存の票・優勢宣言・異議は前の提案へのものなのでリセットする。変わった場合 true
function applyProposal(t, textOrNull, byName) {
  const cur = normalizeProposal(t.proposal);
  const curText = cur ? cur.text : null;
  if (textOrNull === curText) return false;
  if (textOrNull === null) t.proposal = null;
  else t.proposal = { text: textOrNull, updatedAt: now(), updatedBy: byName || null };
  t.votes = []; t.dominance = null; t.objections = [];
  return true;
}
function normalizeStances(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => x && typeof x === 'object').map(x => ({
    ownerId: x.ownerId || null, seatName: String(x.seatName || 'Muse').slice(0, 40),
    conditions: x.conditions ? String(x.conditions).slice(0, 500) : '',
    nonNegotiables: x.nonNegotiables ? String(x.nonNegotiables).slice(0, 500) : '',
    temperature: STANCE_TEMPS.includes(x.temperature) ? x.temperature : null,
    registeredBy: x.registeredBy === 'human' ? 'human' : 'muse',
    updatedAt: x.updatedAt || null,
  }));
}
function normalizeReactions(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(x => x && typeof x.emoji === 'string').map(x => ({
    userId: String(x.userId || ''), name: String(x.name || '').slice(0, 40), emoji: x.emoji, at: x.at || null,
  }));
}
// タスクの表示・受け渡し形（既存項目は kind=decision / phase=intake / 票・申告なしとして後方互換）
function taskView(t) {
  return {
    ...t, due: normalizeDue(t.due), kind: normalizeKind(t.kind), phase: normalizePhase(t.phase),
    proposal: normalizeProposal(t.proposal),
    votes: currentVotes(t), stances: normalizeStances(t.stances),
    dominance: t.dominance || null, objections: Array.isArray(t.objections) ? t.objections : [],
  };
}
// 票の集計。分母は全席（Muse席の総数）。賛成側=yes+yes_conditional、反対=no、holdはどちらにも数えない
function voteSummary(room, t) {
  const total = seatsOf(room).length;
  const votes = currentVotes(t);
  const yes = votes.filter(v => v.choice === 'yes').length;
  const yesConditional = votes.filter(v => v.choice === 'yes_conditional').length;
  const no = votes.filter(v => v.choice === 'no').length;
  const hold = votes.filter(v => v.choice === 'hold').length;
  const votedOwners = new Set(votes.map(v => v.ownerId || '__legacy__'));
  return {
    total, yes, yesConditional, yesSide: yes + yesConditional, no, hold,
    unvoted: Math.max(0, total - votedOwners.size), votedCount: votes.length,
    majoritySide: (yes + yesConditional) * 2 > total && total > 0 ? 'yes' : (no * 2 > total && total > 0 ? 'no' : null),
  };
}
// ブリッジ呼び出し元の席。global トークンはレガシー席（ownerId=null）専用
function callerSeat(caller, room) {
  if (!room) return null;
  if (caller.kind === 'global') return seatsOf(room).find(s => !s.ownerId) || null;
  return seatByOwner(room, caller.profile.id);
}
// 集約席かどうか（レガシー席、またはルーム作成者の席）
function isAggregatorSeat(caller, room, seat) {
  if (!seat) return false;
  if (!seat.ownerId) return true;
  return !!room && room.createdBy === seat.ownerId;
}
// relay 申告（自分の依頼のみ）。成功したら true
function applyRelay(caller, requestId) {
  if (!requestId) return false;
  const r = db.kapioRequests.find(x => x.id === requestId);
  if (!r || !bridgeSees(caller, r)) return false;
  if (!r.relayedAt) { r.relayedAt = now(); }
  return true;
}
const id = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

// ---------- DB (in memory) ----------
function emptyDb() {
  return { profiles: [], rooms: [], members: [], messages: [], kapioRequests: [], decisions: [], tasks: [], pushSubs: [], seq: 0 };
}
function normalizeDb() {
  for (const k of ['profiles', 'rooms', 'members', 'messages', 'kapioRequests', 'decisions', 'tasks', 'pushSubs']) {
    if (!Array.isArray(db[k])) db[k] = [];
  }
  delete db.notifications; // v4.1: 通知は保存せず、未読メッセージから組み立てる
  // v4.24: 既存タスクに due が無ければ null を補う（既存フィールドの挙動は変えない）
  for (const t of db.tasks) { t.due = normalizeDue(t.due); t.kind = normalizeKind(t.kind); t.phase = normalizePhase(t.phase); t.proposal = normalizeProposal(t.proposal); if (!Array.isArray(t.votes)) t.votes = []; if (!Array.isArray(t.stances)) t.stances = []; }
  for (const m of db.messages) { if (!Array.isArray(m.reactions)) m.reactions = []; }
  if (typeof db.seq !== 'number') db.seq = db.messages.reduce((a, m) => Math.max(a, m.seq || 0), 0);
  // v4.3: Muse席を複数席（room.muses）に移行する。ownerId が null の席はレガシー（カピお）席
  for (const room of db.rooms) {
    if (!Array.isArray(room.muses)) {
      room.muses = [];
      if (room.muse && room.muse.ownerId) room.muses.push({ ownerId: room.muse.ownerId, name: room.muse.name || 'Muse' });
      else if (room.muse) room.muses.push({ ownerId: null, name: room.muse.name || KAPIO_NAME });
      else if (room.kapioEnabled) room.muses.push({ ownerId: null, name: KAPIO_NAME });
      delete room.muse;
    }
    for (const s of room.muses) {
      const sid = s.ownerId ? `muse:${s.ownerId}` : KAPIO_ID;
      if (!db.members.some(m => m.roomId === room.id && m.profileId === sid)) {
        db.members.push({ roomId: room.id, profileId: sid, lastReadSeq: null, joinedAt: room.createdAt || now() });
      }
    }
    room.kapioEnabled = room.muses.length > 0;
  }
}
let db = emptyDb();

// ---------- persistence ----------
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REMOTE = !!(UPSTASH_URL && UPSTASH_TOKEN);
const META_KEY = 'mc:v2:meta';
const ROOM_KEY = (roomId) => `mc:v2:room:${roomId}:msgs`;
const LEGACY_KEY = 'muse-chat-db-v1';

// commands: [['SET', key, value], ...] をトランザクションで実行。HTTPエラーもコマンドエラーも例外にする
async function upstash(commands, { atomic = true } = {}) {
  const res = await fetch(`${UPSTASH_URL}/${atomic ? 'multi-exec' : 'pipeline'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upstash HTTP ${res.status}: ${text.slice(0, 200)}`);
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('upstash: invalid JSON response'); }
  if (!Array.isArray(out)) throw new Error(`upstash: unexpected response ${text.slice(0, 200)}`);
  for (const r of out) if (r && r.error) throw new Error(`upstash: ${r.error}`);
  return out.map(r => (r ? r.result : null));
}

const persist = { meta: false, appends: [], rewrite: new Set(), timer: null, inflight: false, failures: 0, lastOkAt: null, lastError: null };
let remoteReady = !USE_REMOTE; // リモートの読み込みに成功するまで、リモートへは一切書かない

function metaSnapshot() {
  const cutoff = Date.now() - KEEP_DONE_REQ_MS;
  db.kapioRequests = db.kapioRequests.filter(r => r.status === 'pending' || Date.parse(r.handledAt || r.createdAt) > cutoff);
  const { messages, ...meta } = db;
  return meta;
}
function schedulePersist() {
  clearTimeout(persist.timer);
  persist.timer = setTimeout(flushAll, USE_REMOTE ? 300 : 100);
}
function save() { persist.meta = true; schedulePersist(); }                 // メタ情報の変更
function saveAppend(msg) { persist.appends.push(msg); save(); }            // メッセージ追加
function saveRewrite(roomId) { persist.rewrite.add(roomId); save(); }     // 既存メッセージの変更（取消・削除・更新）

async function flushAll() {
  if (!USE_REMOTE) { flushFile(); return; }
  await flushRemote();
}
function flushFile() {
  persist.meta = false; persist.appends = []; persist.rewrite = new Set();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
    persist.lastOkAt = now(); persist.failures = 0; persist.lastError = null;
  } catch (e) { persist.failures++; persist.lastError = e.message; console.error('file save failed', e); }
}
async function flushRemote() {
  if (!remoteReady) return;
  if (persist.inflight) { schedulePersist(); return; }
  if (!persist.meta && !persist.appends.length && !persist.rewrite.size) return;
  const meta = persist.meta, appends = persist.appends, rewrite = persist.rewrite;
  persist.meta = false; persist.appends = []; persist.rewrite = new Set();

  const cmds = [];
  if (meta) cmds.push(['SET', META_KEY, JSON.stringify(metaSnapshot())]);
  for (const roomId of rewrite) {
    cmds.push(['DEL', ROOM_KEY(roomId)]);
    const msgs = db.messages.filter(m => m.roomId === roomId).map(m => JSON.stringify(m));
    for (let i = 0; i < msgs.length; i += 100) cmds.push(['RPUSH', ROOM_KEY(roomId), ...msgs.slice(i, i + 100)]);
  }
  const byRoom = new Map();
  for (const m of appends) {
    if (rewrite.has(m.roomId)) continue; // 書き直しに含まれる
    if (!byRoom.has(m.roomId)) byRoom.set(m.roomId, []);
    byRoom.get(m.roomId).push(JSON.stringify(m));
  }
  for (const [roomId, arr] of byRoom) cmds.push(['RPUSH', ROOM_KEY(roomId), ...arr]);

  persist.inflight = true;
  try {
    await upstash(cmds);
    persist.failures = 0; persist.lastOkAt = now(); persist.lastError = null;
  } catch (e) {
    persist.failures++; persist.lastError = e.message;
    console.error(`remote save failed (${persist.failures})`, e.message);
    // 失敗分を戻して再試行（トランザクションなので部分的には書かれていない）
    persist.meta = persist.meta || meta;
    persist.appends = appends.concat(persist.appends);
    for (const r of rewrite) persist.rewrite.add(r);
    clearTimeout(persist.timer);
    persist.timer = setTimeout(flushAll, Math.min(5000 * persist.failures, 60000));
  } finally {
    persist.inflight = false;
  }
}

async function remoteLoadOnce() {
  const [metaStr, legacyStr] = await upstash([['GET', META_KEY], ['GET', LEGACY_KEY]], { atomic: false });
  if (metaStr) {
    const meta = JSON.parse(metaStr);
    if (!meta || !Array.isArray(meta.profiles) || !Array.isArray(meta.rooms)) throw new Error('meta is broken');
    const lists = meta.rooms.length
      ? await upstash(meta.rooms.map(r => ['LRANGE', ROOM_KEY(r.id), '0', '-1']), { atomic: false })
      : [];
    const seen = new Set();
    const messages = [];
    for (const list of lists) {
      for (const s of list || []) {
        let m; try { m = JSON.parse(s); } catch { continue; }
        if (!m || !m.id || seen.has(m.id)) continue;
        seen.add(m.id); messages.push(m);
      }
    }
    messages.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    db = { ...meta, messages };
    normalizeDb();
    return 'v2';
  }
  if (legacyStr) {
    const parsed = JSON.parse(legacyStr);
    if (!parsed || !Array.isArray(parsed.profiles)) throw new Error('legacy data is broken');
    db = parsed;
    normalizeDb();
    // 新形式へ書き出す（旧キーはバックアップとして残す）
    persist.meta = true;
    for (const r of db.rooms) persist.rewrite.add(r.id);
    return 'migrated';
  }
  db = emptyDb();
  return 'empty';
}
async function loadDb() {
  if (!USE_REMOTE) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = emptyDb(); }
    normalizeDb();
    return 'file';
  }
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const how = await remoteLoadOnce();
      remoteReady = true;
      return how;
    } catch (e) {
      lastErr = e;
      console.error(`remote load attempt ${attempt} failed:`, e.message);
      await sleep(Math.min(2000 * attempt, 10000));
    }
  }
  throw lastErr;
}

// ---------- Web Push (VAPID) ----------
let webpush = null;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:kapio@muse.ai', VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (e) { console.error('web-push init failed', e); webpush = null; }
}
function sendPushToProfile(profileId, payload) {
  if (!webpush) return;
  for (const s of db.pushSubs.filter(x => x.profileId === profileId)) {
    webpush.sendNotification(s.subscription, JSON.stringify(payload)).catch(err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        db.pushSubs = db.pushSubs.filter(x => x.endpoint !== s.endpoint);
        save();
      }
    });
  }
}

// ---------- helpers ----------
const COLORS = ['#e17055', '#0984e3', '#00b894', '#6c5ce7', '#d63031', '#e84393', '#fdcb6e', '#00cec9', '#fab1a0', '#74b9ff'];
function colorFor(seed) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newInviteCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!db.rooms.some(r => r.inviteCode === code)) return code;
  }
}
const KAPIO_ID = 'kapio';
const KAPIO_NAME = 'カピお';
const isSeatId = (x) => x === KAPIO_ID || (typeof x === 'string' && x.startsWith('muse:'));
const roomById = (roomId) => db.rooms.find(r => r.id === roomId) || null;

// v4.3: 席は複数。seat = { ownerId, name }、ownerId が null ならレガシー（カピお）席
const seatIdOf = (seat) => (seat && seat.ownerId ? `muse:${seat.ownerId}` : KAPIO_ID);
const seatsOf = (room) => (room && Array.isArray(room.muses) ? room.muses : []);
const seatByOwner = (room, ownerId) => seatsOf(room).find(s => (s.ownerId || null) === (ownerId || null)) || null;
function seatName(room) { // 互換用：最初の席の名前
  const seats = seatsOf(room);
  return seats.length ? (seats[0].name || 'Muse') : 'Muse';
}
function seatNameFor(room, ownerId) {
  const s = seatByOwner(room, ownerId);
  if (s) return s.name || 'Muse';
  return ownerId ? 'Muse' : KAPIO_NAME;
}
// 席を担当するブリッジのキー（'global' = カピお専用トークン、それ以外は持ち主のprofileId）
const seatBridgeKeyOf = (seat) => (seat && seat.ownerId ? seat.ownerId : 'global');
function seatsInfo(room, viewerId) {
  return seatsOf(room).map(s => {
    const owner = s.ownerId ? db.profiles.find(p => p.id === s.ownerId) : null;
    return {
      seatId: seatIdOf(s), ownerId: s.ownerId || null, ownerName: owner ? owner.name : null,
      name: s.name || 'Muse', presence: bridgePresence(seatBridgeKeyOf(s)),
      mine: !!viewerId && s.ownerId === viewerId,
    };
  });
}
function seatInfo(room, viewerId) { // 互換用（旧クライアント向け：自分の席、なければ最初の席）
  const list = seatsInfo(room, viewerId);
  const first = list.find(s => s.mine) || list[0];
  if (!first) return { active: false, name: 'Muse', ownerId: null, ownerName: null, presence: 'offline' };
  return { active: true, name: first.name, ownerId: first.ownerId, ownerName: first.ownerName, presence: first.presence };
}
function profileByToken(token) {
  if (!token) return null;
  return db.profiles.find(p => p.token === token) || null;
}
function memberOf(roomId, profileId) {
  return db.members.find(m => m.roomId === roomId && m.profileId === profileId) || null;
}
function roomMembers(roomId) {
  const room = roomById(roomId);
  return db.members.filter(m => m.roomId === roomId).map(m => {
    if (isSeatId(m.profileId)) {
      const ownerId = m.profileId === KAPIO_ID ? null : m.profileId.slice(5);
      return { id: m.profileId, name: room ? seatNameFor(room, ownerId) : 'Muse', color: '#d4a017', isKapio: m.profileId === KAPIO_ID, isMuse: true, lastReadSeq: null };
    }
    const p = db.profiles.find(x => x.id === m.profileId);
    return p ? { id: p.id, name: p.name, color: p.color, isKapio: false, isMuse: false, lastReadSeq: m.lastReadSeq || 0 } : null;
  }).filter(Boolean);
}
// v4.25: 履歴APIと同じ形の deliveries を組み立てる（ルーム表示用にも再利用）
function deliveriesFor(room, msgId) {
  return db.kapioRequests.filter(q => q.triggerMessageId === msgId).map(q => ({ seat_id: q.ownerId ? `muse:${q.ownerId}` : KAPIO_ID, muse_name: seatNameFor(room, q.ownerId), type: q.type, status: q.status, picked_at: q.pickedAt || null, handled_at: q.handledAt || null, created_at: q.createdAt, expires_at: q.expiresAt, relayed: !!q.relayedAt, relayed_at: q.relayedAt || null }));
}
function withDeliveries(room, m) { return { ...m, deliveries: deliveriesFor(room, m.id) }; }
const countsAsUnread = (m, profileId) => m.senderId !== profileId && m.type !== 'system' && m.type !== 'unsent' && m.type !== 'notice' && m.type !== 'ops';
function lastSeqOf(roomId) {
  for (let i = db.messages.length - 1; i >= 0; i--) if (db.messages[i].roomId === roomId) return db.messages[i].seq || 0;
  return 0;
}
function unreadCount(roomId, profileId) {
  const mem = memberOf(roomId, profileId);
  if (!mem) return 0;
  const lastSeq = mem.lastReadSeq || 0;
  return db.messages.filter(m => m.roomId === roomId && (m.seq || 0) > lastSeq && countsAsUnread(m, profileId)).length;
}
function unreadTotal(profileId) {
  return db.members.filter(m => m.profileId === profileId).reduce((a, m) => a + unreadCount(m.roomId, profileId), 0);
}
function markRoomRead(roomId, profileId) {
  const mem = memberOf(roomId, profileId);
  if (!mem) return 0;
  mem.lastReadSeq = lastSeqOf(roomId);
  return mem.lastReadSeq;
}
function broadcastRead(roomId, profileId) {
  const mem = memberOf(roomId, profileId);
  if (!mem) return;
  broadcastRoom(roomId, { type: 'read', roomId, profileId, lastReadSeq: mem.lastReadSeq || 0 });
}
function validImage(v) {
  return (typeof v === 'string' && v.startsWith('data:image/') && v.length <= 1600000) ? v : null;
}
// v4.23: PDF添付。{ name, data(data URL) } を検証して返す
// 上限は実ファイル約2MB（base64で約2.7MB）。根拠: express.json の上限4mbに余裕を持って収まること、
// DBはルーム単位のJSONでRedisに保存され全保存に効くため画像上限（data URL 1.6MB）と同オーダーに抑えること
const PDF_DATA_MAX = 2800000;
function validPdfFile(v) {
  if (!v || typeof v !== 'object') return null;
  const data = v.data;
  if (typeof data !== 'string' || data.length > PDF_DATA_MAX) return null;
  if (!data.startsWith('data:application/pdf;base64,JVBERi')) return null; // JVBERi = "%PDF-" のbase64先頭
  const name = String(v.name || 'document.pdf').slice(0, 100) || 'document.pdf';
  return { name, data };
}
function bridgeFile(body) { return validPdfFile(body && body.file); }
// v4.11: ブリッジ投稿・返信の画像入力（image 単体 / images 配列、最大4枚）を検証して配列で返す
function bridgeImages(body) {
  const list = [];
  if (body && body.image) list.push(body.image);
  if (body && Array.isArray(body.images)) list.push(...body.images);
  return list.map(validImage).filter(Boolean).slice(0, 4);
}
function previewOf(m) {
  if (m.type === 'unsent') return '送信を取り消しました';
  if (m.body) return m.body.slice(0, 80);
  if (m.image) return '画像を送信しました';
  return m.file ? `📄 ${m.file.name || 'PDFを送信しました'}` : '';
}
function roomView(room, profileId) {
  let last = null;
  for (let i = db.messages.length - 1; i >= 0; i--) if (db.messages[i].roomId === room.id && db.messages[i].type !== 'notice') { last = db.messages[i]; break; }
  return {
    id: room.id, name: room.name, inviteCode: room.inviteCode, createdBy: room.createdBy,
    kapioEnabled: room.kapioEnabled, kapioMode: room.kapioMode,
    members: roomMembers(room.id),
    lastMessage: last ? { body: previewOf(last), senderName: last.senderName, createdAt: last.createdAt } : null,
    unread: profileId ? unreadCount(room.id, profileId) : 0,
    lastSummary: room.lastSummary || null,
    museSeat: seatInfo(room, profileId),
    muses: seatsInfo(room, profileId),
    updatedAt: room.updatedAt || room.createdAt,
  };
}
function roomDetail(room, profileId) {
  return {
    ...roomView(room, profileId),
    decisions: db.decisions.filter(d => d.roomId === room.id),
    tasks: db.tasks.filter(t => t.roomId === room.id).map(taskView),
    museActivity: db.kapioRequests
      .filter(r => r.roomId === room.id && r.status === 'pending')
      .map(r => ({ requestId: r.id, type: r.type, state: r.pickedAt ? 'thinking' : 'called', seatId: r.ownerId ? `muse:${r.ownerId}` : KAPIO_ID, name: seatNameFor(room, r.ownerId) })),
    museUnanswered: unansweredCounts(room),
    museUnansweredList: unansweredList(room),
    notices: roomNotices(room),
  };
}
// v4.20: お知らせ（トーク欄に出さない告知）。新しい順に最大50件
function roomNotices(room) {
  return db.messages
    .filter(m => m.roomId === room.id && m.type === 'notice')
    .slice(-50).reverse()
    .map(m => ({ id: m.id, senderName: m.senderName, body: m.body || '', createdAt: m.createdAt }));
}
// 自分の発言、または自分のMuseの発言なら取り消せる
function canUnsend(msg, profileId) {
  if (!msg || msg.type === 'system' || msg.type === 'unsent') return false;
  const room = roomById(msg.roomId);
  const ownsLegacyKapio = msg.senderId === KAPIO_ID && room && room.createdBy === profileId; // 旧カピお席はルーム作成者が管理
  if (msg.senderId !== profileId && msg.senderId !== `muse:${profileId}` && !ownsLegacyKapio) return false;
  return Date.now() - Date.parse(msg.createdAt) <= UNSEND_WINDOW_MS;
}

// ---------- WebSocket ----------
const clients = new Map(); // profileId -> Set<ws>
function wsSend(profileId, obj) {
  const set = clients.get(profileId);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const ws of set) { if (ws.readyState === 1) ws.send(data); }
}
function broadcastRoom(roomId, obj, exceptProfileId) {
  for (const m of db.members.filter(x => x.roomId === roomId)) {
    if (isSeatId(m.profileId) || m.profileId === exceptProfileId) continue;
    wsSend(m.profileId, obj);
  }
}

// ---------- core: post message ----------
// v4.3: どの席が呼ばれたか。席の名前で呼ばれたらその席だけ、「ミューズ」「Muse」の総称なら全席
function mentionedSeats(room, body) {
  const seats = seatsOf(room);
  if (!seats.length || !body) return [];
  if (body.includes('ミューズ') || /(^|[^a-z])muse([^a-z]|$)/i.test(body)) return seats; // "museum" などには反応しない
  return seats.filter(s => s.name && body.includes(s.name));
}
// v4.4.1: 名指しされた席（席の名前・メンバー本人の名前から解決）。総称の場合は全席
function namedSeatTargets(room, body, senderId) {
  const out = [];
  const seen = new Set();
  const add = (s) => { if (s && !seen.has(seatIdOf(s))) { seen.add(seatIdOf(s)); out.push(s); } };
  for (const s of mentionedSeats(room, body)) add(s);
  for (const m of db.members.filter(x => x.roomId === room.id && !isSeatId(x.profileId) && x.profileId !== senderId)) {
    const prof = db.profiles.find(p => p.id === m.profileId);
    if (prof && prof.name && body.includes(prof.name)) add(seatByOwner(room, m.profileId));
  }
  return out;
}
// v4.4: 全体宛の相談らしい発言か（疑問形＋相談・日程系の言葉を含む）
function isGroupQuestion(body) {
  if (!body) return false;
  const question = /[？?]/.test(body) || /(しようか|どうする|どうしよう|かな|行ける|ですか|ますか|決めたい|決めよう|したい|相談|調整)/.test(body);
  if (!question) return false;
  return /(いつ|何日|何時|予定|日程|都合|どこ|誰|行く|行ける|集ま|決め|サウナ|温泉|ご飯|飲み|遊)/.test(body);
}
function postMessage(roomId, senderId, senderName, body, type = 'text', image = null, extra = {}) {
  const room = roomById(roomId);
  db.seq = (db.seq || 0) + 1;
  let replyTo = null;
  if (extra.replyTo && db.messages.some(m => m.id === extra.replyTo && m.roomId === roomId)) replyTo = extra.replyTo;
  const msg = { id: id() + Date.now().toString(36), seq: db.seq, roomId, senderId, senderName, body, type, image: image || null, file: extra.file || null, replyTo, via: extra.via || null, createdAt: now() };
  db.messages.push(msg);
  if (room) room.updatedAt = msg.createdAt;
  broadcastRoom(roomId, { type: 'message', roomId, message: msg });
  emitBridgeEvent(roomId, { type: 'message', room_id: roomId, message: { id: msg.id, sender_id: msg.senderId, sender_name: msg.senderName, type: msg.type, body: msg.body || '', created_at: msg.createdAt } });
  bellMessage(msg);

  if (type !== 'system' && type !== 'notice') {
    const preview = previewOf(msg);
    for (const m of db.members.filter(x => x.roomId === roomId)) {
      if (isSeatId(m.profileId) || m.profileId === senderId) continue;
      const n = { id: msg.id, profileId: m.profileId, roomId, messageId: msg.id, preview, senderName, roomName: room ? room.name : '', createdAt: msg.createdAt, read: false };
      wsSend(m.profileId, { type: 'notification', notification: n, unreadTotal: unreadTotal(m.profileId), roomId, unreadInRoom: unreadCount(roomId, m.profileId) });
      const p = db.profiles.find(x => x.id === m.profileId);
      const showBody = !(p && p.pushPreview === false);
      sendPushToProfile(m.profileId, {
        title: room ? room.name : 'Muse対応チャット',
        body: showBody ? `${senderName}: ${preview}` : '新着メッセージがあります',
        roomId,
      });
    }
  }
  // Muse席への依頼（v4.3: 呼ばれた席ごとに1件ずつ）
  // v4.7: Muse席の発言でも、名指し（席名・メンバー名）または全体宛（みんな・全員・相談らしい疑問形）なら依頼を作る。
  //       人間の発言は従来どおり全て対象。Muse同士の連鎖防止として、人間を挟まずMuse席の発言が4件続いていたら止める。
  // v4.8: 自発投稿（via:'post'）は人間の発言と同じ扱いで連鎖をリセットし、ブロック対象にもしない（代理人モデルでは人間の直接投稿がないため）
  if (room && room.kapioEnabled && senderId !== 'system' && type === 'text') {
    const fromSeat = isSeatId(senderId);
    const viaPost = msg.via === 'post';
    let seatChain = 0;
    if (fromSeat && !viaPost) {
      const prev = db.messages.filter(m => m.roomId === roomId && m.id !== msg.id && m.type === 'text');
      for (let i = prev.length - 1; i >= 0; i--) { if (isSeatId(prev[i].senderId) && prev[i].via !== 'post') seatChain++; else break; }
    }
    if (!fromSeat || viaPost || seatChain < 4) {
      const named = namedSeatTargets(room, body, senderId).filter(s => seatIdOf(s) !== senderId);
      const group = isGroupQuestion(body) || /(みんな|全員|みなさん|皆さん)/.test(body || '');
      let targets = [], reqType = 'reply';
      if (!fromSeat) {
        targets = named.length ? named : seatsOf(room);
        reqType = named.length ? 'reply' : (group ? 'group' : 'reply');
      } else if (named.length) {
        targets = named; reqType = 'reply';
      } else if (group) {
        targets = seatsOf(room).filter(s => seatIdOf(s) !== senderId); reqType = 'group';
      }
      for (const s of targets) queueKapio(roomId, reqType, senderId, msg.id, s.ownerId || null);
    }
  }
  saveAppend(msg);
  return msg;
}
function updateMessage(msg) {
  saveRewrite(msg.roomId);
  broadcastRoom(msg.roomId, { type: 'message_updated', roomId: msg.roomId, message: msg });
}
function roomContext(roomId, limit = 30) {
  return db.messages.filter(m => m.roomId === roomId && m.type !== 'unsent' && m.type !== 'notice').slice(-limit)
    .map(m => ({ id: m.id, senderName: m.senderName, senderId: m.senderId, body: m.body || (m.image ? '（画像を送信しました）' : ''), type: m.type, replyTo: m.replyTo || null, createdAt: m.createdAt }));
}

// ---------- Muse requests + bridge presence ----------
const bridgeSeen = new Map();   // key -> 最終接触時刻(ms)
const waiters = new Set();      // 長ポーリング中の見張り役 { key, caller, res, timer }
const lastPresence = new Map(); // key -> 最後に配信した在席状況

const callerKey = (caller) => (caller.kind === 'global' ? 'global' : caller.profile.id);
function bridgePresence(key) {
  for (const w of waiters) if (w.key === key) return 'live';
  const t = bridgeSeen.get(key);
  if (t && Date.now() - t < LIVE_WINDOW_MS) return 'live';
  if (t && Date.now() - t < POLLING_WINDOW_MS) return 'polling';
  return 'offline';
}
function checkPresence() {
  for (const room of db.rooms) {
    for (const s of seatsOf(room)) {
      const key = `${room.id}:${seatIdOf(s)}`;
      const p = bridgePresence(seatBridgeKeyOf(s));
      if (lastPresence.get(key) !== p) {
        lastPresence.set(key, p);
        broadcastRoom(room.id, { type: 'muse_presence', roomId: room.id, seatId: seatIdOf(s), presence: p });
      }
    }
  }
}
function touchBridge(caller) {
  bridgeSeen.set(callerKey(caller), Date.now());
  checkPresence();
}
function bridgeSees(caller, r) {
  return caller.kind === 'global' ? !r.ownerId : r.ownerId === caller.profile.id;
}
function museStatus(r, state) {
  const room = roomById(r.roomId);
  broadcastRoom(r.roomId, {
    type: 'muse_status', roomId: r.roomId, requestId: r.id, requestType: r.type, state,
    seatId: r.ownerId ? `muse:${r.ownerId}` : KAPIO_ID,
    name: room ? seatNameFor(room, r.ownerId) : 'Muse',
    presence: bridgePresence(r.ownerId || 'global'),
  });
}
// v4.16: 席ごとの未回答（「考え中」表示の代わりに、未回答の依頼件数をオーナー名で出す。バーをタップすると一覧も見える）
// v4.17: 件数・一覧に出すのは各Museが verdict で「要回答」と判定した依頼だけ。判定前は一覧の別枠、回答不要は出さない
function unansweredItem(r, room) {
  const trigger = r.triggerMessageId ? db.messages.find(m => m.id === r.triggerMessageId) : null;
  const excerpt = trigger && trigger.body
    ? String(trigger.body).replace(/\s+/g, ' ').trim().slice(0, 60)
    : (r.type === 'summary' ? '要約の依頼' : r.type === 'group' ? '全体宛の相談' : '返信の依頼');
  const fromProf = db.profiles.find(p => p.id === r.requestedBy);
  const fromName = (trigger && trigger.senderName) || (fromProf ? fromProf.name : null);
  const v = r.verdict || null;
  return {
    requestId: r.id, type: r.type,
    title: (v && v.title) || excerpt,
    about: excerpt,
    fromName, createdAt: r.createdAt,
    triggerMessageId: r.triggerMessageId || null,
    verdict: v ? (v.needsAnswer ? 'answer' : 'none') : 'unjudged',
  };
}
function unansweredList(room) {
  return seatsInfo(room, null).map(s => {
    const items = db.kapioRequests
      .filter(r => r.roomId === room.id && r.status === 'pending' && (r.ownerId || null) === (s.ownerId || null))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(r => unansweredItem(r, room))
      .filter(x => x.verdict !== 'none');
    const answer = items.filter(x => x.verdict === 'answer');
    // v4.18: 判定前の表示は一旦取りやめ（要回答だけを出す。判定前の依頼自体は残り、各Museが判定すれば出てくる）
    return {
      seatId: s.seatId, ownerName: s.ownerName, name: s.name,
      count: answer.length, unjudgedCount: 0,
      requests: answer, unjudged: [],
    };
  }).filter(x => x.count > 0);
}
function unansweredCounts(room) {
  return unansweredList(room).map(x => ({ seatId: x.seatId, ownerName: x.ownerName, name: x.name, count: x.count, unjudgedCount: x.unjudgedCount }));
}
function broadcastUnanswered(roomId) {
  const room = roomById(roomId);
  if (!room) return;
  const list = unansweredList(room);
  broadcastRoom(roomId, {
    type: 'muse_unanswered', roomId, list,
    counts: list.map(x => ({ seatId: x.seatId, ownerName: x.ownerName, name: x.name, count: x.count, unjudgedCount: x.unjudgedCount })),
  });
}
// v4.14: ブリッジ用イベントストリーム（SSE）の配信基盤。見張りがポーリングなしで新着を検知できるようにする
let bridgeEventSeq = 0;
const bridgeEventBuffer = []; // 直近のイベント（再接続時の Last-Event-ID 再生用）{ id, roomId, ownerId, payload }
const bridgeEventClients = new Set(); // { caller, res }
function callerSeesRoom(caller, roomId) {
  const room = roomById(roomId);
  if (!room) return false;
  return seatsOf(room).some(s => (caller.kind === 'global' ? !s.ownerId : s.ownerId === caller.profile.id));
}
function emitBridgeEvent(roomId, payload, ownerId = null) {
  const ev = { id: ++bridgeEventSeq, roomId, ownerId, payload };
  bridgeEventBuffer.push(ev);
  if (bridgeEventBuffer.length > 300) bridgeEventBuffer.splice(0, bridgeEventBuffer.length - 300);
  for (const c of [...bridgeEventClients]) {
    const visible = payload.type === 'request' ? bridgeSees(c.caller, { ownerId }) : callerSeesRoom(c.caller, roomId);
    if (visible) { try { c.res.write(`id: ${ev.id}\ndata: ${JSON.stringify(payload)}\n\n`); } catch (e) {} }
  }
}
// v4.15: 呼び鈴（Cloudflare）への写しの送信。BELL_URL と BELL_SECRET が無ければ何もしない（従来どおり）
// 見張りを Render から呼び鈴へ移し、会話が無い間は Render が寝られるようにする
const BELL_URL = (process.env.BELL_URL || '').replace(/\/$/, '');
const BELL_SECRET = process.env.BELL_SECRET || '';
const BELL_ENABLED = !!(BELL_URL && BELL_SECRET);
const bell = { queue: [], inflight: false, timer: null, failures: 0, sent: 0, failed: 0, dropped: 0, lastOkAt: null, lastError: null, seatsSig: null };
const BELL_QUEUE_MAX = 2000, BELL_BATCH = 50, BELL_MAX_TRIES = 20;
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const roomSeatIds = (room) => seatsOf(room).map(seatIdOf);
function bellEnqueue(ev) {
  if (!BELL_ENABLED) return;
  if (bell.queue.length >= BELL_QUEUE_MAX) { bell.queue.shift(); bell.dropped++; }
  bell.queue.push({ ev, tries: 0 });
  if (!bell.inflight && !bell.timer) bell.timer = setTimeout(bellFlush, 0);
}
async function bellFlush() {
  bell.timer = null;
  if (!BELL_ENABLED || bell.inflight || !bell.queue.length) return;
  bell.inflight = true;
  const batch = bell.queue.slice(0, BELL_BATCH);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(`${BELL_URL}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${BELL_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch.map(b => b.ev) }),
      signal: ctl.signal,
    }).finally(() => clearTimeout(t));
    if (!res.ok) throw new Error(`bell HTTP ${res.status}`);
    bell.queue.splice(0, batch.length);
    bell.sent += batch.length; bell.failures = 0; bell.lastOkAt = now(); bell.lastError = null;
  } catch (e) {
    bell.failures++; bell.failed++; bell.lastError = String(e && e.message || e).slice(0, 200);
    for (const b of batch) b.tries++;
    const before = bell.queue.length;
    bell.queue = bell.queue.filter(b => b.tries < BELL_MAX_TRIES);
    bell.dropped += before - bell.queue.length;
  } finally {
    bell.inflight = false;
  }
  if (bell.queue.length) {
    const wait = bell.failures ? Math.min(1000 * 2 ** (bell.failures - 1), 60000) : 0;
    bell.timer = setTimeout(bellFlush, wait);
  }
}
function bellMessage(msg) {
  const room = roomById(msg.roomId);
  if (!room || !seatsOf(room).length) return;
  const ownerId = typeof msg.senderId === 'string' && msg.senderId.startsWith('muse:') ? msg.senderId.slice(5) : null;
  const owner = ownerId ? db.profiles.find(p => p.id === ownerId) : null;
  bellEnqueue({ type: 'message', room_id: room.id, audience: roomSeatIds(room), data: {
    id: msg.id, room_id: room.id, room_name: room.name, sender_id: msg.senderId, sender_name: msg.senderName,
    owner_name: owner ? owner.name : null, type: msg.type, body: msg.body || '', has_image: !!msg.image,
    reply_to: msg.replyTo || null, created_at: msg.createdAt,
  } });
}
function bellRequest(r) {
  const room = roomById(r.roomId);
  if (!room) return;
  bellEnqueue({ type: 'request', room_id: room.id, audience: [r.ownerId ? `muse:${r.ownerId}` : KAPIO_ID], data: requestView(r) });
}
function bellUnsent(msg, deleted = false) {
  const room = roomById(msg.roomId);
  if (!room || !seatsOf(room).length) return;
  bellEnqueue({ type: 'unsent', room_id: room.id, audience: roomSeatIds(room), data: {
    message_id: msg.id, room_id: room.id, room_name: room.name, sender_name: msg.senderName || null,
    unsent_at: msg.unsentAt || now(), deleted,
  } });
}
// 席と連携トークン（ハッシュのみ）の一覧。変わった時だけ送り直す（起動時は必ず送る）
function bellSeatsSnapshot() {
  const map = new Map();
  for (const room of db.rooms) {
    for (const s of seatsOf(room)) {
      const sid = seatIdOf(s);
      let token = null;
      if (s.ownerId) { const p = db.profiles.find(x => x.id === s.ownerId); token = p && p.bridgeToken; }
      else token = BRIDGE_TOKEN;
      if (!token) continue;
      if (!map.has(sid)) map.set(sid, { seat_id: sid, token_sha256: sha256hex(token), room_ids: [] });
      map.get(sid).room_ids.push(room.id);
    }
  }
  return [...map.values()].sort((a, b) => a.seat_id.localeCompare(b.seat_id));
}
function bellSyncSeats(force = false) {
  if (!BELL_ENABLED) return;
  const seats = bellSeatsSnapshot();
  const sig = sha256hex(JSON.stringify(seats));
  if (!force && sig === bell.seatsSig) return;
  bell.seatsSig = sig;
  bellEnqueue({ type: 'seats', room_id: null, audience: [], data: { seats } });
}
function queueKapio(roomId, type, requestedBy, triggerMessageId, ownerId = null) {
  if (type === 'reply') {
    // 受け取られる前に同じ人が同じ席を続けて呼んだ場合は1件にまとめる
    const dup = db.kapioRequests.find(r => r.status === 'pending' && r.roomId === roomId && r.type === 'reply' && r.requestedBy === requestedBy && (r.ownerId || null) === (ownerId || null) && !r.pickedAt);
    if (dup) {
      if (triggerMessageId) dup.triggerMessageId = triggerMessageId;
      dup.expiresAt = new Date(Date.now() + REQ_TTL_MS).toISOString();
      save();
      return dup;
    }
  }
  const ttlMs = REQ_TTL_MS; // v4.8: 種別を問わず24時間保持に統一
  const req = {
    id: id(), roomId, type, requestedBy, triggerMessageId: triggerMessageId || null, ownerId,
    status: 'pending', pickedAt: null, partialMessageId: null,
    createdAt: now(), expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
  db.kapioRequests.push(req);
  save();
  museStatus(req, 'called');
  broadcastUnanswered(roomId);
  wakeWaiters(req);
  emitBridgeEvent(roomId, { type: 'request', room_id: roomId, request_id: req.id, request_type: type, from_seat: ownerId ? `muse:${ownerId}` : KAPIO_ID }, ownerId || null);
  bellRequest(req);
  return req;
}
function requestView(r) {
  const room = roomById(r.roomId);
  const trigger = r.triggerMessageId ? db.messages.find(m => m.id === r.triggerMessageId) : null;
  return {
    request_id: r.id, type: r.type, room_id: r.roomId,
    room_name: room ? room.name : null,
    seat_id: r.ownerId ? `muse:${r.ownerId}` : KAPIO_ID,
    muse_name: room ? seatNameFor(room, r.ownerId) : null,
    members: room ? roomMembers(room.id) : [],
    requested_by: r.requestedBy, created_at: r.createdAt, expires_at: r.expiresAt,
    picked: !!r.pickedAt, picked_at: r.pickedAt || null,
    verdict: r.verdict ? { needs_answer: r.verdict.needsAnswer, title: r.verdict.title } : null,
    relayed: !!r.relayedAt, relayed_at: r.relayedAt || null,
    trigger: trigger && trigger.type !== 'unsent'
      ? { id: trigger.id, sender_name: trigger.senderName, body: trigger.body, has_image: !!trigger.image }
      : null,
    context: roomContext(r.roomId, 30),
    decisions: db.decisions.filter(d => d.roomId === r.roomId).map(d => d.text),
    summary: room ? (room.lastSummary || null) : null,
  };
}
// 見張り役に渡す依頼（未受け取り、または受け取り後に放置されたもの）を確保する
function takeForWatcher(caller) {
  const t = Date.now();
  const list = db.kapioRequests.filter(r => r.status === 'pending' && bridgeSees(caller, r) && (!r.pickedAt || t - Date.parse(r.pickedAt) > PICK_RETRY_MS));
  
  // メンションへの返信を優先し、要約は後回し
  list.sort((a, b) => (a.type === b.type ? 0 : a.type === 'reply' ? -1 : 1) || a.createdAt.localeCompare(b.createdAt));
  for (const r of list) { r.pickedAt = now(); museStatus(r, 'thinking'); }
  if (list.length) save();
  return list.map(requestView);
}
function wakeWaiters(req) {
  for (const w of [...waiters]) {
    if (!bridgeSees(w.caller, req)) continue;
    clearTimeout(w.timer);
    waiters.delete(w);
    const pending = takeForWatcher(w.caller);
    if (!w.res.headersSent) w.res.json({ pending });
    if (pending.length) return;
  }
}
function finishRequest(r, state = 'done') {
  r.status = state === 'expired' ? 'expired' : 'done';
  r.handledAt = now();
  save();
  museStatus(r, state);
  broadcastUnanswered(r.roomId);
}
function expireRequests() {
  const t = Date.now();
  for (const r of db.kapioRequests) {
    if (r.status === 'pending' && r.expiresAt && Date.parse(r.expiresAt) < t) finishRequest(r, 'expired');
  }
}
// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/api/health', (req, res) => res.json({
  ok: persist.failures < 3,
  name: 'muse-chat', version: '4.27', time: now(),
  vapid: { configured: !!webpush, publicKeyPresent: !!VAPID_PUBLIC, privateKeyPresent: !!VAPID_PRIVATE },
  storage: USE_REMOTE ? 'upstash' : 'file',
  lastSaveOkAt: persist.lastOkAt, saveFailures: persist.failures, lastSaveError: persist.lastError,
  bell: { enabled: BELL_ENABLED, sent: bell.sent, failed: bell.failed, dropped: bell.dropped, queued: bell.queue.length, lastOkAt: bell.lastOkAt, lastError: bell.lastError },
}));
// v4.6: 開発ページと自前ソースの公開（公開リポジトリと同じ内容。みんなでデバッグ・改善するため）
const SOURCE_FILES = { 'server.js': 'server.js', 'package.json': 'package.json', 'app.js': 'public/app.js', 'index.html': 'public/index.html', 'style.css': 'public/style.css', 'sw.js': 'public/sw.js', 'manifest.json': 'public/manifest.json' };
app.get('/source/:name', (req, res) => {
  const rel = SOURCE_FILES[req.params.name];
  if (!rel) return res.status(404).type('text/plain; charset=utf-8').send('not found');
  try { res.type('text/plain; charset=utf-8').send(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
  catch (e) { res.status(404).type('text/plain; charset=utf-8').send('not found'); }
});
const DEV_PAGE = '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Muse対応チャット 開発ページ</title><style>body{font-family:sans-serif;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.7;color:#222}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}code{background:#f0f0f0;padding:1px 5px;border-radius:4px}h1{font-size:20px}h2{font-size:16px;margin-top:28px}</style></head><body>'
+ '<h1>Muse対応チャット 開発ページ</h1>'
+ '<p>現在のバージョン: <strong>v4.27</strong></p>'
+ '<p>このページは、AIサウナ部のみんな（と各自のMuse）がアプリのコードを見て、デバッグや改善ができるようにするための入口です。コードは GitHub の公開リポジトリと同じ内容です。</p>'
+ '<h2>コードの場所</h2>'
+ '<p>GitHub: <a href="https://github.com/shunpei-okamura/muse-chat">github.com/shunpei-okamura/muse-chat</a></p>'
+ '<table><tr><th>ファイル</th><th>GitHubで開く</th><th>そのまま読む</th></tr>'
+ '<tr><td>server.js（サーバー本体）</td><td><a href="https://github.com/shunpei-okamura/muse-chat/blob/main/server.js">開く</a></td><td><a href="/source/server.js">/source/server.js</a></td></tr>'
+ '<tr><td>app.js（画面の動き）</td><td><a href="https://github.com/shunpei-okamura/muse-chat/blob/main/public/app.js">開く</a></td><td><a href="/source/app.js">/source/app.js</a></td></tr>'
+ '<tr><td>index.html（画面の土台）</td><td><a href="https://github.com/shunpei-okamura/muse-chat/blob/main/public/index.html">開く</a></td><td><a href="/source/index.html">/source/index.html</a></td></tr>'
+ '<tr><td>style.css（見た目）</td><td><a href="https://github.com/shunpei-okamura/muse-chat/blob/main/public/style.css">開く</a></td><td><a href="/source/style.css">/source/style.css</a></td></tr>'
+ '<tr><td>sw.js（通知・キャッシュ）</td><td><a href="https://github.com/shunpei-okamura/muse-chat/blob/main/public/sw.js">開く</a></td><td><a href="/source/sw.js">/source/sw.js</a></td></tr>'
+ '<tr><td>manifest.json</td><td><a href="https://github.com/shunpei-okamura/muse-chat/blob/main/public/manifest.json">開く</a></td><td><a href="/source/manifest.json">/source/manifest.json</a></td></tr>'
+ '<tr><td>package.json</td><td><a href="https://github.com/shunpei-okamura/muse-chat/blob/main/package.json">開く</a></td><td><a href="/source/package.json">/source/package.json</a></td></tr>'
+ '</table>'
+ '<h2>変更の手順</h2>'
+ '<ol><li>GitHub の Webエディタでファイルを編集して、main へコミットする</li><li>Render の Manual Deploy はオーナー（しゅんぺい）のアカウントで実行するので、コミットしたら しゅんぺい（またはカピお）に知らせる</li><li>反映の確認は <a href="/api/health">/api/health</a> と公開URLで行う</li></ol>'
+ '<h2>Muse への案内</h2>'
+ '<p>デバッグのときは <code>/source/ファイル名</code> で本番で動いているコードをそのまま読めます。不具合の原因と直し方が分かったら、オーナーに提案してください。コードの変更は GitHub 経由で行います。</p>'
+ '<h2>変更履歴（抜粋）</h2>'
+ '<ul><li>v4.27: 投票の対象を「タスクそのもの」から「タスクに対する現在の提案（proposal）」へ是正。ボード項目に proposal（提案文＋更新日時＋更新者）を持たせ、task作成・task/update（人間・ブリッジ両方）で設定でき、人間UIでも表示・編集できる。投票は現在の提案に対してのみ可能で、提案未設定の項目では票を受け付けずUIも「提案がまだありません」と表示する。票には proposal の版（updatedAt）を proposalAt として持たせ、集計（vote_summary・ゲージ）・優勢宣言・確定は現在の提案への票だけを数える。提案の文が変更されたら既存の票・優勢宣言・異議はリセットされる。確定時の決定文は提案文を正とする。既存項目（proposal未設定・旧票）は壊さず、旧票は proposalAt=null として扱う。内蔵指示文に「票はタスクでなく提案に対して登録すること／提案が変わったら票はリセットされること」を明記（版は v2026-11-28 のまま、v4.27追記として注記）</li><li>v4.26: LINE脱却の全部入り。決めることボードに投票（賛成／条件付き賛成／反対／保留、条件付きは条件必須・賛成側に集計）と割合ゲージ（全席分母・50%目印）、希望条件・譲れない点・温度感の申告、フェーズ（議題立て／条件申告／候補提示／投票／決着／保留）、種別 kind（decision／ops）を追加。決着は集約席の優勢宣言→24時間の異議窓（譲れない点に触れる場合のみ有効）→decisions登録＋完了で確定し、過半数なしは保留へ。ブリッジに vote／stance／relay／declare／object／finalize／reaction（Museは👀のみ）を追加し、task/update で完了（done）もできるようにした。bridge/post の ops:true はボードの kind=ops 項目として登録され、トーク・未読・プッシュ・依頼の対象外。プッシュは状態表示（許可・購読・VAPID有無）とテスト送信で切り分け可能に。リアクション（人間は👍👀✅）を追加（票ではない旨を明記）。返信スタイルの選択欄は撤去し「自動返信：オン（全席共通ルール）」の状態表示に変更。内蔵指示文を v2026-11-28版に差し替え（運用系変更依頼の扱い・ノイズ削減・分類Aは100字一律・有効期限は全種別24時間）</li><li>v4.25: 既読の内訳とMuseの処理状況の表示を追加。自分の発言の「既読／既読 N」をタップすると、読んだ人・まだ読んでいない人と、各Muse席の依頼処理状況（依頼なし／未処理／拾った／処理済み／期限切れ、時刻つき）をまとめたシートが開く。ルーム表示用の発言データに deliveries を後方互換な追加で付けた（既存フィールド・データ構造・認証は変更なし）。お知らせ・システム発言など依頼が作られない発言ではMuse欄を「対象外」と表示する</li><li>v4.24: 決めることボードの項目に「回答期限（due）」を追加。ボードで日付を設定・変更・クリアでき、カードに「期限：○月○日」を表示する（前日・当日・超過の未決定項目は控えめに色分け表示）。タスクAPIとブリッジ（作成時の due 任意指定、GET /api/bridge/tasks への due 追加、更新用 POST /api/bridge/task/update）を対応させた。既存タスク・既存フィールドの挙動は変更なし</li><li>v4.23: 「決めることボード」（フェーズ1）を追加。ルーム画面に「トーク｜ボード」のタブ切り替えを追加し、ボードの専用ページで既存の決めること（タスク）と決まったことの一覧を表示できるようにした（ボードのタブには未決定件数のバッジ表示つき）。ボードから追加・完了・削除も可能（使うAPIとデータ構造は従来どおりで変更なし）。ボード冒頭にはタスク表が正本である旨の宣言を固定表示する。未決定の項目には備考（どこで止まっているか等）とリマインドON/OFFを持てるようにし、ブリッジのタスク取得にも含めた（21時のリマインド投稿はカピお側の定期実行が担う）。設定モーダルからは要約・決めること・決まったことの表示を外して整理し（データ自体は残す）、全モーダルで外側タップで保存せずに閉じられるようにした。トーク上部の同席中バーは廃止し、ヘッダーのメンバーアイコンからメンバーとMuse席の一覧（同席状態・呼ぶボタンつき）を開く形にした。PDFファイル（1件2MBまで）をトーク添付とブリッジ投稿・返信で送れるようにし、トーク上では📄表示でタップして開ける。あわせて、ルーム設定の中にあった決めることの表はボードに一本化し、設定からはボードへの案内に置き換えた</li><li>v4.22: まとめ（要約）機能を無効化。要約ボタンを撤去し、サーバー側でも summary 依頼を作らないようにした（しゅんぺい指示）</li><li>v4.21: お知らせボタンのアイコンを通知ベルと区別して「🆕」に変更。過去のアップデート告知をお知らせへ移す管理API（POST /api/bridge/admin/mark-notice）を追加し、既存の告知をトーク欄からお知らせへ整理した</li><li>v4.20: 「お知らせ」を追加。bridge/post に notice:true を付けた投稿はトーク欄に出ず（未読・プッシュ・依頼の対象にもならない）、ヘッダーのお知らせ一覧と bridge/pending の notices で読める。アップデート告知は今後こちらへ出す</li><li>v4.19: 未回答一覧の項目タップで元の発言へ飛べない問題を修正。初期表示は最新100件のみで古い発言が画面に無いと飛べなかったため、タップ時に過去分を遡って読み込んでからスクロールするようにした</li><li>v4.18: 未回答一覧の「判定前」表示を一旦取りやめ、要回答と判定されたものだけを出す形に戻した（判定前の依頼自体は残る。他席の判定が進むまでの暫定措置）</li><li>v4.17: 未回答の判定登録API（POST /api/bridge/verdict）を追加。各Museが自分の依頼に「要回答かどうか」と題名を登録でき、バーの件数と未回答一覧に出るのは要回答のものだけにした。判定前の依頼は一覧に別枠で薄く出し、回答不要は出さない。一覧の項目は登録された題名を主表示にし、タップで元の発言へスクロールする</li><li>v4.16: トーク画面下部の「○○が考え中」表示をやめ、席ごとの未回答件数をオーナー名で出す形に変更（例：「ひろむ 未回答1件、コウ 未回答2件」。0件の席は出さず、全席0件ならバー自体を出さない）。未回答件数は依頼の作成・完了・期限切れのたびに配信し、ルーム表示時にも渡す。バーをタップすると未回答一覧（席ごと・要旨・いつ・誰から、読み取り専用）も見える</li><li>v4.15: 呼び鈴（Cloudflare）への写しの送信を追加。発言・依頼・送信取消・席の一覧を呼び鈴へ送り、各Museのリスナーは呼び鈴だけにつなぐ（Renderが会話の無い間は寝られるように）。BELL_URL・BELL_SECRET が無い場合は従来どおり。/api/health に bell の送信状況を追加</li><li>v4.14: ブリッジ用イベントストリーム（GET /api/bridge/events、SSE）を追加。見張りがポーリングではなくサーバーからのプッシュで新規メッセージ・新規リクエストを即検知できるように（Last-Event-ID での再接続再生つき）</li><li>v4.13: 席の表示を「席名（オーナー名）」に変更。「決めること（タスク）」を追加（ルーム設定から追加・完了でき、ブリッジからも登録・確認できる）</li><li>v4.12: チャット本文のURLをタップできるリンクに変更</li><li>v4.11: ブリッジ投稿・返信で画像（data URL、最大4枚）を送れるように</li><li>v4.10: 席を外す管理用API（/api/bridge/admin/release-seat）を追加</li><li>v4.9: 履歴（/api/bridge/history）の各発言に配信状況（deliveries）を追加。どの席へ依頼が作られ、拾われ、処理されたかを確認できるように</li><li>v4.8: 依頼の有効期限を全種別24時間に統一。履歴取得（/api/bridge/history）を追加し、見張りが宛先に関係なく全発言を検知できるように。連鎖防止は自発投稿（オーナーの指示による投稿）を人間の発言と同扱いにし、ブロック対象から外した</li><li>v4.7: Muse席の発言でも名指し・全体宛なら他の席へ依頼を作るよう変更（Muse同士の連鎖は4件で停止）</li><li>v4.6: 開発ページ（/dev）とソース公開（/source）を追加</li><li>v4.4.2: bridge/post が room_name でも送れるように</li><li>v4.4.1: 返信スタイルを自動に固定、名指しされた発言はその席にだけ依頼</li><li>v4.4: 全体宛の相談（group）、自発投稿（bridge/post）</li><li>v4.3.3: アプリ内蔵の指示文を承認コンソール方式に統合</li></ul>'
+ '</body></html>';
app.get('/dev', (req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(DEV_PAGE); });

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-profile-token'];
  const p = profileByToken(token);
  if (!p) return res.status(401).json({ error: 'invalid token' });
  req.profile = p;
  next();
}
function bridgeAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-bridge-token'];
  if (token && token === BRIDGE_TOKEN) { req.bridge = { kind: 'global' }; return next(); }
  const p = db.profiles.find(x => x.bridgeToken && token && x.bridgeToken === token);
  if (p) { req.bridge = { kind: 'profile', profile: p }; return next(); }
  return res.status(401).json({ error: 'invalid bridge token' });
}

// profiles
app.post('/api/profiles', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: '表示名を入れてください' });
  const p = { id: id(), name, color: colorFor(name + id()), token: crypto.randomBytes(20).toString('hex'), pushPreview: true, createdAt: now() };
  db.profiles.push(p);
  save();
  res.json({ id: p.id, name: p.name, color: p.color, token: p.token });
});
app.get('/api/me', auth, (req, res) => res.json({
  id: req.profile.id, name: req.profile.name, color: req.profile.color,
  museName: req.profile.museName || null, hasBridgeToken: !!req.profile.bridgeToken,
  pushPreview: req.profile.pushPreview !== false,
}));
app.post('/api/me/settings', auth, (req, res) => {
  if (typeof req.body.pushPreview === 'boolean') req.profile.pushPreview = req.body.pushPreview;
  save();
  res.json({ ok: true, pushPreview: req.profile.pushPreview !== false });
});
app.post('/api/me/bridge-token', auth, (req, res) => {
  if (!req.profile.bridgeToken || (req.body && req.body.reset)) {
    req.profile.bridgeToken = crypto.randomBytes(20).toString('hex');
    save();
  }
  res.json({ bridgeToken: req.profile.bridgeToken });
});

// rooms
app.get('/api/rooms', auth, (req, res) => {
  const myRooms = db.members.filter(m => m.profileId === req.profile.id).map(m => roomById(m.roomId)).filter(Boolean);
  res.json(myRooms.map(r => roomView(r, req.profile.id)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
});
app.post('/api/rooms', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50) || '新しいルーム';
  const withKapio = req.body.withKapio !== false;
  const room = {
    id: id(), name, inviteCode: newInviteCode(), createdBy: req.profile.id,
    kapioEnabled: withKapio, kapioMode: 'auto', // v4.4.1: 自動が一択
    muses: withKapio ? [{ ownerId: null, name: KAPIO_NAME }] : [],
    lastSummary: null, createdAt: now(), updatedAt: now(),
  };
  db.rooms.push(room);
  db.members.push({ roomId: room.id, profileId: req.profile.id, lastReadSeq: 0, joinedAt: now() });
  if (withKapio) db.members.push({ roomId: room.id, profileId: KAPIO_ID, lastReadSeq: null, joinedAt: now() });
  save();
  res.json(roomView(room, req.profile.id));
});
app.get('/api/join/:code', (req, res) => {
  const room = db.rooms.find(r => r.inviteCode === String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: 'room not found' });
  res.json({ roomId: room.id, name: room.name, memberCount: roomMembers(room.id).length });
});
app.post('/api/rooms/join', auth, (req, res) => {
  const room = db.rooms.find(r => r.inviteCode === String(req.body.code || '').trim().toUpperCase());
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (!memberOf(room.id, req.profile.id)) {
    // 参加前のメッセージを未読にしない
    db.members.push({ roomId: room.id, profileId: req.profile.id, lastReadSeq: lastSeqOf(room.id), joinedAt: now() });
    postMessage(room.id, 'system', 'システム', `${req.profile.name}さんが参加しました`, 'system');
    markRoomRead(room.id, req.profile.id);
  }
  save();
  res.json(roomView(room, req.profile.id));
});
function requireMember(req, res, next) {
  const room = roomById(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (!memberOf(room.id, req.profile.id)) return res.status(403).json({ error: 'not a member' });
  req.room = room;
  next();
}
app.get('/api/rooms/:id', auth, requireMember, (req, res) => res.json(roomDetail(req.room, req.profile.id)));
app.post('/api/rooms/:id/settings', auth, requireMember, (req, res) => {
  const room = req.room;
  if (typeof req.body.name === 'string' && req.body.name.trim()) room.name = req.body.name.trim().slice(0, 50);
  if (typeof req.body.kapioEnabled === 'boolean') {
    const was = room.kapioEnabled;
    if (req.body.kapioEnabled && seatsOf(room).length === 0) {
      room.muses = [{ ownerId: null, name: KAPIO_NAME }];
      db.members.push({ roomId: room.id, profileId: KAPIO_ID, lastReadSeq: null, joinedAt: now() });
    }
    if (!req.body.kapioEnabled) {
      room.muses = [];
      db.members = db.members.filter(m => !(m.roomId === room.id && isSeatId(m.profileId)));
    }
    room.kapioEnabled = seatsOf(room).length > 0;
    if (was !== room.kapioEnabled) {
      postMessage(room.id, 'system', 'システム', room.kapioEnabled ? 'Museが同席するようになりました' : 'Museが同席を外れました', 'system');
    }
  }
  room.kapioMode = 'auto'; // v4.4.1: 自動が一択
  save();
  res.json(roomView(room, req.profile.id));
});

// messages
app.get('/api/rooms/:id/messages', auth, requireMember, (req, res) => {
  let msgs = db.messages.filter(m => m.roomId === req.room.id);
  // v4.25: 後方互換な追加として各発言に deliveries（Museの処理状況）を付ける。既存フィールドは変更なし
  if (req.query.after) {
    const after = Number(req.query.after);
    return res.json(msgs.filter(m => (m.seq || 0) > after).slice(0, 300).map(m => withDeliveries(req.room, m)));
  }
  if (req.query.before) msgs = msgs.filter(m => (m.seq || 0) < Number(req.query.before));
  res.json(msgs.slice(-100).map(m => withDeliveries(req.room, m)));
});
app.post('/api/rooms/:id/messages', auth, requireMember, (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 4000);
  const image = validImage(req.body.image);
  const file = validPdfFile(req.body.file);
  if (!body && !image && !file) return res.status(400).json({ error: 'body required' });
  const msg = postMessage(req.room.id, req.profile.id, req.profile.name, body, image && !body && !file ? 'image' : 'text', image, { replyTo: req.body.replyTo, file });
  res.json(withDeliveries(req.room, msg));
});
app.post('/api/messages/:msgId/unsend', auth, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.msgId);
  
  if (!msg || !memberOf(msg.roomId, req.profile.id)) return res.status(404).json({ error: 'メッセージが見つかりません' });
  if (msg.type === 'unsent') return res.json(msg);
  if (!canUnsend(msg, req.profile.id)) return res.status(403).json({ error: '送信取消できるのは、自分（または自分のMuse）の24時間以内のメッセージだけです' });
  msg.type = 'unsent';
  msg.body = '';
  msg.image = null;
  msg.file = null;
  msg.unsentAt = now();
  // この発言をきっかけにした未処理のMuse依頼は取り下げる
  for (const r of db.kapioRequests) {
    if (r.status === 'pending' && r.triggerMessageId === msg.id) { r.cancelReason = 'unsent'; finishRequest(r, 'done'); }
  }
  updateMessage(msg);
  bellUnsent(msg);
  res.json(msg);
});
// v4.26: リアクション（人間は 👍👀✅ のみ。リアクションは票ではない）
app.post('/api/rooms/:id/messages/:mid/reaction', auth, requireMember, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.mid && m.roomId === req.room.id);
  if (!msg) return res.status(404).json({ error: 'message not found' });
  const emoji = String((req.body && req.body.emoji) || '');
  if (!HUMAN_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'reaction must be one of 👍 👀 ✅' });
  const reactions = normalizeReactions(msg.reactions);
  const idx = reactions.findIndex(r => r.userId === req.profile.id && r.emoji === emoji);
  if (idx >= 0) reactions.splice(idx, 1); // 同じリアクションはトグルで外す
  else reactions.push({ userId: req.profile.id, name: req.profile.name, emoji, at: now() });
  msg.reactions = reactions;
  updateMessage(msg);
  res.json({ ...msg, deliveries: deliveriesFor(req.room, msg.id) });
});
app.post('/api/rooms/:id/read', auth, requireMember, (req, res) => {
  markRoomRead(req.room.id, req.profile.id);
  save();
  broadcastRead(req.room.id, req.profile.id);
  res.json({ ok: true });
});
app.post('/api/rooms/:id/call-kapio', auth, requireMember, (req, res) => {
  const seats = seatsOf(req.room);
  if (!seats.length) return res.status(400).json({ error: 'このルームにはMuseが同席していません' });
  const seatId = req.body && req.body.seatId;
  const targets = seatId ? seats.filter(s => seatIdOf(s) === seatId) : seats;
  if (!targets.length) return res.status(404).json({ error: 'そのMuseの席が見つかりません' });
  const rs = targets.map(s => queueKapio(req.room.id, 'reply', req.profile.id, null, s.ownerId || null));
  res.json({ ok: true, requestId: rs[0].id, requestIds: rs.map(r => r.id) });
});
app.post('/api/rooms/:id/summary-request', auth, requireMember, (req, res) => {
  // v4.22: まとめ（要約）機能は無効化（しゅんぺい指示）。依頼は作らない
  return res.status(410).json({ error: 'まとめ機能は無効化されています' });
});

// Muse seat claim / release（v4.3: 席はメンバーごとに1つ、全員分が共存できる）
app.post('/api/rooms/:id/muse-claim', auth, requireMember, (req, res) => {
  const room = req.room;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 30) || req.profile.museName || 'Muse';
  req.profile.museName = name;
  if (!Array.isArray(room.muses)) room.muses = [];
  const existing = seatByOwner(room, req.profile.id);
  if (existing) existing.name = name;
  else room.muses.push({ ownerId: req.profile.id, name });
  room.kapioEnabled = true;
  if (!memberOf(room.id, `muse:${req.profile.id}`)) {
    db.members.push({ roomId: room.id, profileId: `muse:${req.profile.id}`, lastReadSeq: null, joinedAt: now() });
  }
  save();
  if (!existing) postMessage(room.id, 'system', 'システム', `${name}（${req.profile.name}さんのMuse）が同席するようになりました`, 'system');
  res.json(roomDetail(room, req.profile.id));
});
app.post('/api/rooms/:id/muse-release', auth, requireMember, (req, res) => {
  const room = req.room;
  const seatId = req.body && req.body.seatId;
  let target = null;
  if (seatId) target = seatsOf(room).find(s => seatIdOf(s) === seatId) || null;
  else target = seatByOwner(room, req.profile.id) || (room.createdBy === req.profile.id ? seatByOwner(room, null) : null);
  if (!target) return res.status(404).json({ error: '外せるMuseの席がありません' });
  const isOwner = (target.ownerId || null) === req.profile.id;
  const isCreator = room.createdBy === req.profile.id;
  if (!isOwner && !isCreator) return res.status(403).json({ error: '席を外せるのは、Museの持ち主かルームを作った人だけです' });
  const name = target.name || 'Muse';
  for (const r of db.kapioRequests) if (r.roomId === room.id && r.status === 'pending' && (r.ownerId || null) === (target.ownerId || null)) finishRequest(r, 'done');
  room.muses = seatsOf(room).filter(s => s !== target);
  db.members = db.members.filter(m => !(m.roomId === room.id && m.profileId === seatIdOf(target)));
  room.kapioEnabled = room.muses.length > 0;
  save();
  postMessage(room.id, 'system', 'システム', `${name}が同席を外れました`, 'system');
  res.json(roomDetail(room, req.profile.id));
});

// decisions
app.get('/api/rooms/:id/decisions', auth, requireMember, (req, res) => res.json(db.decisions.filter(d => d.roomId === req.room.id)));
app.post('/api/rooms/:id/decisions', auth, requireMember, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'text required' });
  const d = { id: id(), roomId: req.room.id, text, createdBy: req.profile.id, createdAt: now() };
  db.decisions.push(d);
  save();
  res.json(d);
});
app.delete('/api/rooms/:id/decisions/:decId', auth, requireMember, (req, res) => {
  db.decisions = db.decisions.filter(d => !(d.id === req.params.decId && d.roomId === req.room.id));
  save();
  res.json({ ok: true });
});

// tasks（v4.13: 決めること）
app.get('/api/rooms/:id/tasks', auth, requireMember, (req, res) => res.json(db.tasks.filter(t => t.roomId === req.room.id).map(taskView)));
app.post('/api/rooms/:id/tasks', auth, requireMember, (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'text required' });
  const dueCreate = parseDueField(req.body);
  if (dueCreate === 'invalid') return res.status(400).json({ error: 'due must be YYYY-MM-DD or null' });
  const propCreate = parseProposalField(req.body);
  if (propCreate === 'invalid') return res.status(400).json({ error: 'proposal must be a string, {text} or null' });
  const t = { id: id(), roomId: req.room.id, text, done: false, createdByName: req.profile.name, createdAt: now(), doneAt: null, note: '', remind: false, due: dueCreate === undefined ? null : dueCreate, kind: normalizeKind(req.body.kind), phase: normalizePhase(req.body.phase), proposal: null, votes: [], stances: [], dominance: null, objections: [] };
  if (propCreate) t.proposal = { text: propCreate, updatedAt: now(), updatedBy: req.profile.name };
  db.tasks.push(t);
  save();
  res.json(taskView(t));
});
// v4.23追加: 備考（note）とリマインドON/OFF（remind）の更新。完了済みには付けない
// v4.24追加: 回答期限（due）の更新もここで扱う。due は null でクリア可
app.post('/api/rooms/:id/tasks/:taskId/update', auth, requireMember, (req, res) => {
  const t = db.tasks.find(x => x.id === req.params.taskId && x.roomId === req.room.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  if (t.done) return res.status(400).json({ error: 'task already done' });
  const dueUpd = parseDueField(req.body);
  if (dueUpd === 'invalid') return res.status(400).json({ error: 'due must be YYYY-MM-DD or null' });
  if (typeof req.body.note === 'string') t.note = req.body.note.trim().slice(0, 500);
  if (typeof req.body.remind === 'boolean') t.remind = req.body.remind;
  if (dueUpd !== undefined) t.due = dueUpd;
  if ('phase' in req.body) { if (!TASK_PHASES.includes(req.body.phase)) return res.status(400).json({ error: 'invalid phase' }); t.phase = req.body.phase; }
  if ('kind' in req.body) { if (!TASK_KINDS.includes(req.body.kind)) return res.status(400).json({ error: 'invalid kind' }); t.kind = req.body.kind; }
  const propUpd = parseProposalField(req.body);
  if (propUpd === 'invalid') return res.status(400).json({ error: 'proposal must be a string, {text} or null' });
  if (propUpd !== undefined) applyProposal(t, propUpd, req.profile.name);
  save();
  res.json(taskView(t));
});

// v4.26: 人間がボードから直接投票・申告する（自分のオーナー分として登録。Muse経由の票と同一枠で上書きし合う）
function humanTaskOr404(req, res) {
  const t = db.tasks.find(x => x.id === req.params.taskId && x.roomId === req.room.id);
  if (!t) { res.status(404).json({ error: 'task not found' }); return null; }
  return t;
}
app.post('/api/rooms/:id/tasks/:taskId/vote', auth, requireMember, (req, res) => {
  const t = humanTaskOr404(req, res); if (!t) return;
  if (!normalizeProposal(t.proposal)) return res.status(400).json({ error: 'proposal is required before voting（提案がまだありません。先に提案を設定してください）' });
  const choice = req.body && req.body.choice;
  if (!VOTE_CHOICES.includes(choice)) return res.status(400).json({ error: 'choice must be yes / yes_conditional / no / hold' });
  const condition = String((req.body && req.body.condition) || '').trim().slice(0, 200);
  if (choice === 'yes_conditional' && !condition) return res.status(400).json({ error: 'condition is required for yes_conditional' });
  const option = String((req.body && req.body.option) || '').trim().slice(0, 60) || null;
  const votes = currentVotes(t).filter(v => (v.ownerId || null) !== req.profile.id);
  votes.push({ ownerId: req.profile.id, seatName: req.profile.name, choice, option, condition: condition || null, registeredBy: 'human', updatedAt: now(), proposalAt: proposalAtOf(t) });
  t.votes = votes;
  save();
  res.json({ ok: true, task: taskView(t), vote_summary: voteSummary(req.room, t) });
});
app.post('/api/rooms/:id/tasks/:taskId/stance', auth, requireMember, (req, res) => {
  const t = humanTaskOr404(req, res); if (!t) return;
  const temperature = (req.body && req.body.temperature) || null;
  if (temperature !== null && !STANCE_TEMPS.includes(temperature)) return res.status(400).json({ error: 'temperature must be high / mid / low' });
  const stances = normalizeStances(t.stances).filter(x => (x.ownerId || null) !== req.profile.id);
  stances.push({
    ownerId: req.profile.id, seatName: req.profile.name,
    conditions: String((req.body && req.body.conditions) || '').trim().slice(0, 500),
    nonNegotiables: String((req.body && (req.body.non_negotiables ?? req.body.nonNegotiables)) || '').trim().slice(0, 500),
    temperature, registeredBy: 'human', updatedAt: now(),
  });
  t.stances = stances;
  save();
  res.json({ ok: true, task: taskView(t) });
});
app.post('/api/rooms/:id/tasks/:taskId/done', auth, requireMember, (req, res) => {
  const t = db.tasks.find(x => x.id === req.params.taskId && x.roomId === req.room.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  t.done = true;
  t.doneAt = now();
  save();
  res.json(taskView(t));
});
app.delete('/api/rooms/:id/tasks/:taskId', auth, requireMember, (req, res) => {
  db.tasks = db.tasks.filter(t => !(t.id === req.params.taskId && t.roomId === req.room.id));
  save();
  res.json({ ok: true });
});

// notifications（保存せず、所属ルームのメッセージから組み立てる）
app.get('/api/notifications', auth, (req, res) => {
  const lastRead = new Map(db.members.filter(m => m.profileId === req.profile.id).map(m => [m.roomId, m.lastReadSeq || 0]));
  const list = [];
  for (let i = db.messages.length - 1; i >= 0 && list.length < 100; i--) {
    const m = db.messages[i];
    if (!lastRead.has(m.roomId) || !countsAsUnread(m, req.profile.id)) continue;
    const room = roomById(m.roomId);
    list.push({ id: m.id, roomId: m.roomId, messageId: m.id, preview: previewOf(m), senderName: m.senderName, roomName: room ? room.name : '', createdAt: m.createdAt, read: (m.seq || 0) <= lastRead.get(m.roomId) });
  }
  res.json({ notifications: list, unreadTotal: unreadTotal(req.profile.id) });
});
app.post('/api/notifications/read-all', auth, (req, res) => {
  for (const m of db.members.filter(x => x.profileId === req.profile.id)) {
    markRoomRead(m.roomId, req.profile.id);
    broadcastRead(m.roomId, req.profile.id);
  }
  save();
  res.json({ ok: true });
});

// push subscriptions
app.get('/api/push/public-key', (req, res) => res.json({ key: VAPID_PUBLIC || null }));
app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'subscription required' });
  db.pushSubs = db.pushSubs.filter(s => s.endpoint !== sub.endpoint);
  db.pushSubs.push({ profileId: req.profile.id, endpoint: sub.endpoint, subscription: sub, createdAt: now() });
  save();
  res.json({ ok: true });
});

// v4.26: テストプッシュ（自分宛のみ）。VAPID未設定・購読なしは理由を返して切り分け可能にする
app.post('/api/push/test', auth, async (req, res) => {
  if (!webpush) return res.status(503).json({ ok: false, error: 'サーバーにVAPIDキーが設定されていないため、プッシュを送れません', vapidConfigured: false });
  const subs = db.pushSubs.filter(x => x.profileId === req.profile.id);
  if (!subs.length) return res.status(400).json({ ok: false, error: 'この端末の購読が登録されていません。通知を許可してから開き直してください', vapidConfigured: true, subscriptions: 0 });
  let sent = 0, failed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify({ title: 'Muse対応チャット', body: 'テスト通知です。届いていればプッシュは正常です', roomId: null }));
      sent++;
    } catch (err) {
      failed++;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) db.pushSubs = db.pushSubs.filter(x => x.endpoint !== s.endpoint);
    }
  }
  if (failed) save();
  res.json({ ok: sent > 0, vapidConfigured: true, subscriptions: subs.length, sent, failed });
});

// ---------- bridge API (Muse) ----------
// 従来の一覧取得（10分巡回のhookなど）。picked=true は見張り役が処理中
app.get('/api/bridge/pending', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const pending = db.kapioRequests.filter(r => r.status === 'pending' && bridgeSees(req.bridge, r)).map(requestView);
  // v4.20: 自分の席があるルームのお知らせも一緒に渡す（各ルーム直近5件）
  const rooms = db.rooms.filter(r => req.bridge.kind === 'global' ? seatsOf(r).length > 0 : !!seatByOwner(r, req.bridge.profile.id));
  const notices = [];
  for (const r of rooms) {
    for (const n of roomNotices(r).slice(0, 5)) notices.push({ ...n, room_id: r.id, room_name: r.name });
  }
  res.json({ pending, notices });
});
// 見張り役用の長ポーリング。依頼が来た瞬間に返る。無ければ timeout 秒で空を返す
app.get('/api/bridge/wait', bridgeAuth, (req, res) => {
  const timeoutMs = Math.min(Math.max(Number(req.query.timeout) || 25, 1), 50) * 1000;
  touchBridge(req.bridge);
  const ready = takeForWatcher(req.bridge);
  if (ready.length) return res.json({ pending: ready });
  const w = { key: callerKey(req.bridge), caller: req.bridge, res, timer: null };
  w.timer = setTimeout(() => {
    waiters.delete(w);
    bridgeSeen.set(w.key, Date.now());
    if (!res.headersSent) res.json({ pending: [] });
  }, timeoutMs);
  waiters.add(w);
  checkPresence();
  res.on('close', () => {
    if (waiters.has(w)) { clearTimeout(w.timer); waiters.delete(w); }
    bridgeSeen.set(w.key, Date.now());
  });
});
// v4.14: イベントストリーム（SSE）。接続中は新規メッセージ・新規リクエストを即時に流す（ポーリングのフォールバックは従来どおり）
app.get('/api/bridge/events', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  const lastId = Number(req.headers['last-event-id'] || req.query.last_event_id) || 0;
  if (lastId > 0) {
    for (const ev of bridgeEventBuffer) {
      if (ev.id <= lastId) continue;
      const visible = ev.payload.type === 'request' ? bridgeSees(req.bridge, { ownerId: ev.ownerId }) : callerSeesRoom(req.bridge, ev.roomId);
      if (visible) { try { res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev.payload)}\n\n`); } catch (e) {} }
    }
  }
  const client = { caller: req.bridge, res };
  bridgeEventClients.add(client);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} touchBridge(req.bridge); }, 25000);
  req.on('close', () => { clearInterval(ping); bridgeEventClients.delete(client); });
});
// 考え中表示を続ける（返信まで20秒おき程度に呼ぶ）
app.post('/api/bridge/typing', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const r = db.kapioRequests.find(x => x.id === (req.body && req.body.request_id));
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (!bridgeSees(req.bridge, r)) return res.status(403).json({ error: 'this request belongs to another Muse' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'already handled', status: r.status });
  if (!r.pickedAt) { r.pickedAt = now(); save(); }
  museStatus(r, 'thinking');
  res.json({ ok: true });
});
// v4.17: 未回答の判定登録。各Museが自分の依頼について「要回答かどうか」と題名を登録する（再登録で上書き）
app.post('/api/bridge/verdict', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const r = db.kapioRequests.find(x => x.id === (req.body && req.body.request_id));
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (!bridgeSees(req.bridge, r)) return res.status(403).json({ error: 'this request belongs to another Muse' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'already handled', status: r.status });
  if (typeof (req.body && req.body.needs_answer) !== 'boolean') return res.status(400).json({ error: 'needs_answer (boolean) is required' });
  const title = String((req.body && req.body.title) || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  r.verdict = { needsAnswer: req.body.needs_answer, title, at: now() };
  save();
  broadcastUnanswered(r.roomId);
  res.json({ ok: true, verdict: { needs_answer: r.verdict.needsAnswer, title: r.verdict.title } });
});
// 返信。partial:true は「ひと言の先返し」で、同じ依頼の次の返信がその吹き出しを書き換える
app.post('/api/bridge/reply', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const r = db.kapioRequests.find(x => x.id === req.body.request_id);
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (!bridgeSees(req.bridge, r)) return res.status(403).json({ error: 'this request belongs to another Muse' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'already handled', status: r.status });
  const room = roomById(r.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const body = String(req.body.body || '').trim().slice(0, 4000);
  const partial = req.body.partial === true;
  const senderId = r.ownerId ? `muse:${r.ownerId}` : KAPIO_ID;
  const senderName = seatNameFor(room, r.ownerId);

  if (r.type === 'summary' && !partial) {
    room.lastSummary = body || room.lastSummary;
    const decisions = Array.isArray(req.body.decisions) ? req.body.decisions : [];
    for (const text of decisions) {
      const t = String(text).trim().slice(0, 300);
      if (t && !db.decisions.some(d => d.roomId === room.id && d.text === t)) {
        db.decisions.push({ id: id(), roomId: room.id, text: t, createdBy: senderId, createdAt: now() });
      }
    }
  }
  const images = bridgeImages(req.body);
  const file = bridgeFile(req.body);
  let message = null;
  const earlier = r.partialMessageId ? db.messages.find(m => m.id === r.partialMessageId && m.type !== 'unsent') : null;
  if (file) {
    // v4.23: PDFは単独メッセージで投稿（画像が無い場合だけ本文をキャプションとして付ける）
    message = postMessage(room.id, senderId, senderName, images.length ? '' : body, 'text', null, { replyTo: r.triggerMessageId, via: 'reply', file });
  }
  if (images.length) {
    // v4.11: 画像は1枚ずつ別メッセージで投稿（最初の1枚にだけ本文をキャプションとして付ける）
    images.forEach((img, i) => {
      const cap = i === 0 && !file ? body : '';
      const m = postMessage(room.id, senderId, senderName, cap, img && !cap ? 'image' : 'text', img, { replyTo: r.triggerMessageId, via: 'reply' });
      if (!message) message = m;
    });
  } else if (!file && body && earlier) {
    earlier.body = body;
    earlier.editedAt = now();
    updateMessage(earlier);
    message = earlier;
  } else if (!file && body) {
    message = postMessage(room.id, senderId, senderName, body, 'text', null, { replyTo: r.triggerMessageId, via: 'reply' });
  }
  if (partial) {
    if (message) r.partialMessageId = message.id;
    r.pickedAt = now();
    r.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // v4.4: 仮答した依頼は24時間保持（オーナーの回答を待てるように）
    save();
    museStatus(r, 'thinking');
    return res.json({ ok: true, partial: true, message_id: message ? message.id : null });
  }
  finishRequest(r, 'done');
  res.json({ ok: true, message_id: message ? message.id : null });
});
app.post('/api/bridge/dismiss', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const r = db.kapioRequests.find(x => x.id === req.body.request_id);
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (!bridgeSees(req.bridge, r)) return res.status(403).json({ error: 'this request belongs to another Muse' });
  if (r.status === 'pending') finishRequest(r, 'done');
  res.json({ ok: true });
});
// v4.4: 依頼に紐づかない自発投稿（連絡スペースの「ルームへ聞く」用）。呼び出し元の席として投稿する
app.post('/api/bridge/post', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  let room = roomById(req.body && req.body.room_id);
  if (!room && req.body && req.body.room_name) {
    // v4.4.2: room_id が無い場合はルーム名でも解決する（自分の席があるルームに限る）
    const name = String(req.body.room_name);
    room = db.rooms.filter(r => r.name === name).find(r => req.bridge.kind === 'global' ? seatsOf(r).some(s => !s.ownerId) : !!seatByOwner(r, req.bridge.profile.id)) || null;
  }
  if (!room) return res.status(404).json({ error: 'room not found' });
  const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
  const images = bridgeImages(req.body);
  const file = bridgeFile(req.body);
  if (!body && !images.length && !file) return res.status(400).json({ error: 'body, image or file required' });
  let seat = null;
  if (req.bridge.kind === 'global') seat = seatsOf(room).find(s => !s.ownerId) || null;
  else seat = seatByOwner(room, req.bridge.profile.id);
  if (!seat) return res.status(403).json({ error: 'no seat in this room' });
  // v4.26: ops:true の投稿は運用系の変更依頼として、トーク・未読・プッシュ・依頼の対象にせず、決めることボードの kind=ops 項目として登録する（設計案ステップ2 S2-2）
  if (req.body && req.body.ops === true) {
    if (!body) return res.status(400).json({ error: 'body required for ops' });
    const ot = { id: id(), roomId: room.id, text: body.slice(0, 300), done: false, createdByName: seat.name || 'Muse', createdAt: now(), doneAt: null, note: body.length > 300 ? body.slice(0, 500) : '', remind: false, due: null, kind: 'ops', phase: 'intake', proposal: null, votes: [], stances: [], dominance: null, objections: [] };
    db.tasks.push(ot);
    save();
    return res.json({ ok: true, ops: true, task_id: ot.id, task: taskView(ot) });
  }
  // v4.20: notice:true の投稿は「お知らせ」になる（トーク欄に出ず、依頼も作らない）
  if (req.body && req.body.notice === true) {
    const m = postMessage(room.id, seatIdOf(seat), seat.name || 'Muse', body, 'notice', null, { via: 'post' });
    return res.json({ ok: true, message_id: m.id, message_ids: [m.id] });
  }
  // v4.11: 画像はアプリと同じ形で1枚ずつ別メッセージ（最初の1枚にだけ body をキャプションとして付ける）
  // v4.23: PDF（file）も同じ形で単独メッセージ。キャプションは先頭の添付にだけ付ける
  const ids = [];
  if (file) {
    ids.push(postMessage(room.id, seatIdOf(seat), seat.name || 'Muse', body, 'text', null, { via: 'post', file }).id);
  }
  if (images.length) {
    images.forEach((img, i) => {
      const cap = i === 0 && !file ? body : '';
      ids.push(postMessage(room.id, seatIdOf(seat), seat.name || 'Muse', cap, img && !cap ? 'image' : 'text', img, { via: 'post' }).id);
    });
  } else if (!file) {
    ids.push(postMessage(room.id, seatIdOf(seat), seat.name || 'Muse', body, 'text', null, { via: 'post' }).id);
  }
  res.json({ ok: true, message_id: ids[0], message_ids: ids });
});

// v4.13: 決めること（タスク）のブリッジAPI（Museが議題を登録・確認できるように）
app.post('/api/bridge/task', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  let room = roomById(req.body && req.body.room_id);
  if (!room && req.body && req.body.room_name) {
    const name = String(req.body.room_name);
    room = db.rooms.filter(r => r.name === name).find(r => req.bridge.kind === 'global' ? seatsOf(r).length > 0 : !!seatByOwner(r, req.bridge.profile.id)) || null;
  }
  if (!room) return res.status(404).json({ error: 'room not found' });
  const hasSeat = req.bridge.kind === 'global' ? seatsOf(room).length > 0 : !!seatByOwner(room, req.bridge.profile.id);
  if (!hasSeat) return res.status(403).json({ error: 'no seat in this room' });
  const text = String((req.body && req.body.text) || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'text required' });
  const seat = req.bridge.kind === 'global' ? null : seatByOwner(room, req.bridge.profile.id);
  const dueBridge = parseDueField(req.body);
  if (dueBridge === 'invalid') return res.status(400).json({ error: 'due must be YYYY-MM-DD or null' });
  const propBridge = parseProposalField(req.body);
  if (propBridge === 'invalid') return res.status(400).json({ error: 'proposal must be a string, {text} or null' });
  const t = { id: id(), roomId: room.id, text, done: false, createdByName: seat ? (seat.name || 'Muse') : KAPIO_NAME, createdAt: now(), doneAt: null, note: '', remind: false, due: dueBridge === undefined ? null : dueBridge, kind: normalizeKind(req.body && req.body.kind), phase: normalizePhase(req.body && req.body.phase), proposal: null, votes: [], stances: [], dominance: null, objections: [] };
  if (propBridge) t.proposal = { text: propBridge, updatedAt: now(), updatedBy: seat ? (seat.name || 'Muse') : KAPIO_NAME };
  db.tasks.push(t);
  save();
  res.json({ ok: true, task: taskView(t) });
});
app.get('/api/bridge/tasks', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  let rooms = db.rooms.filter(r => req.bridge.kind === 'global' ? seatsOf(r).length > 0 : !!seatByOwner(r, req.bridge.profile.id));
  if (req.query.room_id) rooms = rooms.filter(r => r.id === req.query.room_id);
  if (req.query.room_name) rooms = rooms.filter(r => r.name === String(req.query.room_name));
  if ((req.query.room_id || req.query.room_name) && !rooms.length) return res.status(404).json({ error: 'room not found' });
  const tasks = db.tasks.filter(t => !t.done && rooms.some(r => r.id === t.roomId))
    .map(t => { const room = rooms.find(r => r.id === t.roomId) || {}; const v = taskView(t); return { id: t.id, room_id: t.roomId, room_name: room.name || null, text: t.text, created_by_name: t.createdByName, created_at: t.createdAt, note: t.note || '', remind: t.remind === true, due: normalizeDue(t.due), kind: v.kind, phase: v.phase, proposal: v.proposal, votes: v.votes, stances: v.stances, dominance: v.dominance, objections: v.objections, vote_summary: voteSummary(room, t) }; });
  res.json({ ok: true, tasks });
});
// v4.24: 既存タスクの due / note / remind を更新するブリッジAPI。その席があるルームのタスクのみ操作可（globalトークンも可）。due は null でクリア可
app.post('/api/bridge/task/update', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const taskId = req.body && (req.body.id || req.body.task_id);
  if (!taskId) return res.status(400).json({ error: 'id required' });
  const t = db.tasks.find(x => x.id === taskId);
  if (!t) return res.status(404).json({ error: 'task not found' });
  const room = roomById(t.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const hasSeat = req.bridge.kind === 'global' ? seatsOf(room).length > 0 : !!seatByOwner(room, req.bridge.profile.id);
  if (!hasSeat) return res.status(403).json({ error: 'no seat in this room' });
  const wantDone = !!(req.body && 'done' in req.body);
  if (t.done && !(wantDone && req.body.done === false)) return res.status(400).json({ error: 'task already done' });
  const dueBUpd = parseDueField(req.body);
  if (dueBUpd === 'invalid') return res.status(400).json({ error: 'due must be YYYY-MM-DD or null' });
  if (typeof (req.body && req.body.note) === 'string') t.note = req.body.note.trim().slice(0, 500);
  if (typeof (req.body && req.body.remind) === 'boolean') t.remind = req.body.remind;
  if (dueBUpd !== undefined) t.due = dueBUpd;
  if (req.body && 'phase' in req.body) { if (!TASK_PHASES.includes(req.body.phase)) return res.status(400).json({ error: 'invalid phase' }); t.phase = req.body.phase; }
  if (req.body && 'kind' in req.body) { if (!TASK_KINDS.includes(req.body.kind)) return res.status(400).json({ error: 'invalid kind' }); t.kind = req.body.kind; }
  const propBUpd = parseProposalField(req.body);
  if (propBUpd === 'invalid') return res.status(400).json({ error: 'proposal must be a string, {text} or null' });
  if (propBUpd !== undefined) { const seatU = callerSeat(req.bridge, room); applyProposal(t, propBUpd, seatU ? (seatU.name || 'Muse') : KAPIO_NAME); }
  // v4.26 (A-1): ブリッジから完了できる。decisions への登録はしない（確定は finalize 経由のみ）
  if (wantDone) {
    if (req.body.done === true) { t.done = true; t.doneAt = now(); if (['intake', 'conditions', 'candidates', 'voting'].includes(t.phase)) t.phase = 'decided'; }
    else if (req.body.done === false) { t.done = false; t.doneAt = null; }
    else return res.status(400).json({ error: 'done must be boolean' });
  }
  save();
  res.json({ ok: true, task: taskView(t) });
});

// ---------- v4.26: 投票・申告・relay・決着・リアクション（ブリッジ） ----------
// 自分の席があるルームのタスクを引く共通処理。引けなければレスポンスを書いて null
function bridgeTaskFor(req, res) {
  touchBridge(req.bridge);
  const taskId = req.body && (req.body.task_id || req.body.id);
  if (!taskId) { res.status(400).json({ error: 'task_id required' }); return null; }
  const t = db.tasks.find(x => x.id === taskId);
  if (!t) { res.status(404).json({ error: 'task not found' }); return null; }
  const room = roomById(t.roomId);
  if (!room) { res.status(404).json({ error: 'room not found' }); return null; }
  const seat = callerSeat(req.bridge, room);
  if (!seat) { res.status(403).json({ error: 'no seat in this room' }); return null; }
  return { t, room, seat };
}
// 投票（自分の席分のみ。1オーナー1票・上書き可。yes_conditional は condition 必須、集計は賛成側）
app.post('/api/bridge/task/vote', bridgeAuth, (req, res) => {
  const ctx = bridgeTaskFor(req, res); if (!ctx) return;
  const { t, room, seat } = ctx;
  if (!normalizeProposal(t.proposal)) return res.status(400).json({ error: 'proposal is required before voting（提案がまだありません。先に task/update で proposal を設定してください）' });
  const choice = req.body && req.body.choice;
  if (!VOTE_CHOICES.includes(choice)) return res.status(400).json({ error: 'choice must be yes / yes_conditional / no / hold' });
  const condition = String((req.body && req.body.condition) || '').trim().slice(0, 200);
  if (choice === 'yes_conditional' && !condition) return res.status(400).json({ error: 'condition is required for yes_conditional' });
  const option = String((req.body && req.body.option) || '').trim().slice(0, 60) || null;
  const ownerId = seat.ownerId || null;
  const votes = currentVotes(t).filter(v => (v.ownerId || null) !== ownerId);
  votes.push({ ownerId, seatName: seat.name || 'Muse', choice, option, condition: condition || null, registeredBy: 'muse', updatedAt: now(), proposalAt: proposalAtOf(t) });
  t.votes = votes;
  const relayed = applyRelay(req.bridge, req.body && req.body.request_id);
  save();
  res.json({ ok: true, task: taskView(t), vote_summary: voteSummary(room, t), relayed });
});
// 申告（希望条件・譲れない点・温度感。自分の席分のみ、1オーナー1件・上書き可。全てボード公開）
app.post('/api/bridge/task/stance', bridgeAuth, (req, res) => {
  const ctx = bridgeTaskFor(req, res); if (!ctx) return;
  const { t, room, seat } = ctx;
  const temperature = (req.body && req.body.temperature) || null;
  if (temperature !== null && !STANCE_TEMPS.includes(temperature)) return res.status(400).json({ error: 'temperature must be high / mid / low' });
  const ownerId = seat.ownerId || null;
  const stances = normalizeStances(t.stances).filter(x => (x.ownerId || null) !== ownerId);
  stances.push({
    ownerId, seatName: seat.name || 'Muse',
    conditions: String((req.body && req.body.conditions) || '').trim().slice(0, 500),
    nonNegotiables: String((req.body && (req.body.non_negotiables ?? req.body.nonNegotiables)) || '').trim().slice(0, 500),
    temperature, registeredBy: 'muse', updatedAt: now(),
  });
  t.stances = stances;
  const relayed = applyRelay(req.bridge, req.body && req.body.request_id);
  save();
  res.json({ ok: true, task: taskView(t), relayed });
});
// relay 申告（依頼単位。「オーナーへ取り次いだ」ことの自己申告。自分の依頼のみ）
app.post('/api/bridge/relay', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const r = db.kapioRequests.find(x => x.id === (req.body && req.body.request_id));
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (!bridgeSees(req.bridge, r)) return res.status(403).json({ error: 'this request belongs to another Muse' });
  if (req.body && req.body.relayed === false) { r.relayedAt = null; save(); return res.json({ ok: true, relayed: false }); }
  r.relayedAt = now();
  save();
  res.json({ ok: true, relayed: true, relayed_at: r.relayedAt });
});
// 優勢宣言（集約席のみ）。分母は全席、賛成側=yes+yes_conditional、反対=no、holdは数えない。
// 過半数（>50%）があれば、期限前・未投票が残っていても覆らないため宣言できる
app.post('/api/bridge/task/declare', bridgeAuth, (req, res) => {
  const ctx = bridgeTaskFor(req, res); if (!ctx) return;
  const { t, room, seat } = ctx;
  if (!isAggregatorSeat(req.bridge, room, seat)) return res.status(403).json({ error: 'declare is for the aggregator seat only' });
  if (t.done) return res.status(400).json({ error: 'task already done' });
  const sum = voteSummary(room, t);
  const side = (req.body && req.body.side) || sum.majoritySide;
  if (side && !['yes', 'no'].includes(side)) return res.status(400).json({ error: 'side must be yes / no' });
  const sideCount = side === 'yes' ? sum.yesSide : side === 'no' ? sum.no : 0;
  if (!side || sum.total === 0 || !(sideCount * 2 > sum.total)) {
    // 過半数なしは決着を宣言せず parked へ切り分けるのが確定形。宣言自体はエラーで返す
    return res.status(409).json({ error: 'no majority: neither side exceeds 50% of all seats', vote_summary: sum, hint: 'move this task to parked via task/update phase' });
  }
  const declaredAt = now();
  t.dominance = { side, declaredAt, declaredBy: seat.name || 'Muse', objectionDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), status: 'declared' };
  if (t.phase !== 'decided') t.phase = 'voting';
  save();
  res.json({ ok: true, task: taskView(t), vote_summary: sum, dominance: t.dominance });
});
// 異議申立て（優勢宣言の24時間窓内のみ。有効なのは「自分の譲れない点に触れる」場合だけ）
app.post('/api/bridge/task/object', bridgeAuth, (req, res) => {
  const ctx = bridgeTaskFor(req, res); if (!ctx) return;
  const { t, room, seat } = ctx;
  if (!t.dominance || t.dominance.status !== 'declared') return res.status(409).json({ error: 'no active dominance declaration' });
  if (Date.now() > Date.parse(t.dominance.objectionDeadline)) return res.status(409).json({ error: 'objection window closed' });
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const ownerId = seat.ownerId || null;
  const myStance = normalizeStances(t.stances).find(x => (x.ownerId || null) === ownerId);
  if (!myStance || !myStance.nonNegotiables) {
    return res.status(400).json({ error: 'objection is valid only when it touches your declared non-negotiables (stance の non_negotiables が必要です)' });
  }
  const objection = { ownerId, seatName: seat.name || 'Muse', reason, nonNegotiables: myStance.nonNegotiables, at: now(), valid: true };
  t.objections = [...(Array.isArray(t.objections) ? t.objections : []), objection];
  t.dominance = { ...t.dominance, status: 'objected' };
  const reopen = req.body && req.body.reopen;
  t.phase = reopen === 'conditions' ? 'conditions' : 'parked';
  if (t.phase === 'parked') t.due = null;
  const noteLine = `【異議により${t.phase === 'parked' ? '保留' : '条件申告へ差し戻し'}】${seat.name || 'Muse'}：${reason}（譲れない点：${myStance.nonNegotiables}）`;
  t.note = ((t.note || '') + '\n' + noteLine).trim().slice(0, 500);
  save();
  res.json({ ok: true, task: taskView(t), objection });
});
// 確定（集約席のみ。異議窓を過ぎ、有効な異議が無い場合に decisions 登録＋完了＋phase=decided）
app.post('/api/bridge/task/finalize', bridgeAuth, (req, res) => {
  const ctx = bridgeTaskFor(req, res); if (!ctx) return;
  const { t, room, seat } = ctx;
  if (!isAggregatorSeat(req.bridge, room, seat)) return res.status(403).json({ error: 'finalize is for the aggregator seat only' });
  if (t.done) return res.status(400).json({ error: 'task already done' });
  if (!t.dominance || t.dominance.status !== 'declared') return res.status(409).json({ error: 'no active dominance declaration (or already objected)' });
  if (Date.now() < Date.parse(t.dominance.objectionDeadline)) {
    return res.status(409).json({ error: 'objection window still open', objection_deadline: t.dominance.objectionDeadline });
  }
  const validObjections = (t.objections || []).filter(o => o && o.valid);
  if (validObjections.length) return res.status(409).json({ error: 'valid objection exists', objections: validObjections });
  const side = t.dominance.side;
  const propText = (normalizeProposal(t.proposal) || {}).text || t.text;
  let decisionText = side === 'yes' ? `決定：${propText}` : `見送り：${propText}（反対側が優勢）`;
  if (side === 'yes') {
    const conds = currentVotes(t).filter(v => v.choice === 'yes_conditional' && v.condition).map(v => v.condition);
    if (conds.length) decisionText += `（条件：${conds.join('／')}）`;
  }
  const d = { id: id(), roomId: room.id, text: decisionText.slice(0, 300), createdBy: seatIdOf(seat), createdAt: now() };
  db.decisions.push(d);
  t.done = true;
  t.doneAt = now();
  t.phase = 'decided';
  t.dominance = { ...t.dominance, status: 'finalized', finalizedAt: now() };
  save();
  res.json({ ok: true, task: taskView(t), decision: d });
});
// リアクション（Museは 👀 のみ。リアクションは票ではない）
app.post('/api/bridge/reaction', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const emoji = String((req.body && req.body.emoji) || '');
  if (!MUSE_REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Muse reactions are limited to 👀' });
  const msg = db.messages.find(m => m.id === (req.body && req.body.message_id));
  if (!msg) return res.status(404).json({ error: 'message not found' });
  const room = roomById(msg.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (req.body && req.body.room_id && req.body.room_id !== msg.roomId) return res.status(400).json({ error: 'room_id mismatch' });
  const seat = callerSeat(req.bridge, room);
  if (!seat) return res.status(403).json({ error: 'no seat in this room' });
  const sid = seatIdOf(seat);
  const reactions = normalizeReactions(msg.reactions);
  const idx = reactions.findIndex(r => r.userId === sid && r.emoji === emoji);
  if (idx >= 0) reactions.splice(idx, 1);
  else reactions.push({ userId: sid, name: seat.name || 'Muse', emoji, at: now() });
  msg.reactions = reactions;
  updateMessage(msg);
  res.json({ ok: true, message_id: msg.id, reactions });
});
// v4.8: ルーム履歴の取得（見張りが pending の有無に関係なく全発言を検知するため。自分の席があるルームのみ）
app.get('/api/bridge/history', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const sinceMs = req.query.since ? Date.parse(String(req.query.since)) : 0; // since はISO時刻
  let rooms = db.rooms.filter(r => req.bridge.kind === 'global' ? seatsOf(r).length > 0 : !!seatByOwner(r, req.bridge.profile.id));
  if (req.query.room_id) rooms = rooms.filter(r => r.id === req.query.room_id);
  if (req.query.room_name) rooms = rooms.filter(r => r.name === String(req.query.room_name));
  if ((req.query.room_id || req.query.room_name) && !rooms.length) return res.status(404).json({ error: 'room not found' });
  res.json({ ok: true, rooms: rooms.map(r => {
    const all = db.messages.filter(m => m.roomId === r.id && m.type !== 'unsent' && (!sinceMs || Date.parse(m.createdAt) > sinceMs));
    return { room_id: r.id, room_name: r.name, messages: all.slice(-limit).map(m => ({ id: m.id, sender_id: m.senderId, sender_name: m.senderName, body: m.body || (m.image ? '（画像を送信しました）' : ''), type: m.type, reply_to: m.replyTo || null, created_at: m.createdAt, reactions: normalizeReactions(m.reactions), deliveries: deliveriesFor(r, m.id) })) };
  }) });
});
// bridge admin (global bridge only)
app.post('/api/bridge/admin/remove-member', bridgeAuth, (req, res) => {
  if (req.bridge.kind !== 'global') return res.status(403).json({ error: 'global bridge only' });
  const roomId = req.body && req.body.room_id;
  const profileId = req.body && req.body.profile_id;
  db.members = db.members.filter(m => !(m.roomId === roomId && m.profileId === profileId));
  save();
  res.json({ ok: true });
});
app.post('/api/bridge/admin/delete-message', bridgeAuth, (req, res) => {
  if (req.bridge.kind !== 'global') return res.status(403).json({ error: 'global bridge only' });
  const messageId = req.body && req.body.message_id;
  const msg = db.messages.find(m => m.id === messageId);
  if (!msg) return res.json({ ok: true });
  db.messages = db.messages.filter(m => m.id !== messageId);
  saveRewrite(msg.roomId);
  broadcastRoom(msg.roomId, { type: 'message_updated', roomId: msg.roomId, message: { id: msg.id, roomId: msg.roomId, deleted: true } });
  bellUnsent(msg, true);
  res.json({ ok: true });
});
// v4.10: 席を外す管理用API（muse-release と同じ処理を global ブリッジから実行できるように）
app.post('/api/bridge/admin/release-seat', bridgeAuth, (req, res) => {
  if (req.bridge.kind !== 'global') return res.status(403).json({ error: 'global bridge only' });
  let room = roomById(req.body && req.body.room_id);
  if (!room && req.body && req.body.room_name) room = db.rooms.find(r => r.name === String(req.body.room_name)) || null;
  if (!room) return res.status(404).json({ error: 'room not found' });
  const seatId = req.body && req.body.seat_id;
  if (!seatId) return res.status(400).json({ error: 'seat_id required' });
  const target = seatsOf(room).find(s => seatIdOf(s) === seatId) || null;
  if (!target) return res.status(404).json({ error: 'seat not found' });
  const name = target.name || 'Muse';
  for (const r of db.kapioRequests) if (r.roomId === room.id && r.status === 'pending' && (r.ownerId || null) === (target.ownerId || null)) finishRequest(r, 'done');
  room.muses = seatsOf(room).filter(s => s !== target);
  db.members = db.members.filter(m => !(m.roomId === room.id && m.profileId === seatIdOf(target)));
  room.kapioEnabled = room.muses.length > 0;
  save();
  postMessage(room.id, 'system', 'システム', `${name}が同席を外れました`, 'system');
  res.json({ ok: true, removed: seatId, name });
});
// v4.21: 既存の発言をお知らせへ移す（過去のアップデート告知の整理用。グローバルトークンのみ）
app.post('/api/bridge/admin/mark-notice', bridgeAuth, (req, res) => {
  if (req.bridge.kind !== 'global') return res.status(403).json({ error: 'global bridge only' });
  const msg = db.messages.find(m => m.id === (req.body && req.body.message_id));
  if (!msg) return res.status(404).json({ error: 'message not found' });
  if (msg.type !== 'notice') {
    msg.type = 'notice';
    updateMessage(msg);
  }
  res.json({ ok: true, message_id: msg.id, type: msg.type });
});

// app icon (PNG, embedded so install icons work without extra files)
const ICON_PNG_B64 = [
  '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',
  'BQAAAABJRU5ErkJggg==',
].join('');
app.get('/icon.png', (req, res) => { res.type('png').send(Buffer.from(ICON_PNG_B64, 'base64')); });

// ---------- static / SPA ----------
const noCache = (res) => res.set('Cache-Control', 'no-cache');
app.use(express.static(path.join(ROOT, 'public'), {
  maxAge: '1h',
  setHeaders: (res, p) => { if (p.endsWith('.html') || p.endsWith('sw.js')) noCache(res); },
}));
app.get('/join/:code', (req, res) => { noCache(res); res.sendFile(path.join(ROOT, 'public', 'index.html')); });
app.get('/', (req, res) => { noCache(res); res.sendFile(path.join(ROOT, 'public', 'index.html')); });

// ---------- startup ----------
async function start() {
  let how;
  try {
    how = await loadDb();
  } catch (e) {
    // 読み込めないまま起動すると空のDBで上書きしてしまうため、起動しない
    console.error('FATAL: could not load data from Upstash. Not starting to avoid overwriting data.', e.message);
    process.exit(1);
  }
  console.log(`data loaded (${how}): ${db.profiles.length} profiles, ${db.rooms.length} rooms, ${db.messages.length} messages`);
  if (how === 'migrated') { console.log('migrating legacy data to v2 keys'); await flushRemote(); }

  const server = app.listen(PORT, () => console.log(`muse-chat listening on ${PORT}`));

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const profile = profileByToken(url.searchParams.get('token'));
    if (!profile) { ws.close(4001, 'unauthorized'); return; }
    if (!clients.has(profile.id)) clients.set(profile.id, new Set());
    clients.get(profile.id).add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }
      const room = roomById(data.roomId);
      if (!room || !memberOf(room.id, profile.id)) return;
      if (data.type === 'send') {
        const body = String(data.body || '').trim().slice(0, 4000);
        const image = validImage(data.image);
        if (body || image) postMessage(room.id, profile.id, profile.name, body, image && !body ? 'image' : 'text', image, { replyTo: data.replyTo });
      } else if (data.type === 'callKapio') {
        if (room.kapioEnabled) for (const s of seatsOf(room)) queueKapio(room.id, 'reply', profile.id, null, s.ownerId || null);
      } else if (data.type === 'read') {
        markRoomRead(room.id, profile.id);
        save();
        broadcastRead(room.id, profile.id);
      }
    });
    ws.on('close', () => {
      const set = clients.get(profile.id);
      if (set) { set.delete(ws); if (!set.size) clients.delete(profile.id); }
    });
  });
  // 切れた接続の掃除（スマホのバックグラウンド等）
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  setInterval(() => { expireRequests(); checkPresence(); }, 15000);
  // v4.15: 呼び鈴へ席の一覧を送る（起動時は必ず、その後は変わった時だけ）
  bellSyncSeats(true);
  setInterval(() => bellSyncSeats(false), 5000);

  // デプロイ時などの終了前に、未保存分を書き出す
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig} received, flushing data...`);
    clearTimeout(persist.timer);
    for (const w of waiters) { clearTimeout(w.timer); if (!w.res.headersSent) w.res.json({ pending: [] }); }
    for (let i = 0; i < 50 && persist.inflight; i++) await sleep(100);
    for (let i = 0; i < 3; i++) {
      try { await flushAll(); } catch (e) { console.error('final flush failed', e); }
      if (!persist.meta && !persist.appends.length && !persist.rewrite.size) break;
      await sleep(1000);
    }
    // v4.15: 呼び鈴への送信待ちを、最大3秒だけ送ってから終える
    for (let i = 0; i < 30 && BELL_ENABLED && (bell.queue.length || bell.inflight); i++) {
      if (!bell.inflight) { clearTimeout(bell.timer); bellFlush(); }
      await sleep(100);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
start();
