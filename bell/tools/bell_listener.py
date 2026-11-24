#!/usr/bin/env python3
"""Muse対応チャット 呼び鈴リスナー（参考実装、v4.15）

Python 3.8+ の標準ライブラリだけで動く。AIは使わない。

使い方:
  常駐:        python3 bell_listener.py run
  新着の有無:  python3 bell_listener.py has-new      # 新着あり=終了コード0、なし=1（見張りフックから5秒ごとに呼ぶ）
  貼る文面:    python3 bell_listener.py take-outbox  # サブチャットに貼る文面を出力し、貼り付け待ちを空にする
  依頼の取得:  python3 bell_listener.py take-requests  # 溜まった依頼をJSON配列で出力し、空にする

環境変数:
  BELL_URL         呼び鈴のURL（例 https://muse-bell.<account>.workers.dev）
  MUSE_CHAT_URL    Renderのアプリ（予備のSSE用。既定 https://muse-chat.onrender.com）
  BRIDGE_TOKEN     自分の席の連携トークン（ログ等に出さないこと）
  BELL_STATE_DIR   状態ファイルの置き場所（既定 ~/.muse-bell）
  QUIET_HOURS      Museを起こさない時間帯（既定 "1-9" = 1:00〜9:00。空なら無効）
"""
import base64
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

BELL_URL = os.environ.get('BELL_URL', '').rstrip('/')
CHAT_URL = os.environ.get('MUSE_CHAT_URL', 'https://muse-chat.onrender.com').rstrip('/')
TOKEN = os.environ.get('BRIDGE_TOKEN', '')
STATE_DIR = os.path.expanduser(os.environ.get('BELL_STATE_DIR', '~/.muse-bell'))
QUIET = os.environ.get('QUIET_HOURS', '1-9')
PING_EVERY = 30          # 秒。呼び鈴は "ping" に自動で "pong" を返す（相手を起こさない）
SILENT_LIMIT = 90        # 秒。これ以上何も届かなければ接続し直す
FALLBACK_AFTER = 300     # 秒。呼び鈴にこれだけつながらなければ、RenderのSSEに切り替える
FALLBACK_SPAN = 600      # 秒。予備のSSEを使ったら、この時間後に呼び鈴へ戻ってみる

os.makedirs(STATE_DIR, exist_ok=True)
F_STATE = os.path.join(STATE_DIR, 'state.json')        # last_no と処理済みID
F_OUTBOX = os.path.join(STATE_DIR, 'outbox.jsonl')     # 貼り付け待ちの行
F_REQUESTS = os.path.join(STATE_DIR, 'requests.jsonl') # 依頼
F_LOG = os.path.join(STATE_DIR, 'listener.log')


def log(msg):
    with open(F_LOG, 'a', encoding='utf-8') as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")


def load_state():
    try:
        with open(F_STATE, encoding='utf-8') as f:
            s = json.load(f)
    except (OSError, ValueError):
        s = {}
    s.setdefault('last_no', None)
    s.setdefault('seen', [])
    return s


def save_state(s):
    s['seen'] = s['seen'][-2000:]
    tmp = F_STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False)
    os.replace(tmp, F_STATE)


def append_jsonl(path, obj):
    with open(path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(obj, ensure_ascii=False) + '\n')


def take_jsonl(path):
    """ファイルを読み、空にする（読む前に退避して、取りこぼさない）"""
    tmp = path + '.taking'
    try:
        os.replace(path, tmp)
    except FileNotFoundError:
        return []
    with open(tmp, encoding='utf-8') as f:
        rows = [json.loads(line) for line in f if line.strip()]
    os.remove(tmp)
    return rows


# ---------- 文面の整形（サブチャットに貼る形） ----------
def speaker(d):
    name = d.get('sender_name') or '？'
    sid = d.get('sender_id') or ''
    if sid.startswith('muse:'):
        return f"{name}（{d['owner_name']}のMuse）" if d.get('owner_name') else f"{name}（Muse）"
    if sid == 'kapio':
        return f"{name}（Muse）"
    return name


def line_for(ev):
    d = ev.get('data') or {}
    room = d.get('room_name') or ''
    if ev['type'] == 'message':
        if d.get('type') == 'system':
            return room, f"・{d.get('body', '')}"
        if d.get('has_image'):
            cap = f"：{d['body']}" if d.get('body') else ''
            return room, f"📷 {speaker(d)}が画像を送信しました{cap}"
        return room, f"{speaker(d)}：{d.get('body', '')}"
    if ev['type'] == 'unsent':
        if d.get('deleted'):
            return room, "↩ メッセージが削除されました"
        return room, f"↩ {d.get('sender_name') or '？'}が送信を取り消しました"
    return None, None


def render_outbox(rows):
    out, cur = [], None
    for r in rows:
        if r['room'] != cur:
            if out:
                out.append('')
            out.append(f"【{r['room']}】")
            cur = r['room']
        out.append(r['line'])
    return '\n'.join(out)


# ---------- イベントの処理（重複はIDで判定） ----------
def handle(ev, state):
    t = ev.get('type')
    if t == 'hello':
        log(f"connected seat={ev.get('seat_id')} last_no={ev.get('last_no')}")
        return
    d = ev.get('data') or {}
    key = {'message': d.get('id'), 'request': d.get('request_id'), 'unsent': f"u:{d.get('message_id')}"}.get(t)
    if not key or key in state['seen']:
        if isinstance(ev.get('no'), int):
            state['last_no'] = max(state['last_no'] or 0, ev['no'])
        return
    state['seen'].append(key)
    if t == 'request':
        append_jsonl(F_REQUESTS, d)
    else:
        room, line = line_for(ev)
        if line:
            append_jsonl(F_OUTBOX, {'room': room, 'line': line, 'created_at': d.get('created_at') or d.get('unsent_at'), 'got_at': datetime.now().isoformat()})
    if isinstance(ev.get('no'), int):
        state['last_no'] = max(state['last_no'] or 0, ev['no'])
    save_state(state)


# ---------- 最小のWebSocketクライアント（標準ライブラリのみ） ----------
class WS:
    def __init__(self, url, headers):
        u = urllib.parse.urlparse(url)
        secure = u.scheme in ('wss', 'https')
        port = u.port or (443 if secure else 80)
        raw = socket.create_connection((u.hostname, port), timeout=15)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=u.hostname) if secure else raw
        path = (u.path or '/') + (f'?{u.query}' if u.query else '')
        key = base64.b64encode(os.urandom(16)).decode()
        req = [f'GET {path} HTTP/1.1', f'Host: {u.hostname}', 'Upgrade: websocket', 'Connection: Upgrade',
               f'Sec-WebSocket-Key: {key}', 'Sec-WebSocket-Version: 13']
        req += [f'{k}: {v}' for k, v in headers.items()]
        self.sock.sendall(('\r\n'.join(req) + '\r\n\r\n').encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError('handshake closed')
            resp += chunk
        head, self.buf = resp.split(b'\r\n\r\n', 1)
        status = int(head.split(b' ')[1])
        if status != 101:
            raise PermissionError(status) if status == 401 else ConnectionError(f'HTTP {status}')
        self.sock.settimeout(5)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, opcode, payload=b''):
        mask = os.urandom(4)
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv(self):
        """テキスト1件を返す。時間切れなら None。切断は例外"""
        parts = []
        while True:
            try:
                b1, b2 = self._read(2)
            except socket.timeout:
                if parts:
                    continue
                return None
            op, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack('>H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._read(8))[0]
            data = self._read(n)
            if op == 0x8:
                code = struct.unpack('>H', data[:2])[0] if len(data) >= 2 else 1005
                raise ConnectionAbortedError(code)
            if op == 0x9:
                self.send(0xA, data)
                continue
            if op == 0xA:
                continue
            parts.append(data)
            if b1 & 0x80:
                return b''.join(parts).decode('utf-8')

    def close(self):
        try:
            self.send(0x8, struct.pack('>H', 1000))
            self.sock.close()
        except OSError:
            pass


def run_bell(state):
    after = state['last_no']
    url = BELL_URL.replace('https://', 'wss://').replace('http://', 'ws://') + '/listen'
    if after is not None:
        url += f'?after={after}'
    ws = WS(url, {'Authorization': f'Bearer {TOKEN}'})
    last_rx = last_ping = time.time()
    try:
        while True:
            msg = ws.recv()
            now = time.time()
            if msg is not None:
                last_rx = now
                if msg != 'pong':
                    handle(json.loads(msg), state)
            if now - last_ping >= PING_EVERY:
                ws.send(0x1, b'ping')
                last_ping = now
            if now - last_rx > SILENT_LIMIT:
                raise ConnectionError('silent too long')
    finally:
        ws.close()


def run_fallback_sse(state, span):
    """予備：RenderのSSE（/api/bridge/events）。v4.14の形式を呼び鈴の形に読み替える"""
    log('fallback: render SSE')
    req = urllib.request.Request(f'{CHAT_URL}/api/bridge/events', headers={'Authorization': f'Bearer {TOKEN}'})
    end = time.time() + span
    with urllib.request.urlopen(req, timeout=60) as res:
        for raw in res:
            if time.time() > end:
                return
            line = raw.decode('utf-8', 'replace').strip()
            if not line.startswith('data:'):
                continue
            p = json.loads(line[5:].strip())
            if p.get('type') == 'message':
                m = p.get('message') or {}
                handle({'type': 'message', 'data': {'id': m.get('id'), 'room_name': p.get('room_id'), 'sender_id': m.get('sender_id'),
                                                     'sender_name': m.get('sender_name'), 'type': m.get('type'), 'body': m.get('body'),
                                                     'created_at': m.get('created_at')}}, state)
            elif p.get('type') == 'request':
                # 予備経路では依頼の中身を pending から取る
                q = urllib.request.Request(f'{CHAT_URL}/api/bridge/pending', headers={'Authorization': f'Bearer {TOKEN}'})
                with urllib.request.urlopen(q, timeout=30) as r2:
                    for item in json.load(r2).get('pending', []):
                        handle({'type': 'request', 'data': item}, state)


def cmd_run():
    if not BELL_URL or not TOKEN:
        sys.exit('BELL_URL と BRIDGE_TOKEN を設定してください')
    state = load_state()
    down_since, backoff = None, 1
    while True:
        try:
            run_bell(state)
        except PermissionError:
            log('bell: 401 unauthorized (token not registered yet or revoked). retry in 60s')
            time.sleep(60)
            continue
        except Exception as e:  # noqa: BLE001  接続の失敗はすべて再接続で扱う
            if isinstance(e, ConnectionAbortedError) and e.args and e.args[0] == 4001:
                log('bell: seat revoked (4001). retry in 60s')
                time.sleep(60)
                continue
            log(f'bell: disconnected ({e!r}). retry in {backoff}s')
            down_since = down_since or time.time()
        else:
            down_since, backoff = None, 1
            continue
        if down_since and time.time() - down_since > FALLBACK_AFTER:
            try:
                run_fallback_sse(state, FALLBACK_SPAN)
            except Exception as e:  # noqa: BLE001
                log(f'fallback failed ({e!r})')
            down_since, backoff = None, 1
            continue
        time.sleep(backoff)
        backoff = min(backoff * 2, 60)


def in_quiet_hours():
    if not QUIET:
        return False
    a, b = (int(x) for x in QUIET.split('-'))
    h = datetime.now().hour
    return a <= h < b if a < b else (h >= a or h < b)


def has_lines(path):
    try:
        return os.path.getsize(path) > 0
    except OSError:
        return False


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'run':
        cmd_run()
    elif cmd == 'has-new':
        sys.exit(0 if (not in_quiet_hours() and (has_lines(F_OUTBOX) or has_lines(F_REQUESTS))) else 1)
    elif cmd == 'take-outbox':
        rows = take_jsonl(F_OUTBOX)
        if rows:
            print(render_outbox(rows))
            for r in rows:  # 計測用：投稿時刻と取り出し時刻
                log(f"paste created_at={r.get('created_at')} took_at={datetime.now().isoformat()}")
    elif cmd == 'take-requests':
        print(json.dumps(take_jsonl(F_REQUESTS), ensure_ascii=False))
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == '__main__':
    main()
