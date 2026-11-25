'use strict';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// v4.12: エスケープ済み文字列の中のURLをリンク化する（末尾の日本語句読点・括弧や引用符はリンクに含めない）
const linkify = (s) => s.replace(/https?:\/\/[^\s<>"']+/g, (u) => {
  let url = u, tail = '';
  for (;;) {
    const m = url.match(/(?:[。、！？）」』】〕〉・…]+|&(?:quot|lt|gt|#39);)$/);
    if (!m) break;
    tail = m[0] + tail;
    url = url.slice(0, url.length - m[0].length);
  }
  return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="msg-link">${url}</a>` + tail;
});
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
let pendingPdfs = []; // v4.23: PDF添付 { name, data }（最大2件、各2MBまで）
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
  for (const v of ['#view-setup', '#view-rooms', '#view-chat', '#view-notifications', '#view-board']) $(v).classList.add('hidden');
  $(viewId).classList.remove('hidden');
}
function openModal(sel) { $(sel).classList.remove('hidden'); }
function closeModal(el) { el.closest('.modal').classList.add('hidden'); }
// v4.23: モーダルの外側（背景）をタップしたら、保存せずに閉じる。全モーダル共通の挙動
document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); }));
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
const museUnansweredPanel = document.createElement('div');
museUnansweredPanel.className = 'muse-unanswered-panel hidden';
$('#view-chat').insertBefore(museUnansweredPanel, $('#image-preview'));
let activeRequests = new Map(); // requestId -> { state, type }
let activityHideTimer = null;
let unansweredCounts = []; // v4.16: 席ごとの未回答件数 [{ seatId, ownerName, name, count }]
let unansweredList = []; // v4.16: 未回答一覧（席ごと・依頼つき）
let unansweredPanelOpen = false;

// ---------- v4.20: お知らせ（トーク欄に出さない告知） ----------
const noticesPanel = document.createElement('div');
noticesPanel.className = 'notices-panel hidden';
$('#view-chat').insertBefore(noticesPanel, $('#image-preview'));
let roomNotices = []; // 新しい順
let noticesPanelOpen = false;
function addNotice(m) {
  if (!m || !m.id || roomNotices.some(n => n.id === m.id)) return;
  roomNotices.unshift({ id: m.id, senderName: m.senderName, body: m.body || '', createdAt: m.createdAt });
  renderNotices();
}
function renderNotices() {
  const btn = $('#notices-btn');
  if (btn) btn.textContent = roomNotices.length ? `🆕${roomNotices.length}` : '🆕';
  if (!noticesPanelOpen || !roomNotices.length) {
    noticesPanel.classList.add('hidden');
    if (!roomNotices.length) noticesPanelOpen = false;
    return;
  }
  noticesPanel.innerHTML = roomNotices.map(n => `<div class="notice-item"><div class="notice-body">${esc(n.body || '')}</div><div class="notice-meta">${esc(n.senderName || '')} ・ ${esc(uaTime(n.createdAt))}</div></div>`).join('');
  noticesPanel.classList.remove('hidden');
}
$('#notices-btn').addEventListener('click', () => {
  noticesPanelOpen = !noticesPanelOpen;
  renderNotices();
});

// ---------- v4.23: 決めることボード（フェーズ1: 既存 db.tasks / db.decisions の表示のみ。データ構造は変更しない） ----------
// 表示の器はトークと並ぶ専用ビュー（#view-board）。中身（未決定／決まったこと／追加／バッジ）はパネル版から不変
let boardTasks = []; // そのルームの tasks 全件（done 含む）
let boardDecisions = []; // そのルームの decisions
let boardEditingId = null; // 備考を編集中のタスクID
let boardNoteDraft = ''; // 編集中の備考の下書き（再描画で消えないよう保持）
function boardOpenTasks() { return boardTasks.filter(t => !t.done); }
// v4.24: 回答期限（due: 'YYYY-MM-DD' | null）の表示ヘルパー。日付の前後判定は端末のローカル日付で行う
function boardTodayStr() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function boardDueInfo(t) { const due = (t && typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.due)) ? t.due : null; if (!due) return { due: null, label: '', cls: '', tag: '' }; const [, m, d] = due.split('-'); const label = `期限：${Number(m)}月${Number(d)}日`; const today = boardTodayStr(); const tom = new Date(); tom.setDate(tom.getDate() + 1); const p2 = (n) => String(n).padStart(2, '0'); const tomorrow = `${tom.getFullYear()}-${p2(tom.getMonth() + 1)}-${p2(tom.getDate())}`; if (due < today) return { due, label, cls: ' due-overdue', tag: '超過' }; if (due === today) return { due, label, cls: ' due-today', tag: '今日まで' }; if (due === tomorrow) return { due, label, cls: ' due-tomorrow', tag: '明日まで' }; return { due, label, cls: '', tag: '' }; }
function renderBoard() {
  const open = boardOpenTasks();
  for (const badge of [$('#board-badge'), $('#board-badge2')]) {
    if (badge) {
      badge.textContent = String(open.length);
      badge.classList.toggle('hidden', !open.length);
    }
  }
  const count = $('#board-count');
  if (count) count.textContent = `未決定 ${open.length}件`;
  const roomName = $('#board-room-name');
  if (roomName) roomName.textContent = currentRoom ? (currentRoom.name || '') : '';
  const list = $('#board-list');
  if (list) {
    list.innerHTML = open.length
      ? open.map(t => {
          const editing = boardEditingId === t.id;
          const noteBox = editing
            ? `<div class="board-note-edit"><textarea class="board-note-input" data-id="${esc(t.id)}" maxlength="500" rows="2" placeholder="どこで止まっているか／何が確認事項か／誰のタスクか">${esc(boardNoteDraft)}</textarea><div class="board-note-edit-btns"><button type="button" class="sub-btn board-note-save" data-id="${esc(t.id)}">保存</button><button type="button" class="sub-btn board-note-cancel">キャンセル</button></div></div>`
            : (t.note ? `<div class="board-note">📝 ${esc(t.note)}</div>` : '');
          const di = boardDueInfo(t);
          const dueBox = di.due ? `<div class="board-due${di.cls}">📅 ${esc(di.label)}${di.tag ? `（${esc(di.tag)}）` : ''}</div>` : '';
          return `<div class="board-item"><div class="board-row"><div class="board-main"><div class="board-text">${esc(t.text || '')}</div><div class="board-meta">${esc(t.createdByName || '')} ・ ${esc(uaTime(t.createdAt))}</div></div><div class="board-actions"><button type="button" class="sub-btn board-done-btn" data-id="${esc(t.id)}">完了</button><button type="button" class="sub-btn board-del-btn" data-id="${esc(t.id)}">✕</button></div></div>${dueBox}${noteBox}<div class="board-sub"><button type="button" class="sub-btn board-note-btn" data-id="${esc(t.id)}">📝 ${t.note ? '備考を編集' : '備考を書く'}</button><button type="button" class="sub-btn board-remind-btn${t.remind ? ' on' : ''}" data-id="${esc(t.id)}">🔔 リマインド ${t.remind ? 'ON' : 'OFF'}</button><label class="board-due-edit">📅 期限 <input type="date" class="board-due-input" data-id="${esc(t.id)}" value="${esc(di.due || '')}"></label>${di.due ? `<button type="button" class="sub-btn board-due-clear" data-id="${esc(t.id)}">期限を消す</button>` : ''}</div></div>`;
        }).join('')
      : '<div class="board-empty">未決定のものはありません。</div>';
    list.querySelectorAll('.board-done-btn').forEach(b => b.addEventListener('click', async () => {
      if (!currentRoom) return;
      try { await api(`/api/rooms/${currentRoom.id}/tasks/${b.dataset.id}/done`, { method: 'POST', body: '{}' }); await loadBoardData(); } catch { /* 次回表示時に再取得 */ }
    }));
    list.querySelectorAll('.board-del-btn').forEach(b => b.addEventListener('click', async () => {
      if (!currentRoom) return;
      try { await api(`/api/rooms/${currentRoom.id}/tasks/${b.dataset.id}`, { method: 'DELETE' }); await loadBoardData(); } catch { /* 次回表示時に再取得 */ }
    }));
    list.querySelectorAll('.board-note-btn').forEach(b => b.addEventListener('click', () => {
      const t = boardTasks.find(x => x.id === b.dataset.id);
      boardEditingId = b.dataset.id;
      boardNoteDraft = t ? (t.note || '') : '';
      renderBoard();
      const ta = list.querySelector('.board-note-input');
      if (ta) ta.focus();
    }));
    const noteInput = list.querySelector('.board-note-input');
    if (noteInput) noteInput.addEventListener('input', () => { boardNoteDraft = noteInput.value; });
    list.querySelectorAll('.board-note-save').forEach(b => b.addEventListener('click', async () => {
      if (!currentRoom) return;
      try {
        await api(`/api/rooms/${currentRoom.id}/tasks/${b.dataset.id}/update`, { method: 'POST', body: JSON.stringify({ note: boardNoteDraft }) });
        boardEditingId = null; boardNoteDraft = '';
        await loadBoardData();
      } catch { /* 次回表示時に再取得 */ }
    }));
    list.querySelectorAll('.board-note-cancel').forEach(b => b.addEventListener('click', () => {
      boardEditingId = null; boardNoteDraft = '';
      renderBoard();
    }));
    list.querySelectorAll('.board-remind-btn').forEach(b => b.addEventListener('click', async () => {
      if (!currentRoom) return;
      const t = boardTasks.find(x => x.id === b.dataset.id);
      if (!t) return;
      try { await api(`/api/rooms/${currentRoom.id}/tasks/${b.dataset.id}/update`, { method: 'POST', body: JSON.stringify({ remind: !t.remind }) }); await loadBoardData(); } catch { /* 次回表示時に再取得 */ }
    }));
    list.querySelectorAll('.board-due-input').forEach(inp => inp.addEventListener('change', async () => {
      if (!currentRoom) return;
      const v = inp.value ? inp.value : null;
      try { await api(`/api/rooms/${currentRoom.id}/tasks/${inp.dataset.id}/update`, { method: 'POST', body: JSON.stringify({ due: v }) }); await loadBoardData(); } catch { /* 次回表示時に再取得 */ }
    }));
    list.querySelectorAll('.board-due-clear').forEach(b => b.addEventListener('click', async () => {
      if (!currentRoom) return;
      try { await api(`/api/rooms/${currentRoom.id}/tasks/${b.dataset.id}/update`, { method: 'POST', body: JSON.stringify({ due: null }) }); await loadBoardData(); } catch { /* 次回表示時に再取得 */ }
    }));
  }
  const decided = $('#board-decided');
  if (decided) {
    decided.innerHTML = boardDecisions.length
      ? `<div class="board-decided-head">決まったこと</div>` + boardDecisions.map(d => `<div class="board-decided-item">✓ ${esc(d.text || '')}</div>`).join('')
      : '';
  }
}
async function loadBoardData() {
  if (!currentRoom) return;
  const detail = await api(`/api/rooms/${currentRoom.id}`);
  if (!currentRoom || detail.id !== currentRoom.id) return;
  currentRoom = detail;
  boardTasks = detail.tasks || [];
  boardDecisions = detail.decisions || [];
  renderTasks(boardTasks);
  renderDecisions(boardDecisions);
  renderBoard();
}
async function openBoard() {
  if (!currentRoom) return;
  renderBoard();
  show('#view-board');
  try { await loadBoardData(); } catch { /* 取得できなければ手元のデータで表示 */ }
}
$('#tab-board-btn').addEventListener('click', openBoard);
$('#tab-talk-btn').addEventListener('click', () => { if (currentRoom) show('#view-chat'); });
$('#board-back-btn').addEventListener('click', () => { if (currentRoom) show('#view-chat'); });
$('#board-add-btn').addEventListener('click', async () => {
  const input = $('#board-input');
  const text = input ? input.value.trim() : '';
  if (!text || !currentRoom) return;
  try {
    await api(`/api/rooms/${currentRoom.id}/tasks`, { method: 'POST', body: JSON.stringify({ text }) });
    input.value = '';
    await loadBoardData();
  } catch { /* 次回表示時に再取得 */ }
});

const PRESENCE_LABEL = {
  live: { dot: 'live', text: 'すぐ返信できます' },
  polling: { dot: 'polling', text: '返信まで数分かかります' },
  offline: { dot: 'offline', text: '今は返信が遅れるかもしれません' },
};
// v4.23: 同席中バーは廃止し、同席情報はメンバー一覧モーダル（#modal-members）に寄せた。
// renderMuseBar の名前は既存の呼び出し箇所（presence更新など）のために残し、中身はメンバー一覧の描画にする
function renderMuseBar() {
  const list = $('#members-list');
  if (!list || !currentRoom) return;
  const humans = (currentRoom.members || []).filter(m => !m.isMuse);
  const seats = currentRoom.muses || [];
  const how = currentRoom.kapioMode === 'auto' ? '会話を見て自動で返信' : '名前を呼ばれたときだけ返信';
  let html = '<div class="members-head">参加者</div>';
  html += humans.length
    ? humans.map(m => `<div class="member-row"><span class="member-dot" style="background:${esc(m.color || '#999')}"></span><span>${esc(m.name)}${profile && m.id === profile.id ? '（自分）' : ''}</span></div>`).join('')
    : '<div class="note">メンバーはいません。</div>';
  if (seats.length) {
    html += '<div class="members-head">Muse</div>';
    html += seats.map(s => {
      const p = PRESENCE_LABEL[s.presence] || PRESENCE_LABEL.offline;
      return `<div class="member-row"><span>🍸 ${esc(s.name)}${s.ownerName ? `（${esc(s.ownerName)}）` : '（Muse）'}</span><span class="presence"><i class="dot ${p.dot}"></i>${esc(p.text)}</span><button type="button" class="sub-btn call-seat-btn" data-seat="${esc(s.seatId)}">${esc(s.name)}を呼ぶ</button></div>`;
    }).join('');
    html += `<div class="note">返信スタイル：${esc(how)}</div>`;
  }
  list.innerHTML = html;
  list.querySelectorAll('.call-seat-btn').forEach(b => b.addEventListener('click', async () => {
    if (!currentRoom) return;
    try { await api(`/api/rooms/${currentRoom.id}/call-kapio`, { method: 'POST', body: JSON.stringify({ seatId: b.dataset.seat }) }); }
    catch (e) { alert(e.message); }
  }));
}
$('#members-btn').addEventListener('click', () => { renderMuseBar(); openModal('#modal-members'); });
function renderMuseActivity() {
  // v4.16: 「考え中」表示はやめ、席ごとの未回答件数をオーナー名で出す。全席0件ならバー自体を出さない
  // v4.17: 件数は「要回答」と判定されたものだけ。判定前がある間はバー自体は出し、末尾に判定前の件数も添える
  if (!currentRoom) { museActivity.classList.add('hidden'); renderMuseUnansweredPanel(); return; }
  const groups = (unansweredCounts || []).filter(c => c.count > 0);
  const unjudgedTotal = (unansweredCounts || []).reduce((n, c) => n + (c.unjudgedCount || 0), 0);
  if (!groups.length && !unjudgedTotal) { museActivity.classList.add('hidden'); renderMuseUnansweredPanel(); return; }
  const parts = groups.map(c => `${c.ownerName || c.name || 'Muse'} 未回答${c.count}件`);
  if (unjudgedTotal) parts.push(`判定前${unjudgedTotal}件`);
  museActivity.innerHTML = `<span>${esc(parts.join('、'))}</span>`;
  museActivity.classList.remove('hidden');
  renderMuseUnansweredPanel();
}
function uaTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString('ja-JP', { hour: 'numeric', minute: '2-digit' })}`;
}
function renderMuseUnansweredPanel() {
  const groups = (unansweredList || []).filter(g => g.count > 0 || (g.unjudged || []).length);
  if (!unansweredPanelOpen || !currentRoom || !groups.length) {
    museUnansweredPanel.classList.add('hidden');
    if (!groups.length) unansweredPanelOpen = false;
    return;
  }
  const itemHtml = (r, dim) => `<div class="ua-item${dim ? ' ua-dim' : ''}${r.triggerMessageId ? ' ua-tappable' : ''}"${r.triggerMessageId ? ` data-trigger="${esc(r.triggerMessageId)}"` : ''}><span class="ua-about">${esc(r.title || r.about || '')}</span><span class="ua-meta">${r.fromName ? `${esc(r.fromName)} から ・ ` : ''}${esc(uaTime(r.createdAt))}</span></div>`;
  museUnansweredPanel.innerHTML = groups.map(g => `
    <div class="ua-group">
      ${g.count ? `<div class="ua-group-head">${esc(g.ownerName || g.name || 'Muse')} 未回答${g.count}件</div>` + (g.requests || []).map(r => itemHtml(r, false)).join('') : ''}
      ${(g.unjudged || []).length ? `<div class="ua-unjudged-head">${esc(g.ownerName || g.name || 'Muse')} ・ 判定前${(g.unjudged || []).length}件</div>` + (g.unjudged || []).map(r => itemHtml(r, true)).join('') : ''}
    </div>`).join('');
  museUnansweredPanel.classList.remove('hidden');
}
museUnansweredPanel.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-trigger]');
  if (!el || !currentRoom) return;
  const msgId = el.dataset.trigger;
  let target = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!target) {
    // 初期表示は最新100件だけなので、古い発言は過去分を遡って読み込んでから探す（v4.19）
    for (let i = 0; i < 10 && !target; i++) {
      const oldest = chatMessages.reduce((a, m) => Math.min(a, m.seq || Infinity), Infinity);
      if (!isFinite(oldest)) break;
      const older = await api(`/api/rooms/${currentRoom.id}/messages?before=${oldest}`).catch(() => null);
      if (!older || !older.length) break;
      const known = new Set(chatMessages.map(m => m.id));
      const fresh = older.filter(m => !known.has(m.id));
      if (!fresh.length) break;
      renderAllMessages([...fresh, ...chatMessages].sort((a, b) => (a.seq || 0) - (b.seq || 0)));
      target = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
    }
  }
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('ua-highlight');
  setTimeout(() => target.classList.remove('ua-highlight'), 2000);
});
museActivity.addEventListener('click', () => { unansweredPanelOpen = !unansweredPanelOpen; renderMuseUnansweredPanel(); });
function handleMuseUnanswered(data) {
  if (!currentRoom || data.roomId !== currentRoom.id) return;
  unansweredCounts = Array.isArray(data.counts) ? data.counts : [];
  if (Array.isArray(data.list)) unansweredList = data.list;
  renderMuseActivity();
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
  unansweredCounts = detail.museUnanswered || [];
  unansweredList = detail.museUnansweredList || []; unansweredPanelOpen = false;
  roomNotices = detail.notices || []; noticesPanelOpen = false; renderNotices();
  boardTasks = detail.tasks || []; boardDecisions = detail.decisions || []; boardEditingId = null; boardNoteDraft = ''; renderBoard();
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
  if (orig) text = orig.type === 'unsent' ? '取り消されたメッセージ' : `${orig.senderName}: ${orig.body || (orig.image ? '画像' : (orig.file ? `📄 ${orig.file.name || 'PDF'}` : ''))}`;
  return `<div class="msg-quote" data-jump="${esc(m.replyTo)}">${linkify(esc(text.slice(0, 40)))}</div>`;
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
  const seatOwner = isKapio ? ((currentRoom?.muses || []).find(s => s.seatId === m.senderId)?.ownerName || null) : null;
  const row = document.createElement('div');
  row.className = 'msg-row' + (isMe ? ' me' : '') + (isKapio ? ' kapio' : '');
  if (m.id) row.dataset.msgId = m.id;
  row.innerHTML = `
    ${isMe ? '' : `<div class="avatar" style="background:${esc(isKapio ? '#d4a017' : (member?.color || '#888'))}">${esc((m.senderName || '?').slice(0, 1))}</div>`}
    <div class="msg-body">
      ${isMe ? '' : `<div class="msg-name">${esc(m.senderName)}${isKapio ? `（${esc(seatOwner || 'Muse')}）` : ''}</div>`}
      <div class="msg-bubble">${quoteHtml(m)}${m.image ? `<img class="msg-image" src="${esc(m.image)}" alt="画像">` : ''}${m.file ? `<a class="msg-pdf" href="#">📄 ${esc(m.file.name || 'PDFファイル')}</a>` : ''}${m.body ? `<span>${linkify(esc(m.body))}</span>` : ''}</div>
      <div class="msg-foot">${isMe ? `<span class="msg-read" id="read-${esc(m.id)}"></span>` : ''}<span class="msg-time">${fmtTime(m.createdAt)}${m.editedAt ? '（更新）' : ''}</span></div>
    </div>`;
  const img = row.querySelector('.msg-image');
  if (img) img.addEventListener('click', () => { $('#lightbox-img').src = m.image; $('#lightbox').classList.remove('hidden'); });
  const pdfLink = row.querySelector('.msg-pdf');
  if (pdfLink && m.file) pdfLink.addEventListener('click', (e) => { e.preventDefault(); openPdfFile(m.file); });
  const quote = row.querySelector('.msg-quote');
  if (quote) quote.addEventListener('click', () => jumpTo(m.replyTo));
  attachLongPress(row.querySelector('.msg-bubble'), m.id);
  return row;
}
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const dayLabel = (iso) => new Date(iso).toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
function appendMessage(m) {
  if (m.type === 'notice') { addNotice(m); return; }
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
  if (m.type === 'notice') {
    // v4.21: お知らせへ移された発言はトーク欄から外す
    if (old) old.remove();
    if (idx >= 0) chatMessages.splice(idx, 1);
    addNotice(m);
    return;
  }
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
    unansweredCounts = detail.museUnanswered || [];
  unansweredList = detail.museUnansweredList || []; unansweredPanelOpen = false;
    roomNotices = detail.notices || []; renderNotices();
    boardTasks = detail.tasks || []; boardDecisions = detail.decisions || []; renderBoard();
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
    $('#reply-bar-text').textContent = `返信: ${m.senderName}: ${(m.body || (m.image ? '画像' : (m.file ? `📄 ${m.file.name || 'PDF'}` : ''))).slice(0, 40)}`;
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
  if (!currentRoom || sending || (!body && !pendingImages.length && !pendingPdfs.length)) return;
  const roomId = currentRoom.id;
  const replyTo = replyTargetId;
  if (pendingImages.length || pendingPdfs.length) {
    sending = true;
    $('#send-btn').disabled = true;
    const jobs = [
      ...pendingImages.map(src => ({ image: src })),
      ...pendingPdfs.map(f => ({ file: f })),
    ];
    clearPendingImages();
    ta.value = '';
    ta.style.height = 'auto';
    setReplyTarget(null);
    clearDraft(roomId);
    try {
      for (let i = 0; i < jobs.length; i++) {
        const payload = { ...jobs[i] };
        if (i === 0) { if (body) payload.body = body; if (replyTo) payload.replyTo = replyTo; }
        const m = await api(`/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
        if (currentRoom && currentRoom.id === roomId) { appendMessage(m); scrollChat(); }
      }
    } catch (e) {
      alert('添付の送信に失敗しました: ' + e.message);
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

// v4.23: PDFを開く（data URLをBlob URLに変換して新しいタブで開く。ブロックされたらダウンロードに切り替える）
async function openPdfFile(file) {
  try {
    const blob = await (await fetch(file.data)).blob();
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) {
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name || 'document.pdf';
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { alert('PDFを開けませんでした'); }
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
  pendingPdfs.forEach((f, i) => {
    const t = document.createElement('div');
    t.className = 'pdf-chip';
    const label = document.createElement('span');
    label.textContent = `📄 ${f.name}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'img-thumb-x';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'このPDFを外す');
    x.addEventListener('click', () => { pendingPdfs.splice(i, 1); renderPendingImages(); });
    t.appendChild(label);
    t.appendChild(x);
    wrap.appendChild(t);
  });
  const total = pendingImages.length + pendingPdfs.length;
  $('#image-preview-note').textContent = total > 1 ? `${total}件の添付を送信します` : 'この添付を送信します';
  bar.classList.toggle('hidden', total === 0);
  const input = $('#image-input');
  if (input) input.value = '';
}
function clearPendingImages() {
  pendingImages = [];
  pendingPdfs = [];
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
const MAX_PENDING_PDFS = 2;
const PDF_MAX_BYTES = 2 * 1024 * 1024;
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
$('#image-input').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const file of files) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf) {
      if (pendingPdfs.length >= MAX_PENDING_PDFS) { alert(`PDFは一度に${MAX_PENDING_PDFS}件までです`); break; }
      if (file.size > PDF_MAX_BYTES) { alert(`PDFは1件2MBまでです（${file.name} は ${(file.size / 1048576).toFixed(1)}MB）`); continue; }
      try { pendingPdfs.push({ name: file.name, data: await readFileAsDataUrl(file) }); }
      catch { alert('PDFを読み込めませんでした'); }
      continue;
    }
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
$('#back-btn').addEventListener('click', () => { currentRoom = null; activeRequests = new Map(); unansweredCounts = []; unansweredList = []; unansweredPanelOpen = false; boardTasks = []; boardDecisions = []; renderBoard(); renderMuseActivity(); show('#view-rooms'); loadRooms(); });
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
    return seat && seat.ownerName ? `${m.name}（${seat.ownerName}）` : `${m.name}（Muse）`;
  });
  for (const s of seats) {
    if (!detail.members.some(m => m.id === s.seatId)) memberNames.push(s.ownerName ? `${s.name}（${s.ownerName}）` : `${s.name}（Muse）`);
  }
  $('#settings-members').textContent = memberNames.join('、');
  $('#muse-seat-status').textContent = !seats.length
    ? 'Museは同席していません'
    : seats.map(s => s.ownerName ? `${s.name}（${s.ownerName}）` : s.name).join('、') + ' が同席中です';
  const mine = seats.find(s => s.ownerId === profile.id);
  $('#muse-mine-area').classList.toggle('hidden', !mine);
  $('#muse-claim-area').classList.toggle('hidden', !!mine);
  if (mine) {
    try { const t = await api('/api/me/bridge-token', { method: 'POST', body: '{}' }); $('#muse-token-input').value = t.bridgeToken; $('#muse-prompt').value = buildBridgePrompt(t.bridgeToken); } catch { /* ignore */ }
  }
  $('#settings-kapio-mode').value = detail.kapioMode;
  renderDecisions(detail.decisions || []);
  renderTasks(detail.tasks || []);
  openModal('#modal-settings');
});
function renderDecisions(decisions) {
  // v4.23: 決まったことの表示はボード側に一本化したため、ここはボード側のデータ同期だけを行う
  boardDecisions = decisions || [];
  if (typeof renderBoard === 'function') renderBoard();
}
function renderTasks(tasks) {
  // v4.23: 設定モーダルのタスク表はボードに一本化したため、ここはボード側のデータ同期だけを行う
  boardTasks = tasks || [];
  if (typeof renderBoard === 'function') renderBoard();
}
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
  return `あなたはチャットアプリ「Muse対応チャット」のルーム「${roomName}」に、${museName}（${profile.name}さんのMuse）として同席します。オーナーがアプリを開かなくても会話に参加できるよう、次の手順でセットアップし、その後は振る舞いルールに従ってください。これはあなたへの指示の全文です（他に説明書はありません）。

【接続情報】
連携トークン: ${token}
APIのベースURL: ${origin}
開発情報: ${origin}/dev（アプリのコードと変更手順のページ。不具合を調べるときは ${origin}/source/app.js のように本番コードを直接読める）
あなたの席の名前: ${museName}
オーナー: ${profile.name}さん
このトークンはあなたの席専用です。他人に教えたり、オーナー以外の目に触れる場所（ファイルやスペースの表示など）に書いたりしないでください。

【セットアップ】
1. 接続テスト: GET ${origin}/api/bridge/pending（ヘッダー: Authorization: Bearer ${token}）を実行し、依頼の一覧（空でもよい）が返ることを確認する。401 の場合はトークンが違うのでオーナーに確認する。
2. 見張り: 60秒間隔で GET ${origin}/api/bridge/pending を確認する仕組み（フック等）を作る。新しい request_id の依頼が現れたときだけ処理し、一度処理を始めた依頼で繰り返し起きないよう、処理したIDを記録する。オーナーの回答待ちの依頼は pending のまま残って正常。
3. 連絡スペース: オーナー専用のスペース「${roomName} 連絡スペース」を作る。他人に共有しない。既に同じ名前のスペースを作ってある場合は、新規に作らず既存のものを使い続ける（スペースは1つに固定する）。Museアプリのチャット画面のようなUI（あなたの発言は左寄せの吹き出し、オーナーは右寄せの吹き出し、画面下部にメッセージ入力欄）で、オーナーへの質問・返信の下書き・自動返信のログを吹き出しとして時系列に流す。オーナーは吹き出し下の［このまま送信］［見送る］ボタンか、入力欄への返信で承認・回答できる。データはスペース側に保存し、あなたが登録・更新する。アイテムの項目: 種類（question/draft/post）、状態（waiting/approved/sent/skipped）、ルーム名、ルームID、request_id、きっかけの発言、会話の抜粋、下書き本文、質問文、見立て、オーナーの回答・編集文、作成時刻、期限。オーナーが入力欄で「ルームへ投稿」を選んで書いた文は、種類 post のアイテムとして作成時点から approved で保存される（あなたが次に起きたときに投稿する）。

【依頼の形式】
各依頼: request_id / type（reply=返信、summary=要約、group=全体宛の相談）/ room_id / room_name / muse_name（あなたの名前）/ trigger（きっかけの発言）/ context（直近の会話）/ decisions / summary。有効期限は30分（group依頼と、仮答を出した依頼は24時間）。古いものから処理する。

【処理の流れ】
新しい依頼の前に、連絡スペースで approved になっているアイテムがあれば、その内容を POST ${origin}/api/bridge/reply（ヘッダー: Authorization: Bearer ${token}、本文 {"request_id": "...", "body": "..."}）で投稿して送信済みに記録する。skipped のアイテムの依頼が残っていれば POST ${origin}/api/bridge/dismiss {"request_id": "..."} で閉じる。種類が post の approved アイテムがあれば、POST ${origin}/api/bridge/post {"room_id": "アイテムのルームID", "body": "投稿文"} でルームへ投稿して送信済みに記録する（post の文はオーナーが書いた原文のまま送り、書き換えない。ルームIDが分からない場合は room_id の代わりに room_name でも送れる）。その後、新しい依頼を以下に分類する。

分類A（自動で返信してよい）: 挨拶・相づち・あなた自身への軽い質問への短答・オーナーが公言済みの事実の短い再掲。目安100字以内。約束・判断・予定の確定を含まない。人間の発言にも、他のMuseの発言にも反応してよい。POST ${origin}/api/bridge/typing {"request_id": "..."} で受け取りを記録し、reply で送信し、連絡スペースにログとして残す。

分類Q（質問への回答: 仮答→オーナー確認→本答）: あなた宛の質問（特にオーナーの事情・意向が絡むもの、確信が持てないもの）は即答しない。(1) reply に {"request_id": "...", "body": "おそらく○○だと思うけど、${profile.name}さんに聞いてみるね", "partial": true} を送り、仮答を表示する（○○はあなたの見立て）。(2) 連絡スペースに質問を登録し、オーナーに普段のチャットでも知らせる。(3) オーナーの回答を受けたら、それを本答として partial なしの reply で送る（仮答の吹き出しが本答に置き換わる）。

分類B（下書きを作り、オーナーの承認を得てから送る）: 意見・提案・判断を含む返信、約束・日程・お金・第三者の予定に触れる内容、調べた情報の共有、長文の返信、summary依頼（body に要約文、決まったことがあれば decisions に文字列の配列）。下書きを連絡スペースに登録してオーナーに知らせる。承認されたら reply で送る。オーナーが普段のチャットで「送っていい」と言った場合も送ってよい。

分類G（全体宛の相談: type=group）: 特定の誰か宛ではなく全体への相談（日程調整など）。ルームへ即答も仮答もしない。オーナーに取り次ぐ: 連絡スペースに質問として登録し、オーナーに普段のチャットでも知らせる。オーナーの回答が得られたら、それをもとに reply で送る（例:「○日と○日なら空いてるよ」）。回答が得られなければ送らない。日程の確定や約束はしない（都合の集計まで）。

分類C（返さない）: 関係が薄い、既に他の人が答えた、話題が流れた。dismiss で閉じる。迷ったらBに倒す。

【未回答の判定登録（verdict）: 分類したら必ず登録する】
アプリの「未回答」表示（件数と一覧）は、この判定で決まります。依頼を分類したら、POST ${origin}/api/bridge/verdict（ヘッダー: Authorization: Bearer ${token}、本文 {"request_id": "...", "needs_answer": true/false, "title": "題名"}）で登録してください。再登録で上書きできます（分類が変わったら登録し直す）。
- needs_answer=true（分類B・Q・G: オーナーの承認・回答が要るもの）: title に内容が分かる題名を付ける（例:「クリスマスパーティーの日程について」）。一覧ではこの題名が主表示になります。
- 物差しは「オーナーの回答・判断がまだ要るか」だけです。設定変更や実装で解決するものは、オーナーの判断が出た時点で needs_answer=false に登録し直し、進捗はルームの「決めること（タスク）」で追ってください（未回答には残さない）。
- needs_answer=false（分類A: 自分で回答済み／分類C: 回答不要）: title は不要です。要回答でないものは未回答表示に出ません。
判定を付けていない依頼は未回答表示に出ません。処理の最後に判定まで済ませてください。

【お知らせ（notice）】
アップデート告知など、会話ではない連絡は「お知らせ」として届きます。GET /api/bridge/pending の応答の notices に入っているので、起きたら必ず目を通し、指示（指示文の取り直し等）があれば従ってください。お知らせへの返信は不要です。
逆に、自分がアップデート告知などを出すときは、POST /api/bridge/post の本文に "notice": true を付けてください（トーク欄に出ず、お知らせとして配信されます）。

【ループ防止（Aの前に必ず確認。contextの直近発言で判定）】
1. 自席の発言が2回続いている（間に人間の発言がない）→ 自動返信しない（Cにする）。
2. 直近の自分の通常の自動返信から3分未満 → 自動返信しない。ただしQの仮答は起点にしない。
3. 相づちのみ（短文で「うん」「いいね」「確かに」等だけ）の発言へは自動応答しない。ただし自分宛の挨拶はAでよい。
4. 人間の発言がないままMuse同士の往復が4発言以上続いている → そのルームでは自動返信を止め、Cにする。
5. オーナーが「黙って」「止めて」と言ったら、その場で自動返信をやめる。

【口調と安全】
このルームは代理人モデルで運用されます。オーナーはルームに直接返信しない前提で、質問・回答・相談の取り次ぎはあなたが担います。発言は「${museName}」の名前で投稿されます。口調はオーナーの普段の話し方に合わせ、知らないことは知らないと言う。人間関係の約束を勝手に作らない。このルームでは全ての人間の発言が各席への依頼になります。特定の席やメンバーが名指しされた発言は、その席にだけ依頼が届きます。オーナーが名指しされた質問は、あなた自身への質問として受け止め、回答は代理人として自分の言葉で書くこと（「○○さんによると」のような伝聞調にしない）。`;
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
    } else if (data.type === 'muse_unanswered') {
      handleMuseUnanswered(data);
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
