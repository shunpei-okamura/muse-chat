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
  return { profiles: [], rooms: [], members: [], messages: [], notifications: [], kapioRequests: [], decisions: [], seq: 0 };
}
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
let db;
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  db = emptyDb();
}
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
      if (parsed && Array.isArray(parsed.profiles)) { db = parsed; return true; }
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
    if (m.profileId === KAPIO_ID) return { id: KAPIO_ID, name: KAPIO_NAME, color: '#2d3436', isKapio: true };
    const p = db.profiles.find(x => x.id === m.profileId);
    return p ? { id: p.id, name: p.name, color: p.color, isKapio: false } : null;
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
    if (m.profileId === KAPIO_ID || m.profileId === exceptProfileId) continue;
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
    if (m.profileId === KAPIO_ID || m.profileId === senderId) continue;
    const n = {
      id: id(), profileId: m.profileId, roomId, messageId: msg.id,
      preview: body.slice(0, 80), senderName, roomName: room ? room.name : '',
      createdAt: msg.createdAt, read: false,
    };
    db.notifications.push(n);
    const unreadTotal = db.notifications.filter(x => x.profileId === m.profileId && !x.read).length;
    wsSend(m.profileId, { type: 'notification', notification: n, unreadTotal, roomId, unreadInRoom: unreadCount(roomId, m.profileId) });
  }
  // Kapio queue
  if (room && room.kapioEnabled && senderId !== KAPIO_ID && type === 'text') {
    const mentioned = body.includes('カピお');
    if ((room.kapioMode === 'mention' && mentioned) || room.kapioMode === 'auto') {
      queueKapio(roomId, 'reply', senderId, msg.id);
    }
  }
  save();
  return msg;
}
function queueKapio(roomId, type, requestedBy, triggerMessageId) {
  const req = { id: id(), roomId, type, requestedBy, triggerMessageId: triggerMessageId || null, status: 'pending', createdAt: now() };
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
  if (token !== BRIDGE_TOKEN) return res.status(401).json({ error: 'invalid bridge token' });
  next();
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
app.get('/api/me', auth, (req, res) => res.json({ id: req.profile.id, name: req.profile.name, color: req.profile.color }));

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
  if (withKapio) db.members.push({ roomId: room.id, profileId: KAPIO_ID, lastReadMessageId: null, joinedAt: now() });
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
    if (room.kapioEnabled && !memberOf(room.id, KAPIO_ID)) {
      db.members.push({ roomId: room.id, profileId: KAPIO_ID, lastReadMessageId: null, joinedAt: now() });
    }
    if (!room.kapioEnabled) {
      db.members = db.members.filter(m => !(m.roomId === room.id && m.profileId === KAPIO_ID));
    }
    if (was !== room.kapioEnabled) {
      postMessage(room.id, 'system', 'システム', room.kapioEnabled ? 'カピおが同席するようになりました' : 'カピおが同席を外れました', 'system');
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

// ---------- bridge API (external Claude / Kapio) ----------
app.get('/api/bridge/pending', bridgeAuth, (req, res) => {
  const pending = db.kapioRequests.filter(r => r.status === 'pending').map(r => {
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
  if (r.status !== 'pending') return res.status(409).json({ error: 'already handled' });
  const room = db.rooms.find(x => x.id === r.roomId);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const body = String(req.body.body || '').trim();
  if (r.type === 'summary') {
    room.lastSummary = body || room.lastSummary;
    const decisions = Array.isArray(req.body.decisions) ? req.body.decisions : [];
    for (const text of decisions) {
      const t = String(text).trim().slice(0, 300);
      if (t) db.decisions.push({ id: id(), roomId: room.id, text: t, createdBy: KAPIO_ID, createdAt: now() });
    }
    if (body) postMessage(room.id, KAPIO_ID, KAPIO_NAME, body);
  } else if (body) {
    postMessage(room.id, KAPIO_ID, KAPIO_NAME, body.slice(0, 4000));
  }
  r.status = 'done';
  r.handledAt = now();
  save();
  res.json({ ok: true });
});
app.post('/api/bridge/dismiss', bridgeAuth, (req, res) => {
  const r = db.kapioRequests.find(x => x.id === req.body.request_id);
  if (!r) return res.status(404).json({ error: 'request not found' });
  r.status = 'done';
  r.handledAt = now();
  save();
  res.json({ ok: true });
});

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
