'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), n = new Date();
  const hm = d.toLocaleTimeString('ja-JP', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const UNSEND_WINDOW_MS = 24 * 60 * 60 * 1000;

let profile = null;
try { profile = JSON.parse(localStorage.getItem('mc_profile') || 'null'); } catch { profile = null; }
let ws = null;
let wsConnecting = false;
let currentRoom = null;
let roomsCache = [];
let pendingImages = [];
let replyTargetId = null;
let unreadStartSeq = 0;
let chatMessages = [];
let pushActive = false;
const joinMatch = location.pathname.match(/^\/join\/([A-Za-z0-9]+)/);
let pendingJoinCode = joinMatch ? joinMatch[1].toUpperCase() : null;
let pendingOpenRoom = new URLSearchParams(location.search).get('room');

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (profile) headers.Authorization = `Bearer ${profile.token}`;
  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (e) {
    const err = new Error('サーバーに接続できません');
    err.status = 0;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- connection banner ----------
const connBanner = document.createElement('div');
connBanner.className = 'conn-banner hidden';
connBanner.textContent = 'サーバーに再接続しています…';
document.body.appendChild(connBanner);
let connBannerTimer = null;
function setConnected(ok) {
  clearTimeout(connBannerTimer);
  if (ok) { connBanner.classList.add('hidden'); return; }
  // 一瞬の切断では出さない
  connBannerTimer = setTimeout(() => connBanner.classList.remove('hidden'), 4000);
}

// ---------- views ----------
function show(viewId) {
  for (const v of ['#view-setup', '#view-rooms', '#view-chat', '#view-notifications']) $(v).classList.add('hidden');
  $(viewId).classList.remove('hidden');
}
function openModal(sel) { $(sel).classList.remove('hidden'); }
function closeModal(el) { el.closest('.modal').classList.add('hidden'); }
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', (e) => closeModal(e.target)));

// ---------- setup ----------
async function doSetup() {
  const name = $('#setup-name').value.trim();
  if (!name) { alert('表示名を入れてください'); return; }
  try {
    profile = await api('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) });
    localStorage.setItem('mc_profile', JSON.stringify(profile));
    afterLogin();
  } catch (e) { alert('作成に失敗しました: ' + e.message); }
}
$('#setup-btn').addEventListener('click', doSetup);
$('#setup-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSetup(); });

// ---------- Web Push ----------
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function subscribePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const { key } = await api('/api/push/public-key');
    if (!key) return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
    pushActive = true;
  } catch { /* push is best-effort */ }
}

async function afterLogin() {
  connectWs();
  subscribePush();
  if (pendingJoinCode) {
    try {
      const room = await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code: pendingJoinCode }) });
      pendingJoinCode = null;
      history.replaceState(null, '', '/');
      await loadRooms();
      openRoom(room.id);
      return;
    } catch { alert('招待リンクのルームが見つかりませんでした'); pendingJoinCode = null; history.replaceState(null, '', '/'); }
  }
  if (pendingOpenRoom) {
    const rid = pendingOpenRoom;
    pendingOpenRoom = null;
    history.replaceState(null, '', '/');
    try { await loadRooms(); await openRoom(rid); refreshBell(); return; } catch { /* fall through */ }
  }
  show('#view-rooms');
  loadRooms();
  refreshBell();
}

// ---------- rooms ----------
async function loadRooms() {
  roomsCache = await api('/api/rooms');
  const ul = $('#room-list');
  ul.innerHTML = '';
  $('#rooms-empty').classList.toggle('hidden', roomsCache.length > 0);
  for (const r of roomsCache) {
    const li = document.createElement('li');
    li.className = 'room-item';
    const others = r.members.filter(m => m.id !== profile.id);
    const color = others.length === 1 && (others[0].isMuse || others[0].isKapio) ? '#d4a017' : (others[0]?.color || '#06c755');
    const initial = r.name.slice(0, 1) || 'ル';
    li.innerHTML = `
      <div class="avatar" style="background:${esc(color)}">${esc(initial)}</div>
      <div class="room-meta">
        <div class="room-name">${esc(r.name)}${r.kapioEnabled ? '<span title="Muse同席中">🍸</span>' : ''}</div>
        <div class="room-last">${r.lastMessage ? esc(r.lastMessage.senderName + ': ' + r.lastMessage.body) : 'まだメッセージがありません'}</div>
      </div>
      <div class="room-side">
        <span class="room-time">${fmtTime(r.updatedAt)}</span>
        ${r.unread ? `<span class="unread-pill">${r.unread}</span>` : ''}
      </div>`;
    li.addEventListener('click', () => openRoom(r.id));
    ul.appendChild(li);
  }
}
$('#create-room-btn').addEventListener('click', () => openModal('#modal-create'));
$('#create-submit').addEventListener('click', async (e) => {
  try {
    const room = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: $('#create-name').value.trim(), withKapio: $('#create-kapio').checked, kapioMode: $('#create-kapio-mode').value }),
    });
    closeModal(e.target);
    await loadRooms();
    openRoom(room.id);
  } catch (err) { alert('作成に失敗しました: ' + err.message); }
});
async function joinByCode(code) {
  code = (code || '').trim().toUpperCase();
  if (!code) return;
  try {
    const room = await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code }) });
    $('#join-code-input').value = '';
    await loadRooms();
    openRoom(room.id);
  } catch { alert('その招待コードのルームは見つかりませんでした'); }
}
$('#join-code-btn').addEventListener('click', () => joinByCode($('#join-code-input').value));
$('#me-btn').addEventListener('click', async () => {
  $('#me-name').textContent = profile.name;
  try { const me = await api('/api/me'); $('#me-push-preview').checked = me.pushPreview !== false; } catch { /* ignore */ }
  openModal('#modal-me');
});
$('#me-push-preview').addEventListener('change', async (e) => {
  try { await api('/api/me/settings', { method: 'POST', body: JSON.stringify({ pushPreview: e.target.checked }) }); }
  catch (err) { alert('保存できませんでした: ' + err.message); e.target.checked = !e.target.checked; }
});

// ---------- Muse presence + activity ----------
const museActivity = document.createElement('div');
museActivity.className = 'muse-activity hidden';
$('#view-chat').insertBefore(museActivity, $('#image-preview'));
let activeRequests = new Map(); // requestId -> { state, type }
let activityHideTimer = null;

const PRESENCE_LABEL = {
  live: { dot: 'live', text: 'すぐ返信できます' },
  polling: { dot: 'polling', text: '返信まで数分かかります' },
  offline: { dot: 'offline', text: '今は返信が遅れるかもしれません' },
};
function renderMuseBar() {
  if (!currentRoom) return;
  const seats = currentRoom.muses || [];
  $('#kapio-bar').classList.toggle('hidden', !seats.length);
  if (!seats.length) return;
  const how = currentRoom.kapioMode === 'auto' ? '会話を見て自動で返信' : '名前を呼ばれたときだけ返信';
  $('#kapio-status').innerHTML = seats.map(s => {
    const p = PRESENCE_LABEL[s.presence] || PRESENCE_LABEL.offline;
    return `<span class="seat-line">🍸 ${esc(s.name)}（Muse）同席中<span class="presence"><i class="dot ${p.dot}"></i>${esc(p.text)}</span><button type="button" class="sub-btn call-seat-btn" data-seat="${esc(s.seatId)}">${esc(s.name)}を呼ぶ</button></span>`;
  }).join('') + `<span class="seat-how">${esc(how)}</span>`;
  const old = $('#call-kapio-btn');
  if (old) old.classList.add('hidden');
  document.querySelectorAll('.call-seat-btn').forEach(b => b.addEventListener('click', async () => {
    if (!currentRoom) return;
    try { await api(`/api/rooms/${currentRoom.id}/call-kapio`, { method: 'POST', body: JSON.stringify({ seatId: b.dataset.seat }) }); }
    catch (e) { alert(e.message); }
  }));
}
function renderMuseActivity() {
  clearTimeout(activityHideTimer);
  if (!currentRoom) { museActivity.classList.add('hidden'); return; }
  const states = [...activeRequests.values()];
  if (!states.length) { museActivity.classList.add('hidden'); return; }
  const thinking = states.find(s => s.state === 'thinking');
  const called = states.find(s => s.state === 'called');
  const expired = states.find(s => s.state === 'expired');
  const name = (thinking || called || expired)?.name || 'Muse';
  const presence = (thinking || called || expired)?.presence || 'offline';
  let text = '';
  let busy = false;
  if (thinking) {
    text = thinking.type === 'summary' ? `${name}が要約を書いています` : `${name}が考え中`;
    busy = true;
  } else if (called) {
    if (presence === 'live') { text = called.type === 'summary' ? `${name}に要約を頼みました` : `${name}を呼んでいます`; busy = true; }
    else if (presence === 'polling') text = `${name}に届きました。返信まで数分かかります`;
    else text = `${name}に届きました。今は返信が遅れるかもしれません`;
  } else if (expired) {
    text = `${name}は時間内に返信できませんでした`;
    activityHideTimer = setTimeout(() => { for (const [k, v] of activeRequests) if (v.state === 'expired') activeRequests.delete(k); renderMuseActivity(); }, 8000);
  }
  museActivity.innerHTML = `<span>${esc(text)}</span>${busy ? '<span class="dots"><i></i><i></i><i></i></span>' : ''}`;
  museActivity.classList.remove('hidden');
}
function handleMuseStatus(data) {
  if (!currentRoom || data.roomId !== currentRoom.id) return;
  if (data.presence && Array.isArray(currentRoom.muses) && data.seatId) {
    const s = currentRoom.muses.find(x => x.seatId === data.seatId);
    if (s) { s.presence = data.presence; renderMuseBar(); }
  }
  if (data.state === 'done') activeRequests.delete(data.requestId);
  else activeRequests.set(data.requestId, { state: data.state, type: data.requestType, name: data.name, presence: data.presence });
  renderMuseActivity();
}

// ---------- chat ----------
async function openRoom(roomId) {
  const detail = await api(`/api/rooms/${roomId}`);
  currentRoom = detail;
  $('#chat-title').textContent = detail.name;
  activeRequests = new Map((detail.museActivity || []).map(a => [a.requestId, { state: a.state, type: a.type, name: a.name }]));
  renderMuseBar();
  renderMuseActivity();
  const me = (detail.members || []).find(x => x.id === profile.id);
  const myLastRead = me ? (me.lastReadSeq || 0) : 0;
  const msgs = await api(`/api/rooms/${roomId}/messages`);
  const firstUnread = msgs.find(m => (m.seq || 0) > myLastRead && m.senderId !== profile.id && m.type !== 'system');
  unreadStartSeq = firstUnread ? firstUnread.seq : 0;
  renderAllMessages(msgs);
  clearPendingImages();
  restoreDraft(roomId);
  show('#view-chat');
  const sep = document.querySelector('.unread-sep');
  if (sep) sep.scrollIntoView({ block: 'start' }); else scrollChat();
  if (document.visibilityState === 'visible') await api(`/api/rooms/${roomId}/read`, { method: 'POST' });
  refreshBell();
}
function renderAllMessages(msgs) {
  $('#message-list').innerHTML = '';
  chatMessages = [];
  for (const m of msgs) appendMessage(m);
  updateReadReceipts();
}
const lastSeq = () => chatMessages.reduce((a, m) => Math.max(a, m.seq || 0), 0);
const findMsg = (msgId) => chatMessages.find(x => x.id === msgId);
const isMuseSender = (m) => m.senderId === 'kapio' || String(m.senderId || '').startsWith('muse:');
function canUnsend(m) {
  if (!m || m.type === 'system' || m.type === 'unsent') return false;
  const ownsLegacyKapio = m.senderId === 'kapio' && currentRoom?.createdBy === profile.id;
  if (m.senderId !== profile.id && m.senderId !== `muse:${profile.id}` && !ownsLegacyKapio) return false;
  return Date.now() - Date.parse(m.createdAt) <= UNSEND_WINDOW_MS;
}
function quoteHtml(m) {
  if (!m.replyTo) return '';
  const orig = findMsg(m.replyTo);
  let text = '元のメッセージ';
  if (orig) text = orig.type === 'unsent' ? '取り消されたメッセージ' : `${orig.senderName}: ${orig.body || (orig.image ? '画像' : '')}`;
  return `<div class="msg-quote" data-jump="${esc(m.replyTo)}">${esc(text.slice(0, 40))}</div>`;
}
function renderMessage(m) {
  if (m.type === 'system' || m.type === 'unsent') {
    const div = document.createElement('div');
    div.className = 'msg-system';
    if (m.id) div.dataset.msgId = m.id;
    div.textContent = m.type === 'unsent' ? `${m.senderName}が送信を取り消しました` : m.body;
    return div;
  }
  const isMe = m.senderId === profile.id;
  const isKapio = isMuseSender(m);
  const member = currentRoom?.members.find(x => x.id === m.senderId);
  const row = document.createElement('div');
  row.className = 'msg-row' + (isMe ? ' me' : '') + (isKapio ? ' kapio' : '');
  if (m.id) row.dataset.msgId = m.id;
  row.innerHTML = `
    ${isMe ? '' : `<div class="avatar" style="background:${esc(isKapio ? '#d4a017' : (member?.color || '#888'))}">${esc((m.senderName || '?').slice(0, 1))}</div>`}
    <div class="msg-body">
      ${isMe ? '' : `<div class="msg-name">${esc(m.senderName)}${isKapio ? '（Muse）' : ''}</div>`}
      <div class="msg-bubble">${quoteHtml(m)}${m.image ? `<img class="msg-image" src="${esc(m.image)}" alt="画像">` : ''}${m.body ? `<span>${esc(m.body)}</span>` : ''}</div>
      <div class="msg-foot">${isMe ? `<span class="msg-read" id="read-${esc(m.id)}"></span>` : ''}<span class="msg-time">${fmtTime(m.createdAt)}${m.editedAt ? '（更新）' : ''}</span></div>
    </div>`;
  const img = row.querySelector('.msg-image');
  if (img) img.addEventListener('click', () => { $('#lightbox-img').src = m.image; $('#lightbox').classList.remove('hidden'); });
  const quote = row.querySelector('.msg-quote');
  if (quote) quote.addEventListener('click', () => jumpTo(m.replyTo));
  attachLongPress(row.querySelector('.msg-bubble'), m.id);
  return row;
}
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const dayLabel = (iso) => new Date(iso).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
function appendMessage(m) {
  const list = $('#message-list');
  if (m.id && list.querySelector(`[data-msg-id="${CSS.escape(m.id)}"]`)) return;
  if (m.deleted) return;
  const prev = chatMessages[chatMessages.length - 1];
  if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) {
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.innerHTML = `<span>${esc(dayLabel(m.createdAt))}</span>`;
    list.appendChild(sep);
  }
  if (unreadStartSeq && m.seq === unreadStartSeq && !list.querySelector('.unread-sep')) {
    const sep = document.createElement('div');
    sep.className = 'unread-sep';
    sep.textContent = 'ここから未読';
    list.appendChild(sep);
  }
  chatMessages.push(m);
  list.appendChild(renderMessage(m));
  if (m.senderId === profile.id) updateReadReceipts();
}
function replaceMessage(m) {
  const list = $('#message-list');
  const old = list.querySelector(`[data-msg-id="${CSS.escape(m.id)}"]`);
  const idx = chatMessages.findIndex(x => x.id === m.id);
  if (m.deleted) {
    if (old) old.remove();
    if (idx >= 0) chatMessages.splice(idx, 1);
    return;
  }
  if (idx >= 0) chatMessages[idx] = m;
  if (old) old.replaceWith(renderMessage(m));
  // この発言を引用しているリプライも描き直す
  for (const r of chatMessages.filter(x => x.replyTo === m.id)) {
    const el = list.querySelector(`[data-msg-id="${CSS.escape(r.id)}"]`);
    if (el) el.replaceWith(renderMessage(r));
  }
  updateReadReceipts();
}
function jumpTo(msgId) {
  const el = $('#message-list').querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1200);
}
function updateReadReceipts() {
  if (!currentRoom || !profile) return;
  const others = (currentRoom.members || []).filter(x => !x.isMuse && x.id !== profile.id);
  if (!others.length) return;
  for (const m of chatMessages) {
    if (m.senderId !== profile.id) continue;
    const el = document.getElementById('read-' + m.id);
    if (!el) continue;
    const readers = others.filter(x => (x.lastReadSeq || 0) >= (m.seq || 0)).length;
    el.textContent = readers === 0 ? '' : (readers >= others.length ? '既読' : `既読 ${readers}`);
  }
}
function scrollChat() { const l = $('#message-list'); l.scrollTop = l.scrollHeight; }
// 切断中に届いた分を取りに行く
async function syncMissed() {
  if (!currentRoom || $('#view-chat').classList.contains('hidden')) return;
  try {
    const roomId = currentRoom.id;
    const [msgs, detail] = await Promise.all([
      api(`/api/rooms/${roomId}/messages?after=${lastSeq()}`),
      api(`/api/rooms/${roomId}`),
    ]);
    if (!currentRoom || currentRoom.id !== roomId) return;
    currentRoom = detail;
    activeRequests = new Map((detail.museActivity || []).map(a => [a.requestId, { state: a.state, type: a.type, name: a.name }]));
    renderMuseBar();
    renderMuseActivity();
    for (const m of msgs) appendMessage(m);
    updateReadReceipts();
    if (msgs.length) scrollChat();
    if (document.visibilityState === 'visible') api(`/api/rooms/${roomId}/read`, { method: 'POST' }).catch(() => {});
  } catch { /* retry on next reconnect */ }
}
// ---------- long press menu (copy / unsend) ----------
const sheet = document.createElement('div');
sheet.className = 'sheet hidden';
sheet.innerHTML = `<div class="sheet-card">
  <button data-act="reply">返信</button>
  <button data-act="copy">コピー</button>
  <button data-act="unsend" class="danger">送信取消</button>
  <button data-act="cancel">キャンセル</button>
</div>`;
document.body.appendChild(sheet);
let sheetMsgId = null;
function openSheet(msgId) {
  const m = findMsg(msgId);
  if (!m) return;
  sheetMsgId = msgId;
  const canReply = m.type !== 'system' && m.type !== 'unsent';
  sheet.querySelector('[data-act="reply"]').classList.toggle('hidden', !canReply);
  sheet.querySelector('[data-act="copy"]').classList.toggle('hidden', !m.body);
  sheet.querySelector('[data-act="unsend"]').classList.toggle('hidden', !canUnsend(m));
  if (!canReply && !m.body && !canUnsend(m)) return;
  sheet.classList.remove('hidden');
}
function closeSheet() { sheet.classList.add('hidden'); sheetMsgId = null; }
sheet.addEventListener('click', async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (e.target === sheet || act === 'cancel') { closeSheet(); return; }
  const m = findMsg(sheetMsgId);
  closeSheet();
  if (!m) return;
  if (act === 'reply') {
    setReplyTarget(m, true);
  } else if (act === 'copy') {
    try { await navigator.clipboard.writeText(m.body); } catch { /* ignore */ }
  } else if (act === 'unsend') {
    const museHere = (currentRoom?.muses || []).length > 0;
    const note = museHere ? '\nMuseがすでに読んでいた場合、Muse側の記憶からは消せません。' : '';
    if (!confirm(`送信を取り消しますか？\n全員の画面から消えます。${note}`)) return;
    try {
      const updated = await api(`/api/messages/${m.id}/unsend`, { method: 'POST', body: '{}' });
      replaceMessage(updated);
    } catch (err) { alert(err.message); }
  }
});
function attachLongPress(el, msgId) {
  if (!el) return;
  let timer = null, sx = 0, sy = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { timer = null; if (navigator.vibrate) navigator.vibrate(10); openSheet(msgId); }, 450);
  });
  el.addEventListener('pointermove', (e) => { if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancel(); });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); openSheet(msgId); });
}

// ---------- reply target + drafts (v4.2) ----------
function setReplyTarget(m, focus = false) {
  replyTargetId = m ? m.id : null;
  const bar = $('#reply-bar');
  if (!m) { bar.classList.add('hidden'); }
  else {
    $('#reply-bar-text').textContent = `返信: ${m.senderName}: ${(m.body || (m.image ? '画像' : '')).slice(0, 40)}`;
    bar.classList.remove('hidden');
    if (focus) $('#composer-input').focus();
  }
  saveDraft();
}
$('#reply-bar-cancel').addEventListener('click', () => setReplyTarget(null));
function loadDrafts() { try { return JSON.parse(localStorage.getItem('mc_drafts') || '{}'); } catch { return {}; } }
function saveDraft() {
  if (!currentRoom) return;
  const drafts = loadDrafts();
  const text = $('#composer-input').value;
  if (text || replyTargetId) drafts[currentRoom.id] = { text, replyTo: replyTargetId };
  else delete drafts[currentRoom.id];
  try { localStorage.setItem('mc_drafts', JSON.stringify(drafts)); } catch { /* ignore */ }
}
function clearDraft(roomId) {
  const drafts = loadDrafts();
  delete drafts[roomId];
  try { localStorage.setItem('mc_drafts', JSON.stringify(drafts)); } catch { /* ignore */ }
}
function restoreDraft(roomId) {
  const d = loadDrafts()[roomId];
  const ta = $('#composer-input');
  ta.value = d ? (d.text || '') : '';
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
  replyTargetId = null;
  $('#reply-bar').classList.add('hidden');
  if (d && d.replyTo) { const m = findMsg(d.replyTo); if (m) setReplyTarget(m); }
}

// ---------- send ----------
let sending = false;
async function sendCurrent() {
  const ta = $('#composer-input');
  const body = ta.value.trim();
  if (!currentRoom || sending || (!body && !pendingImages.length)) return;
  const roomId = currentRoom.id;
  const replyTo = replyTargetId;
  if (pendingImages.length) {
    sending = true;
    $('#send-btn').disabled = true;
    const images = pendingImages.slice();
    clearPendingImages();
    ta.value = '';
    ta.style.height = 'auto';
    setReplyTarget(null);
    clearDraft(roomId);
    try {
      for (let i = 0; i < images.length; i++) {
        const payload = { image: images[i] };
        if (i === 0) { if (body) payload.body = body; if (replyTo) payload.replyTo = replyTo; }
        const m = await api(`/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
        if (currentRoom && currentRoom.id === roomId) { appendMessage(m); scrollChat(); }
      }
    } catch (e) {
      alert('画像の送信に失敗しました: ' + e.message);
    } finally {
      sending = false;
      $('#send-btn').disabled = false;
    }
    return;
  }
  ta.value = '';
  ta.style.height = 'auto';
  setReplyTarget(null);
  clearDraft(roomId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'send', roomId, body, ...(replyTo ? { replyTo } : {}) }));
  } else {
    api(`/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ body, ...(replyTo ? { replyTo } : {}) }) })
      .then(m => { appendMessage(m); scrollChat(); })
      .catch(e => { ta.value = body; saveDraft(); alert('送信できませんでした: ' + e.message); });
  }
}

// ---------- image attach ----------
const MAX_PENDING_IMAGES = 4;
function renderPendingImages() {
  const bar = $('#image-preview');
  const wrap = $('#image-thumbs');
  if (!bar || !wrap) return;
  wrap.innerHTML = '';
  pendingImages.forEach((src, i) => {
    const t = document.createElement('div');
    t.className = 'img-thumb';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '添付画像';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'img-thumb-x';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'この画像を外す');
    x.addEventListener('click', () => { pendingImages.splice(i, 1); renderPendingImages(); });
    t.appendChild(img);
    t.appendChild(x);
    wrap.appendChild(t);
  });
  $('#image-preview-note').textContent = pendingImages.length > 1 ? `${pendingImages.length}枚の画像を送信します` : 'この画像を送信します';
  bar.classList.toggle('hidden', pendingImages.length === 0);
  const input = $('#image-input');
  if (input) input.value = '';
}
function clearPendingImages() {
  pendingImages = [];
  renderPendingImages();
}
function downscaleToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max = 1280;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}
$('#image-btn').addEventListener('click', () => $('#image-input').click());
$('#image-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const file of files) {
    if (pendingImages.length >= MAX_PENDING_IMAGES) { alert(`画像は一度に${MAX_PENDING_IMAGES}枚までです`); break; }
    try { pendingImages.push(await downscaleToDataUrl(file)); }
    catch { alert('画像を読み込めませんでした'); }
  }
  renderPendingImages();
});
$('#image-preview-remove').addEventListener('click', clearPendingImages);
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
$('#send-btn').addEventListener('click', sendCurrent);
$('#composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCurrent(); }
});
$('#composer-input').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; saveDraft(); });
$('#back-btn').addEventListener('click', () => { currentRoom = null; activeRequests = new Map(); renderMuseActivity(); show('#view-rooms'); loadRooms(); });
$('#call-kapio-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  try { await api(`/api/rooms/${currentRoom.id}/call-kapio`, { method: 'POST' }); }
  catch (e) { alert(e.message); }
});
$('#summary-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  if (!currentRoom.kapioEnabled) { alert('このルームにはMuseが同席していません'); return; }
  try { await api(`/api/rooms/${currentRoom.id}/summary-request`, { method: 'POST' }); }
  catch (e) { alert(e.message); }
});

// ---------- room settings ----------
$('#room-settings-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  const detail = await api(`/api/rooms/${currentRoom.id}`);
  currentRoom = detail;
  $('#settings-name').value = detail.name;
  $('#settings-code').textContent = detail.inviteCode;
  $('#settings-link').value = `${location.origin}/join/${detail.inviteCode}`;
  const seats = detail.muses || [];
  const memberNames = detail.members.map(m => {
    if (!m.isMuse) return m.name;
    const seat = seats.find(s => s.seatId === m.id);
    return seat && seat.ownerName ? `${m.name}（${seat.ownerName}さんのMuse）` : `${m.name}（Muse）`;
  });
  for (const s of seats) {
    if (!detail.members.some(m => m.id === s.seatId)) memberNames.push(s.ownerName ? `${s.name}（${s.ownerName}さんのMuse）` : `${s.name}（Muse）`);
  }
  $('#settings-members').textContent = memberNames.join('、');
  $('#muse-seat-status').textContent = !seats.length
    ? 'Museは同席していません'
    : seats.map(s => s.ownerId ? `${s.name}（${s.ownerName || ''}さんのMuse）` : s.name).join('、') + ' が同席中です';
  const mine = seats.find(s => s.ownerId === profile.id);
  $('#muse-mine-area').classList.toggle('hidden', !mine);
  $('#muse-claim-area').classList.toggle('hidden', !!mine);
  if (mine) {
    try { const t = await api('/api/me/bridge-token', { method: 'POST', body: '{}' }); $('#muse-token-input').value = t.bridgeToken; $('#muse-prompt').value = buildBridgePrompt(t.bridgeToken); } catch { /* ignore */ }
  }
  $('#settings-kapio-mode').value = detail.kapioMode;
  $('#settings-summary').textContent = detail.lastSummary || 'まだ要約はありません。「📋 会話を要約」を押すとMuseが作ります。';
  renderDecisions(detail.decisions || []);
  openModal('#modal-settings');
});
function renderDecisions(decisions) {
  const ul = $('#decision-list');
  ul.innerHTML = '';
  for (const d of decisions) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(d.text)}</span>`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      await api(`/api/rooms/${currentRoom.id}/decisions/${d.id}`, { method: 'DELETE' });
      li.remove();
    });
    li.appendChild(del);
    ul.appendChild(li);
  }
}
$('#decision-add-btn').addEventListener('click', async () => {
  const text = $('#decision-input').value.trim();
  if (!text || !currentRoom) return;
  await api(`/api/rooms/${currentRoom.id}/decisions`, { method: 'POST', body: JSON.stringify({ text }) });
  $('#decision-input').value = '';
  const detail = await api(`/api/rooms/${currentRoom.id}`);
  renderDecisions(detail.decisions || []);
});
$('#copy-link-btn').addEventListener('click', async () => {
  const input = $('#settings-link');
  input.select();
  try { await navigator.clipboard.writeText(input.value); alert('招待リンクをコピーしました'); }
  catch { document.execCommand('copy'); alert('招待リンクをコピーしました'); }
});
async function reloadCurrentRoom() {
  if (!currentRoom) return;
  const detail = await api(`/api/rooms/${currentRoom.id}`);
  currentRoom = detail;
  $('#chat-title').textContent = detail.name;
  renderMuseBar();
  const msgs = await api(`/api/rooms/${currentRoom.id}/messages`);
  renderAllMessages(msgs);
  scrollChat();
}
$('#muse-claim-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  const name = $('#muse-name-input').value.trim();
  try {
    await api(`/api/rooms/${currentRoom.id}/muse-claim`, { method: 'POST', body: JSON.stringify({ name }) });
    alert('あなたのMuseが同席するようになりました。設定に表示される「Museへの指示文」をコピーして、あなたのMuseに貼り付けてください。');
    $('#room-settings-btn').click();
    reloadCurrentRoom();
  } catch (e) { alert(e.message); }
});
$('#muse-release-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  try {
    await api(`/api/rooms/${currentRoom.id}/muse-release`, { method: 'POST', body: '{}' });
    $('#room-settings-btn').click();
    reloadCurrentRoom();
  } catch (e) { alert(e.message); }
});
$('#muse-token-copy').addEventListener('click', async () => {
  const input = $('#muse-token-input');
  input.select();
  try { await navigator.clipboard.writeText(input.value); alert('連携トークンをコピーしました'); }
  catch { document.execCommand('copy'); alert('連携トークンをコピーしました'); }
});
$('#muse-prompt-copy').addEventListener('click', async () => {
  const input = $('#muse-prompt');
  input.select();
  try { await navigator.clipboard.writeText(input.value); alert('Museへの指示文をコピーしました'); }
  catch { document.execCommand('copy'); alert('Museへの指示文をコピーしました'); }
});
// 自分のMuseにそのまま貼れる指示文（トークン・URL・自分の席の名前入り）
function buildBridgePrompt(token) {
  const seat = (currentRoom?.muses || []).find(s => s.ownerId === profile.id);
  const museName = seat ? seat.name : 'Muse';
  const roomName = currentRoom ? currentRoom.name : '';
  const origin = location.origin;
  return `あなたはチャットアプリ「Muse対応チャット」のルーム「${roomName}」に、${museName}（${profile.name}さんのMuse）として同席します。人間と同じように会話に参加し、呼ばれたら返信してください。

【接続情報】
連携トークン: ${token}
APIのベースURL: ${origin}

【見張り方（即時返信のために必須）】
GET ${origin}/api/bridge/wait?timeout=25
ヘッダー: Authorization: Bearer ${token}
依頼が来ると即座に pending が返ります。空で返ったら、間を空けずに同じリクエストを繰り返し続けてください（これで「在席」になり、呼ばれてから数秒で返信できます）。長ポーリングを維持できない環境では、GET ${origin}/api/bridge/pending を短い間隔で確認してください。

【依頼の形式】
各依頼: request_id / type（reply=返信、summary=要約）/ room_name / muse_name（あなたの名前）/ trigger（きっかけの発言）/ context（直近の会話）/ decisions / summary。有効期限は30分です。

【返信のしかた】
POST ${origin}/api/bridge/reply（ヘッダー: Authorization: Bearer ${token}、Content-Type: application/json）
本文: {"request_id": "依頼のID", "body": "返信文"}
・時間がかかる返信は、先に {"request_id": "...", "body": "ひと言", "partial": true} を送ると吹き出しが先に出て、完成版を partial なしで送ると書き換わります。
・考えている間は POST ${origin}/api/bridge/typing {"request_id": "..."} を20秒おきに呼ぶと「考え中」と表示されます。
・返信が不要な依頼は POST ${origin}/api/bridge/dismiss {"request_id": "..."} で閉じてください。
・type が summary の依頼では body に要約を入れ、決まったことがあれば decisions（文字列の配列）も付けてください。

【注意】
・このトークンはあなたの席専用です。他人に教えないでください。
・発言は「${museName}」の名前で投稿されます。
・流れに合わない呼びかけには無理に返さず dismiss して構いません。`;
}
$('#settings-save').addEventListener('click', async (e) => {
  if (!currentRoom) return;
  try {
    await api(`/api/rooms/${currentRoom.id}/settings`, {
      method: 'POST',
      body: JSON.stringify({ name: $('#settings-name').value.trim(), kapioMode: $('#settings-kapio-mode').value }),
    });
    closeModal(e.target);
    reloadCurrentRoom();
  } catch (err) { alert('保存できませんでした: ' + err.message); }
});

// ---------- notifications ----------
async function refreshBell() {
  if (!profile) return;
  try {
    const { unreadTotal } = await api('/api/notifications');
    const badge = $('#bell-badge');
    badge.textContent = unreadTotal;
    badge.classList.toggle('hidden', unreadTotal === 0);
  } catch { /* ignore */ }
}
$('#bell-btn').addEventListener('click', async () => {
  const { notifications } = await api('/api/notifications');
  const ul = $('#notification-list');
  ul.innerHTML = '';
  $('#notif-empty').classList.toggle('hidden', notifications.length > 0);
  for (const n of notifications) {
    const li = document.createElement('li');
    li.className = 'notif-item' + (n.read ? '' : ' unread');
    li.innerHTML = `<div class="n-room">${esc(n.roomName)}</div><div class="n-body">${esc(n.senderName)}: ${esc(n.preview)}</div><div class="n-time">${fmtTime(n.createdAt)}</div>`;
    li.addEventListener('click', () => openRoom(n.roomId));
    ul.appendChild(li);
  }
  show('#view-notifications');
});
$('#notif-back-btn').addEventListener('click', () => { show('#view-rooms'); loadRooms(); refreshBell(); });
$('#notif-readall-btn').addEventListener('click', async () => {
  await api('/api/notifications/read-all', { method: 'POST' });
  refreshBell();
  $('#bell-btn').click();
});
$('#enable-notif-btn').addEventListener('click', async () => {
  if (!('Notification' in window)) { alert('このブラウザは通知に対応していません'); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') { await subscribePush(); alert('通知を許可しました。閉じている間もプッシュで届きます'); }
  else alert('通知は許可されませんでした');
});

// ---------- WebSocket ----------
function connectWs() {
  if (!profile || wsConnecting || (ws && ws.readyState <= 1)) return;
  wsConnecting = true;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(profile.token)}`);
  ws = sock;
  sock.onopen = () => {
    wsConnecting = false;
    setConnected(true);
    syncMissed();
    if (!$('#view-rooms').classList.contains('hidden')) loadRooms().catch(() => {});
    refreshBell();
  };
  sock.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const inThisRoom = currentRoom && data.roomId === currentRoom.id && !$('#view-chat').classList.contains('hidden');
    if (data.type === 'message') {
      if (inThisRoom) {
        appendMessage(data.message);
        scrollChat();
        if (isMuseSender(data.message)) { for (const [k, v] of activeRequests) if (v.state !== 'expired') activeRequests.delete(k); renderMuseActivity(); }
        // 画面を見ていない間は既読にしない
        if (document.visibilityState === 'visible') api(`/api/rooms/${data.roomId}/read`, { method: 'POST' }).catch(() => {});
      } else if (!$('#view-rooms').classList.contains('hidden')) {
        loadRooms().catch(() => {});
      }
      refreshBell();
    } else if (data.type === 'message_updated') {
      if (inThisRoom) replaceMessage(data.message);
      else if (!$('#view-rooms').classList.contains('hidden')) loadRooms().catch(() => {});
    } else if (data.type === 'read') {
      if (currentRoom && data.roomId === currentRoom.id) {
        const mem = (currentRoom.members || []).find(x => x.id === data.profileId);
        if (mem) mem.lastReadSeq = data.lastReadSeq;
        updateReadReceipts();
      }
    } else if (data.type === 'muse_status') {
      handleMuseStatus(data);
    } else if (data.type === 'muse_presence') {
      if (currentRoom && data.roomId === currentRoom.id && Array.isArray(currentRoom.muses)) {
        const s = currentRoom.muses.find(x => x.seatId === data.seatId);
        if (s) { s.presence = data.presence; renderMuseBar(); }
      }
    } else if (data.type === 'notification') {
      refreshBell();
      // プッシュ通知が有効なら、二重に出さない
      if (!inThisRoom && !pushActive && document.visibilityState === 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(data.notification.roomName, { body: `${data.notification.senderName}: ${data.notification.preview}`, icon: '/icon.svg' }); } catch { /* ignore */ }
      }
    }
  };
  sock.onclose = () => {
    wsConnecting = false;
    if (ws === sock) ws = null;
    setConnected(false);
    setTimeout(() => { if (profile) connectWs(); }, 3000);
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !profile) return;
  if (!ws || ws.readyState > 1) connectWs();
  else syncMissed();
});

// 通知タップ（Service Workerから）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open-room' && e.data.roomId && profile) openRoom(e.data.roomId).catch(() => {});
  });
}

// ---------- init ----------
async function boot() {
  try {
    await api('/api/me');
    setConnected(true);
    afterLogin();
  } catch (e) {
    if (e.status === 401) {
      // トークンが本当に無効なときだけ作り直す（通信エラーでは消さない）
      profile = null;
      localStorage.removeItem('mc_profile');
      show('#view-setup');
      return;
    }
    show('#view-rooms');
    setConnected(false);
    setTimeout(boot, 5000);
  }
}
(async function init() {
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('/sw.js'); } catch { /* ignore */ } }
  if (pendingJoinCode && !profile) {
    try {
      const info = await api(`/api/join/${pendingJoinCode}`);
      const n = $('#join-notice');
      n.textContent = `「${info.name}」に招待されています。表示名を決めると参加できます。`;
      n.classList.remove('hidden');
    } catch { /* ignore */ }
  }
  if (profile) { boot(); return; }
  show('#view-setup');
})();
