'use strict';
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
  if (!env.BRIDGE_TOKEN) {
    env.BRIDGE_TOKEN = crypto.randomBytes(24).toString('hex');
    const port = env.PORT || '8377';
    fs.writeFileSync(ENV_FILE, `PORT=${port}\nBRIDGE_TOKEN=${env.BRIDGE_TOKEN}\n`, { mode: 0o600 });
  }
  if (process.env.PORT) env.PORT = String(process.env.PORT);
  if (process.env.BRIDGE_TOKEN) env.BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
  return env;
}
const ENV = loadEnv();
const PORT = parseInt(ENV.PORT || '8377', 10);
const BRIDGE_TOKEN = ENV.BRIDGE_TOKEN;

// ---------- DB (JSON persistence: local file + optional Upstash Redis) ----------
function emptyDb() {
  return { profiles: [], rooms: [], members: [], messages: [], notifications: [], kapioRequests: [], decisions: [], pushSubs: [], seq: 0 };
}
function normalizeDb() {
  if (!Array.isArray(db.pushSubs)) db.pushSubs = [];
  if (!Array.isArray(db.decisions)) db.decisions = [];
  if (!Array.isArray(db.kapioRequests)) db.kapioRequests = [];
}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
let db;
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  db = emptyDb();
}
normalizeDb();
// Optional external persistence: survives restarts/redeploys on ephemeral hosts (e.g. Render free)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE_KEY = 'muse-chat-db-v1';
async function remoteLoad() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${REMOTE_KEY}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const data = await res.json();
    if (data && data.result) {
      const parsed = JSON.parse(data.result);
      if (parsed && Array.isArray(parsed.profiles)) { db = parsed; normalizeDb(); return true; }
    }
  } catch (e) { console.error('remoteLoad failed', e); }
  return false;
}
let remoteSaveTimer = null;
function remoteSave() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(() => {
    fetch(`${UPSTASH_URL}/set/${REMOTE_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: JSON.stringify(db),
    }).catch(e => console.error('remoteSave failed', e));
  }, 300);
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) { console.error('file save failed', e); }
  }, 100);
  remoteSave();
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
const id = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();
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
// ---------- Muse seat (generalized: each member can bring their own Muse) ----------
const isSeatId = (x) => x === KAPIO_ID || (typeof x === 'string' && x.startsWith('muse:'));
function seatName(room) {
  if (room.muse && room.muse.name) return room.muse.name;
  return db.members.some(m => m.roomId === room.id && m.profileId === KAPIO_ID) ? KAPIO_NAME : 'Muse';
}
function seatInfo(room) {
  const owner = room.muse && room.muse.ownerId ? db.profiles.find(p => p.id === room.muse.ownerId) : null;
  return {
    active: !!room.kapioEnabled,
    name: seatName(room),
    ownerId: room.muse ? (room.muse.ownerId || null) : null,
    ownerName: owner ? owner.name : null,
  };
}

// ---------- helpers ----------
function profileByToken(token) {
  if (!token) return null;
  return db.profiles.find(p => p.token === token) || null;
}
function memberOf(roomId, profileId) {
  return db.members.find(m => m.roomId === roomId && m.profileId === profileId) || null;
}
function roomMembers(roomId) {
  return db.members.filter(m => m.roomId === roomId).map(m => {
    if (isSeatId(m.profileId)) {
      const room = db.rooms.find(r => r.id === roomId);
      return { id: m.profileId, name: room ? seatName(room) : 'Muse', color: '#d4a017', isKapio: m.profileId === KAPIO_ID, isMuse: true };
    }
    const p = db.profiles.find(x => x.id === m.profileId);
    return p ? { id: p.id, name: p.name, color: p.color, isKapio: false, isMuse: false } : null;
  }).filter(Boolean);
}
function unreadCount(roomId, profileId) {
  const mem = memberOf(roomId, profileId);
  if (!mem) return 0;
  const lastSeq = mem.lastReadSeq || 0;
  return db.messages.filter(m => m.roomId === roomId && m.senderId !== profileId && (m.seq || 0) > lastSeq).length;
}
function markRoomRead(roomId, profileId) {
  const mem = memberOf(roomId, profileId);
  if (!mem) return;
  const msgs = db.messages.filter(m => m.roomId === roomId);
  mem.lastReadSeq = msgs.length ? (msgs[msgs.length - 1].seq || 0) : 0;
  for (const n of db.notifications) if (n.profileId === profileId && n.roomId === roomId) n.read = true;
}
function roomView(room, profileId) {
  const msgs = db.messages.filter(m => m.roomId === room.id);
  const last = msgs[msgs.length - 1] || null;
  return {
    id: room.id, name: room.name, inviteCode: room.inviteCode,
    kapioEnabled: room.kapioEnabled, kapioMode: room.kapioMode,
    members: roomMembers(room.id),
    lastMessage: last ? { body: last.body, senderName: last.senderName, createdAt: last.createdAt } : null,
    unread: profileId ? unreadCount(room.id, profileId) : 0,
    lastSummary: room.lastSummary || null,
    museSeat: seatInfo(room),
    updatedAt: room.updatedAt || room.createdAt,
  };
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
function postMessage(roomId, senderId, senderName, body, type = 'text') {
  db.seq = (db.seq || 0) + 1;
  const msg = { id: id() + Date.now().toString(36), seq: db.seq, roomId, senderId, senderName, body, type, createdAt: now() };
  db.messages.push(msg);
  const room = db.rooms.find(r => r.id === roomId);
  if (room) room.updatedAt = msg.createdAt;
  broadcastRoom(roomId, { type: 'message', roomId, message: msg });
  // notifications for other human members
  for (const m of db.members.filter(x => x.roomId === roomId)) {
    if (isSeatId(m.profileId) || m.profileId === senderId) continue;
    const n = {
      id: id(), profileId: m.profileId, roomId, messageId: msg.id,
      preview: body.slice(0, 80), senderName, roomName: room ? room.name : '',
      createdAt: msg.createdAt, read: false,
    };
    db.notifications.push(n);
    const unreadTotal = db.notifications.filter(x => x.profileId === m.profileId && !x.read).length;
    wsSend(m.profileId, { type: 'notification', notification: n, unreadTotal, roomId, unreadInRoom: unreadCount(roomId, m.profileId) });
    sendPushToProfile(m.profileId, { title: room ? room.name : 'Muse対応チャット', body: `${senderName}: ${body.slice(0, 80)}`, roomId });
  }
  // Muse seat queue: mention the seat's name, "Muse" or "ミューズ"
  if (room && room.kapioEnabled && !isSeatId(senderId) && senderId !== 'system' && type === 'text') {
    const mentioned = body.includes(seatName(room)) || body.includes('カピお') || body.includes('ミューズ') || /muse/i.test(body);
    if ((room.kapioMode === 'mention' && mentioned) || room.kapioMode === 'auto') {
      queueKapio(roomId, 'reply', senderId, msg.id);
    }
  }
  save();
  return msg;
}
function queueKapio(roomId, type, requestedBy, triggerMessageId) {
  const room = db.rooms.find(r => r.id === roomId);
  const req = { id: id(), roomId, type, requestedBy, triggerMessageId: triggerMessageId || null, ownerId: room && room.muse ? (room.muse.ownerId || null) : null, status: 'pending', createdAt: now() };
  db.kapioRequests.push(req);
  save();
  return req;
}
function roomContext(roomId, limit = 30) {
  return db.messages.filter(m => m.roomId === roomId).slice(-limit)
    .map(m => ({ senderName: m.senderName, senderId: m.senderId, body: m.body, type: m.type, createdAt: m.createdAt }));
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'muse-chat', time: now() }));

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
function bridgeSees(caller, r) {
  return caller.kind === 'global' ? !r.ownerId : r.ownerId === caller.profile.id;
}

// profiles
app.post('/api/profiles', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'name required' });
  const p = { id: id(), name, color: colorFor(name + id()), token: crypto.randomBytes(20).toString('hex'), createdAt: now() };
  db.profiles.push(p);
  save();
  res.json({ id: p.id, name: p.name, color: p.color, token: p.token });
});
app.get('/api/me', auth, (req, res) => res.json({ id: req.profile.id, name: req.profile.name, color: req.profile.color, museName: req.profile.museName || null, hasBridgeToken: !!req.profile.bridgeToken }));
app.post('/api/me/bridge-token', auth, (req, res) => {
  if (!req.profile.bridgeToken || (req.body && req.body.reset)) {
    req.profile.bridgeToken = crypto.randomBytes(20).toString('hex');
    save();
  }
  res.json({ bridgeToken: req.profile.bridgeToken });
});

// rooms
app.get('/api/rooms', auth, (req, res) => {
  const myRooms = db.members.filter(m => m.profileId === req.profile.id).map(m => db.rooms.find(r => r.id === m.roomId)).filter(Boolean);
  res.json(myRooms.map(r => roomView(r, req.profile.id)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')));
});
app.post('/api/rooms', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50) || '新しいルーム';
  const withKapio = req.body.withKapio !== false;
  const room = {
    id: id(), name, inviteCode: newInviteCode(), createdBy: req.profile.id,
    kapioEnabled: withKapio, kapioMode: req.body.kapioMode === 'auto' ? 'auto' : 'mention',
    lastSummary: null, createdAt: now(), updatedAt: now(),
  };
  db.rooms.push(room);
  db.members.push({ roomId: room.id, profileId: req.profile.id, lastReadMessageId: null, joinedAt: now() });
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
    db.members.push({ roomId: room.id, profileId: req.profile.id, lastReadMessageId: null, joinedAt: now() });
    postMessage(room.id, 'system', 'システム', `${req.profile.name}さんが参加しました`, 'system');
  }
  save();
  res.json(roomView(room, req.profile.id));
});
function requireMember(req, res, next) {
  const room = db.rooms.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  if (!memberOf(room.id, req.profile.id)) return res.status(403).json({ error: 'not a member' });
  req.room = room;
  next();
}
app.get('/api/rooms/:id', auth, requireMember, (req, res) => {
  res.json({ ...roomView(req.room, req.profile.id), decisions: db.decisions.filter(d => d.roomId === req.room.id) });
});
app.post('/api/rooms/:id/settings', auth, requireMember, (req, res) => {
  const room = req.room;
  if (typeof req.body.name === 'string' && req.body.name.trim()) room.name = req.body.name.trim().slice(0, 50);
  if (typeof req.body.kapioEnabled === 'boolean') {
    const was = room.kapioEnabled;
    room.kapioEnabled = req.body.kapioEnabled;
    if (room.kapioEnabled && room.muse && room.muse.ownerId && !memberOf(room.id, `muse:${room.muse.ownerId}`)) {
      db.members.push({ roomId: room.id, profileId: `muse:${room.muse.ownerId}`, lastReadMessageId: null, joinedAt: now() });
    }
    if (!room.kapioEnabled) {
      db.members = db.members.filter(m => !(m.roomId === room.id && isSeatId(m.profileId)));
    }
    if (was !== room.kapioEnabled) {
      postMessage(room.id, 'system', 'システム', room.kapioEnabled ? 'Museが同席するようになりました' : 'Museが同席を外れました', 'system');
    }
  }
  if (req.body.kapioMode === 'mention' || req.body.kapioMode === 'auto') room.kapioMode = req.body.kapioMode;
  save();
  res.json(roomView(room, req.profile.id));
});
app.get('/api/rooms/:id/messages', auth, requireMember, (req, res) => {
  let msgs = db.messages.filter(m => m.roomId === req.room.id);
  if (req.query.before) msgs = msgs.filter(m => (m.seq || 0) < Number(req.query.before));
  res.json(msgs.slice(-100));
});
app.post('/api/rooms/:id/messages', auth, requireMember, (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'body required' });
  const msg = postMessage(req.room.id, req.profile.id, req.profile.name, body);
  res.json(msg);
});
app.post('/api/rooms/:id/read', auth, requireMember, (req, res) => {
  markRoomRead(req.room.id, req.profile.id);
  save();
  res.json({ ok: true });
});
app.post('/api/rooms/:id/call-kapio', auth, requireMember, (req, res) => {
  if (!req.room.kapioEnabled) return res.status(400).json({ error: 'kapio is not in this room' });
  const r = queueKapio(req.room.id, 'reply', req.profile.id, null);
  res.json({ ok: true, requestId: r.id });
});
app.post('/api/rooms/:id/summary-request', auth, requireMember, (req, res) => {
  if (!req.room.kapioEnabled) return res.status(400).json({ error: 'kapio is not in this room' });
  const r = queueKapio(req.room.id, 'summary', req.profile.id, null);
  res.json({ ok: true, requestId: r.id });
});
// Muse seat claim / release
app.post('/api/rooms/:id/muse-claim', auth, requireMember, (req, res) => {
  const room = req.room;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 30) || req.profile.museName || 'Muse';
  req.profile.museName = name;
  db.members = db.members.filter(m => !(m.roomId === room.id && isSeatId(m.profileId)));
  room.muse = { ownerId: req.profile.id, name };
  room.kapioEnabled = true;
  db.members.push({ roomId: room.id, profileId: `muse:${req.profile.id}`, lastReadMessageId: null, joinedAt: now() });
  save();
  postMessage(room.id, 'system', 'システム', `${name}（${req.profile.name}さんのMuse）が同席するようになりました`, 'system');
  res.json({ ...roomView(room, req.profile.id), decisions: db.decisions.filter(d => d.roomId === room.id) });
});
app.post('/api/rooms/:id/muse-release', auth, requireMember, (req, res) => {
  const room = req.room;
  const isOwner = !!(room.muse && room.muse.ownerId === req.profile.id);
  const isCreator = room.createdBy === req.profile.id;
  if (room.muse && !isOwner && !isCreator) return res.status(403).json({ error: 'only the Muse owner or the room creator can release the seat' });
  const name = seatName(room);
  db.members = db.members.filter(m => !(m.roomId === room.id && isSeatId(m.profileId)));
  room.muse = null;
  room.kapioEnabled = false;
  save();
  postMessage(room.id, 'system', 'システム', `${name}が同席を外れました`, 'system');
  res.json({ ...roomView(room, req.profile.id), decisions: db.decisions.filter(d => d.roomId === room.id) });
});
// decisions
app.get('/api/rooms/:id/decisions', auth, requireMember, (req, res) => {
  res.json(db.decisions.filter(d => d.roomId === req.room.id));
});
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

// notifications
app.get('/api/notifications', auth, (req, res) => {
  const list = db.notifications.filter(n => n.profileId === req.profile.id).slice(-100).reverse();
  const unreadTotal = db.notifications.filter(n => n.profileId === req.profile.id && !n.read).length;
  res.json({ notifications: list, unreadTotal });
});
app.post('/api/notifications/read-all', auth, (req, res) => {
  for (const n of db.notifications) if (n.profileId === req.profile.id) n.read = true;
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

// ---------- bridge API (external Claude / Kapio) ----------
app.get('/api/bridge/pending', bridgeAuth, (req, res) => {
  const pending = db.kapioRequests.filter(r => r.status === 'pending' && bridgeSees(req.bridge, r)).map(r => {
    const room = db.rooms.find(x => x.id === r.roomId);
    return {
      request_id: r.id, type: r.type, room_id: r.roomId,
      room_name: room ? room.name : null,
      members: room ? roomMembers(room.id) : [],
      requested_by: r.requestedBy, created_at: r.createdAt,
      context: roomContext(r.roomId, 30),
      decisions: db.decisions.filter(d => d.roomId === r.roomId).map(d => d.text),
    };
  });
  res.json({ pending });
});
app.post('/api/bridge/reply', bridgeAuth, (req, res) => {
  const r = db.kapioRequests.find(x => x.id === req.body.request_id);
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (!bridgeSees(req.bridge, r)) return res.status(403).json({ error: 'this request belongs to another Muse' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'already handled' });
  const room = db.rooms.find(x => x.id === r.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const body = String(req.body.body || '').trim();
  const senderId = r.ownerId ? `muse:${r.ownerId}` : KAPIO_ID;
  const senderName = r.ownerId ? seatName(room) : KAPIO_NAME;
  if (r.type === 'summary') {
    room.lastSummary = body || room.lastSummary;
    const decisions = Array.isArray(req.body.decisions) ? req.body.decisions : [];
    for (const text of decisions) {
      const t = String(text).trim().slice(0, 300);
      if (t) db.decisions.push({ id: id(), roomId: room.id, text: t, createdBy: senderId, createdAt: now() });
    }
    if (body) postMessage(room.id, senderId, senderName, body);
  } else if (body) {
    postMessage(room.id, senderId, senderName, body.slice(0, 4000));
  }
  r.status = 'done';
  r.handledAt = now();
  save();
  res.json({ ok: true });
});
app.post('/api/bridge/dismiss', bridgeAuth, (req, res) => {
  const r = db.kapioRequests.find(x => x.id === req.body.request_id);
  if (!r) return res.status(404).json({ error: 'request not found' });
  if (!bridgeSees(req.bridge, r)) return res.status(403).json({ error: 'this request belongs to another Muse' });
  r.status = 'done';
  r.handledAt = now();
  save();
  res.json({ ok: true });
});

// bridge admin (global bridge only): member/message cleanup
app.post('/api/bridge/admin/remove-member', bridgeAuth, (req, res) => {
  if (req.bridge.kind !== 'global') return res.status(403).json({ error: 'global bridge only' });
  const roomId = req.body && req.body.room_id;
  const profileId = req.body && req.body.profile_id;
  db.members = db.members.filter(m => !(m.roomId === roomId && m.profileId === profileId));
  db.notifications = db.notifications.filter(n => !(n.roomId === roomId && n.profileId === profileId));
  save();
  res.json({ ok: true });
});
app.post('/api/bridge/admin/delete-message', bridgeAuth, (req, res) => {
  if (req.bridge.kind !== 'global') return res.status(403).json({ error: 'global bridge only' });
  const messageId = req.body && req.body.message_id;
  db.messages = db.messages.filter(m => m.id !== messageId);
  save();
  res.json({ ok: true });
});

// app icon (PNG, embedded so install icons work without extra files)
const ICON_PNG_B64 = [
  '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',
  'BQAAAABJRU5ErkJggg==',
].join('');
app.get('/icon.png', (req, res) => { res.type('png').send(Buffer.from(ICON_PNG_B64, 'base64')); });

// ---------- static / SPA ----------
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));
app.get('/join/:code', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------- startup: load remote DB before accepting traffic ----------
async function start() {
  const loaded = await Promise.race([remoteLoad(), new Promise(r => setTimeout(() => r(false), 5000))]);
  if (loaded) console.log('loaded DB from remote store');
  const server = app.listen(PORT, () => console.log(`muse-chat listening on ${PORT}`));

// ---------- WS ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const profile = profileByToken(url.searchParams.get('token'));
  if (!profile) { ws.close(4001, 'unauthorized'); return; }
  if (!clients.has(profile.id)) clients.set(profile.id, new Set());
  clients.get(profile.id).add(ws);
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const room = db.rooms.find(r => r.id === data.roomId);
    if (!room || !memberOf(room.id, profile.id)) return;
    if (data.type === 'send') {
      const body = String(data.body || '').trim().slice(0, 4000);
      if (body) postMessage(room.id, profile.id, profile.name, body);
    } else if (data.type === 'callKapio') {
      if (room.kapioEnabled) queueKapio(room.id, 'reply', profile.id, null);
    } else if (data.type === 'read') {
      markRoomRead(room.id, profile.id);
      save();
    }
  });
  ws.on('close', () => {
    const set = clients.get(profile.id);
    if (set) { set.delete(ws); if (!set.size) clients.delete(profile.id); }
  });
});
}
start();
