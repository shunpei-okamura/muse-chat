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
const id = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();

// ---------- DB (in memory) ----------
function emptyDb() {
  return { profiles: [], rooms: [], members: [], messages: [], kapioRequests: [], decisions: [], pushSubs: [], seq: 0 };
}
function normalizeDb() {
  for (const k of ['profiles', 'rooms', 'members', 'messages', 'kapioRequests', 'decisions', 'pushSubs']) {
    if (!Array.isArray(db[k])) db[k] = [];
  }
  delete db.notifications; // v4.1: 通知は保存せず、未読メッセージから組み立てる
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
const countsAsUnread = (m, profileId) => m.senderId !== profileId && m.type !== 'system' && m.type !== 'unsent';
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
function previewOf(m) {
  if (m.type === 'unsent') return '送信を取り消しました';
  if (m.body) return m.body.slice(0, 80);
  return m.image ? '画像を送信しました' : '';
}
function roomView(room, profileId) {
  let last = null;
  for (let i = db.messages.length - 1; i >= 0; i--) if (db.messages[i].roomId === room.id) { last = db.messages[i]; break; }
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
    museActivity: db.kapioRequests
      .filter(r => r.roomId === room.id && r.status === 'pending')
      .map(r => ({ requestId: r.id, type: r.type, state: r.pickedAt ? 'thinking' : 'called', seatId: r.ownerId ? `muse:${r.ownerId}` : KAPIO_ID, name: seatNameFor(room, r.ownerId) })),
  };
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
  const msg = { id: id() + Date.now().toString(36), seq: db.seq, roomId, senderId, senderName, body, type, image: image || null, replyTo, via: extra.via || null, createdAt: now() };
  db.messages.push(msg);
  if (room) room.updatedAt = msg.createdAt;
  broadcastRoom(roomId, { type: 'message', roomId, message: msg });

  if (type !== 'system') {
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
  return db.messages.filter(m => m.roomId === roomId && m.type !== 'unsent').slice(-limit)
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
  wakeWaiters(req);
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
  name: 'muse-chat', time: now(),
  storage: USE_REMOTE ? 'upstash' : 'file',
  lastSaveOkAt: persist.lastOkAt, saveFailures: persist.failures, lastSaveError: persist.lastError,
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
+ '<p>現在のバージョン: <strong>v4.10</strong></p>'
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
+ '<ul><li>v4.10: 席を外す管理用API（/api/bridge/admin/release-seat）を追加</li><li>v4.9: 履歴（/api/bridge/history）の各発言に配信状況（deliveries）を追加。どの席へ依頼が作られ、拾われ、処理されたかを確認できるように</li><li>v4.8: 依頼の有効期限を全種別24時間に統一。履歴取得（/api/bridge/history）を追加し、見張りが宛先に関係なく全発言を検知できるように。連鎖防止は自発投稿（オーナーの指示による投稿）を人間の発言と同扱いにし、ブロック対象から外した</li><li>v4.7: Muse席の発言でも名指し・全体宛なら他の席へ依頼を作るよう変更（Muse同士の連鎖は4件で停止）</li><li>v4.6: 開発ページ（/dev）とソース公開（/source）を追加</li><li>v4.4.2: bridge/post が room_name でも送れるように</li><li>v4.4.1: 返信スタイルを自動に固定、名指しされた発言はその席にだけ依頼</li><li>v4.4: 全体宛の相談（group）、自発投稿（bridge/post）</li><li>v4.3.3: アプリ内蔵の指示文を承認コンソール方式に統合</li></ul>'
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
  if (req.query.after) {
    const after = Number(req.query.after);
    return res.json(msgs.filter(m => (m.seq || 0) > after).slice(0, 300));
  }
  if (req.query.before) msgs = msgs.filter(m => (m.seq || 0) < Number(req.query.before));
  res.json(msgs.slice(-100));
});
app.post('/api/rooms/:id/messages', auth, requireMember, (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 4000);
  const image = validImage(req.body.image);
  if (!body && !image) return res.status(400).json({ error: 'body required' });
  const msg = postMessage(req.room.id, req.profile.id, req.profile.name, body, image && !body ? 'image' : 'text', image, { replyTo: req.body.replyTo });
  res.json(msg);
});
app.post('/api/messages/:msgId/unsend', auth, (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.msgId);
  
  if (!msg || !memberOf(msg.roomId, req.profile.id)) return res.status(404).json({ error: 'メッセージが見つかりません' });
  if (msg.type === 'unsent') return res.json(msg);
  if (!canUnsend(msg, req.profile.id)) return res.status(403).json({ error: '送信取消できるのは、自分（または自分のMuse）の24時間以内のメッセージだけです' });
  msg.type = 'unsent';
  msg.body = '';
  msg.image = null;
  msg.unsentAt = now();
  // この発言をきっかけにした未処理のMuse依頼は取り下げる
  for (const r of db.kapioRequests) {
    if (r.status === 'pending' && r.triggerMessageId === msg.id) { r.cancelReason = 'unsent'; finishRequest(r, 'done'); }
  }
  updateMessage(msg);
  res.json(msg);
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
  const seats = seatsOf(req.room);
  if (!seats.length) return res.status(400).json({ error: 'このルームにはMuseが同席していません' });
  const rs = seats.map(s => queueKapio(req.room.id, 'summary', req.profile.id, null, s.ownerId || null));
  res.json({ ok: true, requestId: rs[0].id, requestIds: rs.map(r => r.id) });
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

// ---------- bridge API (Muse) ----------
// 従来の一覧取得（10分巡回のhookなど）。picked=true は見張り役が処理中
app.get('/api/bridge/pending', bridgeAuth, (req, res) => {
  touchBridge(req.bridge);
  const pending = db.kapioRequests.filter(r => r.status === 'pending' && bridgeSees(req.bridge, r)).map(requestView);
  res.json({ pending });
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
  let message = null;
  const earlier = r.partialMessageId ? db.messages.find(m => m.id === r.partialMessageId && m.type !== 'unsent') : null;
  if (body && earlier) {
    earlier.body = body;
    earlier.editedAt = now();
    updateMessage(earlier);
    message = earlier;
  } else if (body) {
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
  if (!body) return res.status(400).json({ error: 'body required' });
  let seat = null;
  if (req.bridge.kind === 'global') seat = seatsOf(room).find(s => !s.ownerId) || null;
  else seat = seatByOwner(room, req.bridge.profile.id);
  if (!seat) return res.status(403).json({ error: 'no seat in this room' });
  const msg = postMessage(room.id, seatIdOf(seat), seat.name || 'Muse', body, 'text', null, { via: 'post' });
  res.json({ ok: true, message_id: msg.id });
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
    return { room_id: r.id, room_name: r.name, messages: all.slice(-limit).map(m => ({ id: m.id, sender_id: m.senderId, sender_name: m.senderName, body: m.body || (m.image ? '（画像を送信しました）' : ''), type: m.type, reply_to: m.replyTo || null, created_at: m.createdAt, deliveries: db.kapioRequests.filter(q => q.triggerMessageId === m.id).map(q => ({ seat_id: q.ownerId ? `muse:${q.ownerId}` : KAPIO_ID, muse_name: seatNameFor(r, q.ownerId), type: q.type, status: q.status, picked_at: q.pickedAt || null, handled_at: q.handledAt || null, created_at: q.createdAt, expires_at: q.expiresAt })) })) };
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
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
start();
