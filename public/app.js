'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), n = new Date();
  const hm = d.toLocaleTimeString('ja-JP', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

let profile = null;
try { profile = JSON.parse(localStorage.getItem('mc_profile') || 'null'); } catch { profile = null; }
let ws = null;
let currentRoom = null;
let roomsCache = [];
let pendingImage = null;
let chatMessages = [];
const joinMatch = location.pathname.match(/^\/join\/([A-Za-z0-9]+)/);
let pendingJoinCode = joinMatch ? joinMatch[1].toUpperCase() : null;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (profile) headers.Authorization = `Bearer ${profile.token}`;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
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
        <div class="room-name">${esc(r.name)}${r.kapioEnabled ? '<span title="カピお同席中">🍸</span>' : ''}</div>
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
$('#me-btn').addEventListener('click', () => { $('#me-name').textContent = profile.name; openModal('#modal-me'); });

// ---------- chat ----------
async function openRoom(roomId) {
  const detail = await api(`/api/rooms/${roomId}`);
  currentRoom = detail;
  $('#chat-title').textContent = detail.name;
  const seat = detail.museSeat || { active: detail.kapioEnabled, name: 'カピお' };
  $('#kapio-bar').classList.toggle('hidden', !seat.active);
  if (seat.active) {
    $('#kapio-status').textContent = detail.kapioMode === 'auto' ? `🍸 ${seat.name}（Muse）同席中（自動で口を出します）` : `🍸 ${seat.name}（Muse）同席中（「${seat.name}」と呼ぶと返信）`;
    $('#call-kapio-btn').textContent = `${seat.name}を呼ぶ`;
  }
  const msgs = await api(`/api/rooms/${roomId}/messages`);
  const list = $('#message-list');
  list.innerHTML = '';
  chatMessages = [];
  clearPendingImage();
  for (const m of msgs) appendMessage(m);
  list.scrollTop = list.scrollHeight;
  updateReadReceipts();
  show('#view-chat');
  await api(`/api/rooms/${roomId}/read`, { method: 'POST' });
  refreshBell();
}
function appendMessage(m) {
  const list = $('#message-list');
  if (m.id && list.querySelector(`[data-msg-id="${m.id}"]`)) return;
  if (m.type === 'system') {
    const div = document.createElement('div');
    div.className = 'msg-system';
    if (m.id) div.dataset.msgId = m.id;
    div.textContent = m.body;
    list.appendChild(div);
    return;
  }
  chatMessages.push(m);
  const isMe = m.senderId === profile.id;
  const isKapio = m.senderId === 'kapio' || String(m.senderId || '').startsWith('muse:');
  const member = currentRoom?.members.find(x => x.id === m.senderId);
  const row = document.createElement('div');
  row.className = 'msg-row' + (isMe ? ' me' : '') + (isKapio ? ' kapio' : '');
  if (m.id) row.dataset.msgId = m.id;
  row.innerHTML = `
    ${isMe ? '' : `<div class="avatar" style="background:${esc(member?.color || '#888')}">${esc((m.senderName || '?').slice(0, 1))}</div>`}
    <div class="msg-body">
      ${isMe ? '' : `<div class="msg-name">${esc(m.senderName)}${isKapio ? '（Muse）' : ''}</div>`}
      <div class="msg-bubble">${m.image ? `<img class="msg-image" src="${esc(m.image)}" alt="画像">` : ''}${m.body ? `<span>${esc(m.body)}</span>` : ''}</div>
      <div class="msg-foot">${isMe ? `<span class="msg-read" id="read-${esc(m.id)}"></span>` : ''}<span class="msg-time">${fmtTime(m.createdAt)}</span></div>
    </div>`;
  const img = row.querySelector('.msg-image');
  if (img) img.addEventListener('click', () => { $('#lightbox-img').src = m.image; $('#lightbox').classList.remove('hidden'); });
  list.appendChild(row);
  if (isMe) updateReadReceipts();
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

function sendCurrent() {
  const ta = $('#composer-input');
  const body = ta.value.trim();
  if (!currentRoom || (!body && !pendingImage)) return;
  ta.value = '';
  ta.style.height = 'auto';
  if (pendingImage) {
    const image = pendingImage;
    clearPendingImage();
    api(`/api/rooms/${currentRoom.id}/messages`, { method: 'POST', body: JSON.stringify({ body, image }) })
      .then(m => { appendMessage(m); scrollChat(); })
      .catch(e => alert('画像の送信に失敗しました: ' + e.message));
    return;
  }
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'send', roomId: currentRoom.id, body }));
  } else {
    api(`/api/rooms/${currentRoom.id}/messages`, { method: 'POST', body: JSON.stringify({ body }) })
      .then(m => { appendMessage(m); scrollChat(); });
  }
}

// ---------- image attach ----------
function clearPendingImage() {
  pendingImage = null;
  const bar = $('#image-preview');
  if (bar) bar.classList.add('hidden');
  const img = $('#image-preview-img');
  if (img) img.removeAttribute('src');
  const input = $('#image-input');
  if (input) input.value = '';
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
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    pendingImage = await downscaleToDataUrl(file);
    $('#image-preview-img').src = pendingImage;
    $('#image-preview').classList.remove('hidden');
  } catch { alert('画像を読み込めませんでした'); }
});
$('#image-preview-remove').addEventListener('click', clearPendingImage);
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.add('hidden'));
$('#send-btn').addEventListener('click', sendCurrent);
$('#composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendCurrent(); }
});
$('#composer-input').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; });
$('#back-btn').addEventListener('click', () => { currentRoom = null; show('#view-rooms'); loadRooms(); });
$('#call-kapio-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  try {
    await api(`/api/rooms/${currentRoom.id}/call-kapio`, { method: 'POST' });
    alert(`${currentRoom.museSeat?.name || 'Muse'}を呼びました。少し待つと返信が来ます。`);
  } catch (e) { alert(e.message); }
});
$('#summary-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  if (!currentRoom.kapioEnabled) { alert('このルームにはMuseが同席していません'); return; }
  try {
    await api(`/api/rooms/${currentRoom.id}/summary-request`, { method: 'POST' });
    alert('Museに要約を頼みました。できたらこのルームに投稿されます。');
  } catch (e) { alert(e.message); }
});

// ---------- room settings ----------
$('#room-settings-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  const detail = await api(`/api/rooms/${currentRoom.id}`);
  currentRoom = detail;
  $('#settings-name').value = detail.name;
  $('#settings-code').textContent = detail.inviteCode;
  $('#settings-link').value = `${location.origin}/join/${detail.inviteCode}`;
  $('#settings-members').textContent = detail.members.map(m => m.name).join('、');
  const seat = detail.museSeat || { active: detail.kapioEnabled, name: 'カピお', ownerId: null, ownerName: null };
  $('#muse-seat-status').textContent = !seat.active
    ? 'Museは同席していません'
    : seat.ownerId
      ? `${seat.name}（${seat.ownerName || ''}さんのMuse）が同席中です`
      : `${seat.name}が同席中です`;
  const mine = !!seat.ownerId && seat.ownerId === profile.id;
  $('#muse-mine-area').classList.toggle('hidden', !mine);
  $('#muse-claim-area').classList.toggle('hidden', mine);
  if (mine) {
    try { const t = await api('/api/me/bridge-token', { method: 'POST', body: '{}' }); $('#muse-token-input').value = t.bridgeToken; } catch { /* ignore */ }
  }
  $('#settings-kapio-mode').value = detail.kapioMode;
  $('#settings-summary').textContent = detail.lastSummary || 'まだ要約はありません。「📋 会話を要約」を押すとカピおが作ります。';
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
  const d = await api(`/api/rooms/${currentRoom.id}/decisions`, { method: 'POST', body: JSON.stringify({ text }) });
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
$('#muse-claim-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  const name = $('#muse-name-input').value.trim();
  try {
    await api(`/api/rooms/${currentRoom.id}/muse-claim`, { method: 'POST', body: JSON.stringify({ name }) });
    alert('あなたのMuseが同席するようになりました。設定に表示される連携トークンを、あなたのClaude（Muse）に渡してください。');
    $('#room-settings-btn').click();
    const msgs = await api(`/api/rooms/${currentRoom.id}/messages`);
    const list = $('#message-list');
    list.innerHTML = '';
    chatMessages = [];
    for (const m of msgs) appendMessage(m);
    scrollChat();
  } catch (e) { alert(e.message); }
});
$('#muse-release-btn').addEventListener('click', async () => {
  if (!currentRoom) return;
  try {
    await api(`/api/rooms/${currentRoom.id}/muse-release`, { method: 'POST', body: '{}' });
    $('#room-settings-btn').click();
  } catch (e) { alert(e.message); }
});
$('#muse-token-copy').addEventListener('click', async () => {
  const input = $('#muse-token-input');
  input.select();
  try { await navigator.clipboard.writeText(input.value); alert('連携トークンをコピーしました'); }
  catch { document.execCommand('copy'); alert('連携トークンをコピーしました'); }
});
$('#settings-save').addEventListener('click', async (e) => {
  if (!currentRoom) return;
  const updated = await api(`/api/rooms/${currentRoom.id}/settings`, {
    method: 'POST',
    body: JSON.stringify({ name: $('#settings-name').value.trim(), kapioMode: $('#settings-kapio-mode').value }),
  });
  currentRoom = { ...currentRoom, ...updated };
  $('#chat-title').textContent = updated.name;
  $('#kapio-bar').classList.toggle('hidden', !updated.kapioEnabled);
  closeModal(e.target);
  const msgs = await api(`/api/rooms/${currentRoom.id}/messages`);
  const list = $('#message-list');
  list.innerHTML = '';
  chatMessages = [];
  for (const m of msgs) appendMessage(m);
  scrollChat();
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
  if (!profile) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(profile.token)}`);
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.type === 'message') {
      if (currentRoom && data.roomId === currentRoom.id && !$('#view-chat').classList.contains('hidden')) {
        appendMessage(data.message);
        scrollChat();
        api(`/api/rooms/${data.roomId}/read`, { method: 'POST' }).catch(() => {});
      } else if (!$('#view-rooms').classList.contains('hidden')) {
        loadRooms();
      }
      refreshBell();
    } else if (data.type === 'read') {
      if (currentRoom && data.roomId === currentRoom.id) {
        const mem = (currentRoom.members || []).find(x => x.id === data.profileId);
        if (mem) mem.lastReadSeq = data.lastReadSeq;
        updateReadReceipts();
      }
    } else if (data.type === 'notification') {
      refreshBell();
      const viewing = currentRoom && data.roomId === currentRoom.id && !$('#view-chat').classList.contains('hidden');
      if (!viewing && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(data.notification.roomName, { body: `${data.notification.senderName}: ${data.notification.preview}`, icon: '/icon.svg' }); } catch { /* ignore */ }
      }
    }
  };
  ws.onclose = () => { setTimeout(() => { if (profile) connectWs(); }, 3000); };
}

// ---------- init ----------
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
  if (profile) {
    // validate token
    try { await api('/api/me'); afterLogin(); return; }
    catch { profile = null; localStorage.removeItem('mc_profile'); }
  }
  show('#view-setup');
})();
