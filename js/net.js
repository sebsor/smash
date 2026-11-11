// ─────────────────────────────────────────────────────────────
// net.js — peer-to-peer connections with PeerJS (WebRTC).
//
// GitHub Pages can't run a server, so players connect browser-to-browser.
// They still need a "matchmaker" to find each other: PeerJS's free public
// broker (0.peerjs.com). The host registers the ID "shapeshock-<CODE>",
// guests ask the broker to connect them to that ID, and after that the
// game data flows directly between browsers — the broker never sees it.
//
// Each guest opens TWO channels to the host:
//   'ctrl' reliable   — lobby messages, picks, start/end. Must never be lost.
//   'game' unreliable — inputs & snapshots 60×/s. A late packet is useless,
//                       so we'd rather drop it than wait for a resend.
// ─────────────────────────────────────────────────────────────

const PREFIX = 'shapeshock-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no O/0 or I/1 confusion

export function randomCode(n = 5) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
export const normalizeCode = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

// Optional: ?peer=localhost:9000 to use your own PeerServer (handy for testing).
function peerOptions() {
  const opts = {
    debug: 1,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] },
  };
  const custom = new URLSearchParams(location.search).get('peer');
  if (custom) {
    const [host, port] = custom.split(':');
    Object.assign(opts, { host, port: +(port || 9000), path: '/', secure: location.protocol === 'https:' && host !== 'localhost' });
  }
  return opts;
}

function friendlyError(err) {
  switch (err?.type) {
    case 'peer-unavailable': return 'No game found with that code. Check the code, or ask the host if their game is still open.';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'Can’t reach the matchmaking server. Check your connection and try again — some work or school networks block it.';
    case 'browser-incompatible': return 'This browser doesn’t support peer-to-peer connections. Try a recent Chrome, Edge or Firefox.';
    case 'webrtc': return 'The connection to the other player failed. Strict networks (like many offices) can block direct connections.';
    default: return 'Connection problem: ' + (err?.message || err?.type || 'unknown error');
  }
}

// ── HOST ──────────────────────────────────────────────────────
export class HostNet {
  constructor(handlers) {
    this.h = handlers;           // { onReady(code), onJoin(pid), onLeave(pid), onCtrl(pid,msg), onGame(pid,msg), onError(text) }
    this.guests = new Map();     // peerId → { ctrl, game }
    this.tries = 0;
    this.open();
  }

  open() {
    this.code = randomCode();
    this.peer = new window.Peer(PREFIX + this.code, peerOptions());
    this.peer.on('open', () => this.h.onReady(this.code));
    this.peer.on('connection', conn => this.accept(conn));
    this.peer.on('disconnected', () => { if (!this.closed) this.peer.reconnect(); });
    this.peer.on('error', err => {
      if (err.type === 'unavailable-id' && this.tries++ < 5) { this.peer.destroy(); this.open(); return; }  // code taken: pick another
      if (err.type === 'peer-unavailable') return;
      this.h.onError(friendlyError(err));
    });
  }

  accept(conn) {
    const pid = conn.peer;
    if (!this.guests.has(pid)) this.guests.set(pid, { ctrl: null, game: null });
    const g = this.guests.get(pid);
    g[conn.label === 'game' ? 'game' : 'ctrl'] = conn;
    conn.on('open', () => { if (conn.label === 'ctrl') this.h.onJoin(pid); });
    conn.on('data', d => conn.label === 'game' ? this.h.onGame(pid, d) : this.h.onCtrl(pid, d));
    conn.on('close', () => this.drop(pid));
    conn.on('error', () => this.drop(pid));
  }

  drop(pid) {
    const g = this.guests.get(pid);
    if (!g) return;
    this.guests.delete(pid);
    try { g.ctrl?.close(); g.game?.close(); } catch { /* already closed */ }
    this.h.onLeave(pid);
  }

  sendCtrl(pid, msg) { const c = this.guests.get(pid)?.ctrl; if (c?.open) c.send(msg); }
  broadcastCtrl(msg) { for (const pid of this.guests.keys()) this.sendCtrl(pid, msg); }
  broadcastGame(msg) {
    for (const g of this.guests.values()) {
      // Skip if the channel is backed up — sending more would only add delay.
      if (g.game?.open && (g.game.dataChannel?.bufferedAmount ?? 0) < 64000) g.game.send(msg);
    }
  }
  kick(pid, msg) { this.sendCtrl(pid, msg); setTimeout(() => this.drop(pid), 300); }

  close() {
    this.closed = true;
    for (const pid of [...this.guests.keys()]) this.drop(pid);
    this.peer?.destroy();
  }
}

// ── GUEST ─────────────────────────────────────────────────────
export class GuestNet {
  constructor(code, handlers) {
    this.h = handlers;           // { onOpen(), onCtrl(msg), onGame(msg), onClose(), onError(text) }
    this.code = code;
    this.peer = new window.Peer(peerOptions());
    this.timer = setTimeout(() => {
      if (!this.ctrl?.open) { this.h.onError('Couldn’t reach that game. The host may have closed it, or your networks can’t connect directly.'); this.close(); }
    }, 15000);

    this.peer.on('open', () => {
      const id = PREFIX + code;
      this.ctrl = this.peer.connect(id, { label: 'ctrl', reliable: true, serialization: 'json' });
      this.game = this.peer.connect(id, { label: 'game', reliable: false, serialization: 'json' });
      this.ctrl.on('open', () => { clearTimeout(this.timer); this.h.onOpen(); });
      this.ctrl.on('data', d => this.h.onCtrl(d));
      this.game.on('data', d => this.h.onGame(d));
      const closed = () => { if (!this.closed) { this.closed = true; this.h.onClose(); } };
      this.ctrl.on('close', closed);
      this.ctrl.on('error', closed);
    });
    this.peer.on('error', err => { clearTimeout(this.timer); this.h.onError(friendlyError(err)); this.close(); });
  }

  sendCtrl(msg) { if (this.ctrl?.open) this.ctrl.send(msg); }
  sendGame(msg) { if (this.game?.open && (this.game.dataChannel?.bufferedAmount ?? 0) < 16000) this.game.send(msg); }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    try { this.ctrl?.close(); this.game?.close(); } catch { /* ignore */ }
    this.peer?.destroy();
  }
}
