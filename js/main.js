// ─────────────────────────────────────────────────────────────
// main.js — glues everything together: screens, lobby, and the
// two game loops (host and guest).
//
//   HOST  : keyboard ─┐
//           guests' inputs (network) ─┼→ Game.step() ×60/s → snapshot ─→ Renderer
//                                     └──────────────────────────────→ network → guests
//   GUEST : keyboard → network → host
//           snapshots (network) → buffer → interpolate → Renderer
// ─────────────────────────────────────────────────────────────

import { VERSION, STEP_MS, RULES } from './config.js';
import { CHARACTERS, CHARACTER_ORDER } from './characters.js';
import { Game } from './game.js';
import { Renderer, drawFighterPreview, SLOT_COLORS, SLOT_NAMES, fighterColor } from './render.js';
import { KeyboardInput, pressedFromCounters, CONTROLS_HELP } from './input.js';
import { HostNet, GuestNet, normalizeCode } from './net.js';
import * as audio from './audio.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ── App state ─────────────────────────────────────────────────
const S = {
  screen: 'title',
  role: null,          // 'host' | 'guest'
  net: null,
  mySlot: 0,
  lobby: { code: '', players: [] },   // players: [{slot, name, char, pid?}]
  match: null,
  game: null,          // host only
  results: null,
};
const kb = new KeyboardInput();
const sceneCv = $('#scene');
const sceneR = new Renderer(sceneCv);       // reused only for its sky background
const gameR = new Renderer($('#game'));

// ═════════════════════════════════════════════════════════════
// Screens
// ═════════════════════════════════════════════════════════════
function show(name) {
  S.screen = name;
  for (const id of ['title', 'lobby', 'game', 'results']) $('#screen-' + id).hidden = id !== name;
  sceneCv.hidden = name === 'game';
  kb.enabled = name === 'game';
  if (name === 'game') { gameR.resize(); }
}

function titleMessage(text, isError = true) {
  const m = $('#title-msg');
  m.textContent = text || '';
  m.classList.toggle('error', isError);
}

function myName() {
  const v = $('#name').value.trim().slice(0, 14);
  return v || 'Player';
}

// ═════════════════════════════════════════════════════════════
// Title screen
// ═════════════════════════════════════════════════════════════
$('#name').value = store.get('ss-name', 'Player ' + Math.floor(100 + Math.random() * 900));
$('#name').addEventListener('change', () => store.set('ss-name', myName()));
const joinParam = normalizeCode(new URLSearchParams(location.search).get('join'));
if (joinParam) { $('#code').value = joinParam; }
$('#code').addEventListener('input', e => { e.target.value = normalizeCode(e.target.value); });

$('#btn-host').addEventListener('click', () => { audio.unlock(); audio.play('ui'); startHosting(); });
$('#form-start').addEventListener('submit', e => {
  e.preventDefault(); audio.unlock();
  const code = normalizeCode($('#code').value);
  if (code.length !== 5) { titleMessage('Codes are 5 characters long.'); $('#code').focus(); return; }
  audio.play('ui');
  joinGame(code);
});

function setBusy(busy, text = '') {
  $('#btn-host').disabled = busy; $('#btn-join').disabled = busy;
  titleMessage(text, false);
}

// mute toggle
const muteBtn = $('#btn-mute');
const syncMute = () => { muteBtn.textContent = 'Sound: ' + (audio.isMuted() ? 'off' : 'on'); };
syncMute();
muteBtn.addEventListener('click', () => { audio.unlock(); audio.toggleMute(); syncMute(); });

// In-match controls panel (top left). Compact version of CONTROLS_HELP.
const HUD_KEYS = [
  ['Move', 'W A S D', '← ↑ → ↓'],
  ['Jump', 'Space / W', 'Space'],
  ['Attack', 'J', 'Z'],
  ['Special', 'K', 'X'],
  ['Smash', 'I', 'C'],
  ['Shield', 'L / Shift', 'V / Shift'],
  ['Grab', ';', 'B'],
  ['Menu', 'Esc', 'Esc'],
];
$('#hud-keys').innerHTML = HUD_KEYS.map(([a, k1, k2]) => `<tr><th>${a}</th><td><kbd>${k1}</kbd></td><td><kbd>${k2}</kbd></td></tr>`).join('');
function setHudCollapsed(collapsed) {
  $('#hud-controls').classList.toggle('collapsed', collapsed);
  const btn = $('#btn-hud-toggle');
  btn.textContent = collapsed ? 'Show' : 'Hide';
  btn.setAttribute('aria-expanded', String(!collapsed));
  store.set('ss-hud-collapsed', collapsed ? '1' : '0');
}
setHudCollapsed(store.get('ss-hud-collapsed', '0') === '1');
$('#btn-hud-toggle').addEventListener('click', e => {
  setHudCollapsed(!$('#hud-controls').classList.contains('collapsed'));
  e.currentTarget.blur();   // so Space doesn't "click" it again mid-match
});

// controls overlay
const keysTable = $('#keys');
keysTable.innerHTML = '<tr><th>Action</th><th>Left-hand layout</th><th>Arrow layout</th></tr>' +
  CONTROLS_HELP.map(([a, k1, k2]) => `<tr><td>${a}</td><td>${k1.split(' or ').map(k => `<kbd>${k}</kbd>`).join(' or ')}</td><td>${k2.split(' or ').map(k => `<kbd>${k}</kbd>`).join(' or ')}</td></tr>`).join('');
document.querySelectorAll('[data-open="controls"]').forEach(b => b.addEventListener('click', () => { $('#controls').hidden = false; $('#controls [data-close]').focus(); }));
$('#controls [data-close]').addEventListener('click', () => { $('#controls').hidden = true; });

// ═════════════════════════════════════════════════════════════
// HOST: lobby management
// ═════════════════════════════════════════════════════════════
function startHosting() {
  store.set('ss-name', myName());
  setBusy(true, 'Opening a game…');
  S.role = 'host';
  S.mySlot = 0;
  S.lobby = { code: '', players: [{ slot: 0, name: myName(), char: store.get('ss-char', 'nova'), pid: null }] };
  S.hostInputs = new Map();
  S.net = new HostNet({
    onReady(code) {
      S.lobby.code = code;
      setBusy(false);
      show('lobby');
      renderLobby();
    },
    onJoin() { /* wait for their hello message */ },
    onLeave(pid) {
      const p = S.lobby.players.find(q => q.pid === pid);
      if (!p) return;
      S.lobby.players = S.lobby.players.filter(q => q !== p);
      S.hostInputs.delete(p.slot);
      if (S.game) S.game.removePlayer(p.slot);
      broadcastLobby();
      renderLobby();
    },
    onCtrl(pid, msg) { hostOnCtrl(pid, msg); },
    onGame(pid, msg) { hostOnInput(pid, msg); },
    onError(text) {
      if (S.screen === 'title') { setBusy(false); titleMessage(text); }
      else lobbyMessage(text, true);
    },
  });
}

function hostOnCtrl(pid, msg) {
  switch (msg.t) {
    case 'hello': {
      if (msg.ver !== VERSION) return S.net.kick(pid, { t: 'reject', reason: `Version mismatch (host ${VERSION}, you ${msg.ver}). Refresh the page and try again.` });
      if (S.screen !== 'lobby') return S.net.kick(pid, { t: 'reject', reason: 'A match is in progress. Try again when it ends.' });
      const used = new Set(S.lobby.players.map(p => p.slot));
      const slot = [0, 1, 2, 3].find(s => !used.has(s));
      if (slot === undefined) return S.net.kick(pid, { t: 'reject', reason: 'That game is full (4 players).' });
      const name = String(msg.name || 'Player').slice(0, 14);
      const char = CHARACTERS[msg.char] ? msg.char : 'nova';
      S.lobby.players.push({ slot, name, char, pid });
      S.lobby.players.sort((a, b) => a.slot - b.slot);
      S.net.sendCtrl(pid, { t: 'welcome', slot });
      audio.play('join');
      broadcastLobby(); renderLobby();
      break;
    }
    case 'pick': {
      const p = S.lobby.players.find(q => q.pid === pid);
      if (p && CHARACTERS[msg.char] && S.screen === 'lobby') { p.char = msg.char; broadcastLobby(); renderLobby(); }
      break;
    }
    case 'ping': S.net.sendCtrl(pid, { t: 'pong', ts: msg.ts }); break;
  }
}

function hostOnInput(pid, arr) {
  // arr = [seq, held, c0..c9]
  if (!Array.isArray(arr)) return;
  const p = S.lobby.players.find(q => q.pid === pid);
  if (!p) return;
  let st = S.hostInputs.get(p.slot);
  if (!st) { st = { seq: -1, held: 0, counters: arr.slice(2), pending: 0 }; S.hostInputs.set(p.slot, st); }
  if (arr[0] <= st.seq) return;     // old packet arrived late → ignore
  st.seq = arr[0];
  st.held = arr[1];
  st.pending |= pressedFromCounters(st.counters, arr.slice(2), true);
}

function lobbyPublic() {
  return { code: S.lobby.code, players: S.lobby.players.map(({ slot, name, char }) => ({ slot, name, char })) };
}
function broadcastLobby() { if (S.role === 'host') S.net.broadcastCtrl({ t: 'lobby', lobby: lobbyPublic() }); }

$('#btn-start').addEventListener('click', () => {
  if (S.role !== 'host') return;
  audio.play('ui');
  const counts = {};
  const players = S.lobby.players.map(p => {
    const palette = counts[p.char] = (counts[p.char] ?? -1) + 1;   // same fighter twice → alternate colours
    return { id: p.slot, slot: p.slot, name: p.name, charId: p.char, palette };
  });
  if (players.length === 1) players.push({ id: 9, slot: 3, name: 'Dummy', charId: 'bastion', palette: 2, dummy: true });
  const match = { players, stageId: 'skyforge', stocks: RULES.stocks };
  S.net.broadcastCtrl({ t: 'start', match });
  startHostMatch(match);
});

// ═════════════════════════════════════════════════════════════
// GUEST: joining
// ═════════════════════════════════════════════════════════════
function joinGame(code) {
  store.set('ss-name', myName());
  setBusy(true, `Looking for game ${code}…`);
  S.role = 'guest';
  S.net = new GuestNet(code, {
    onOpen() { S.net.sendCtrl({ t: 'hello', name: myName(), char: store.get('ss-char', 'nova'), ver: VERSION }); },
    onCtrl(msg) { guestOnCtrl(msg); },
    onGame(msg) { guestOnSnapshot(msg); },
    onClose() { leaveToTitle('The host closed the game.'); },
    onError(text) { leaveToTitle(text); },
  });
}

function guestOnCtrl(msg) {
  switch (msg.t) {
    case 'welcome':
      S.mySlot = msg.slot;
      setBusy(false);
      audio.play('join');
      show('lobby');
      startPings();
      break;
    case 'lobby':
      S.lobby = msg.lobby;
      if (S.screen === 'lobby') renderLobby();
      break;
    case 'reject': leaveToTitle(msg.reason); break;
    case 'start': startGuestMatch(msg.match); break;
    case 'results': showResults(msg.results); break;
    case 'toLobby': show('lobby'); renderLobby(); break;
    case 'pong': {
      const rtt = Math.round(performance.now() - msg.ts);
      S.ping = S.ping == null ? rtt : Math.round(S.ping * 0.7 + rtt * 0.3);
      const el = $('#ping');
      el.textContent = `Ping ${S.ping} ms`;
      el.classList.toggle('bad', S.ping > 120);
      break;
    }
  }
}

function startPings() {
  clearInterval(S.pingTimer);
  S.pingTimer = setInterval(() => S.net?.sendCtrl({ t: 'ping', ts: performance.now() }), 2000);
}

// ═════════════════════════════════════════════════════════════
// Lobby UI (same for host and guests)
// ═════════════════════════════════════════════════════════════
const slotCanvases = [];
function renderLobby() {
  $('#lobby-code').textContent = S.lobby.code || '·····';
  const me = S.lobby.players.find(p => p.slot === S.mySlot);

  // player slots
  const ol = $('#slots');
  ol.innerHTML = '';
  slotCanvases.length = 0;
  for (let s = 0; s < RULES.maxPlayers; s++) {
    const p = S.lobby.players.find(q => q.slot === s);
    const li = document.createElement('li');
    li.className = 'slot' + (p ? '' : ' empty');
    li.style.setProperty('--slot', SLOT_COLORS[s]);
    if (p) {
      const cv = document.createElement('canvas');
      cv.width = 112; cv.height = 112;
      slotCanvases.push({ cv, char: p.char });
      const who = document.createElement('div');
      who.className = 'who';
      const you = p.slot === S.mySlot ? ' (you)' : '';
      const host = p.slot === 0 ? ' · host' : '';
      who.innerHTML = `<span class="tag">${SLOT_NAMES[s]}</span><b></b><small>${CHARACTERS[p.char].name}${host}</small>`;
      who.querySelector('b').textContent = p.name + you;   // textContent: never inject names as HTML
      li.append(cv, who);
    } else {
      li.innerHTML = `<div class="who">Waiting for player…</div>`;
    }
    ol.append(li);
  }

  // roster selection state
  document.querySelectorAll('.fighter-card').forEach(card => {
    const id = card.dataset.char;
    card.setAttribute('aria-checked', String(me?.char === id));
    const dots = card.querySelector('.pickers');
    dots.innerHTML = '';
    for (const p of S.lobby.players) if (p.char === id) {
      const i = document.createElement('i'); i.style.background = SLOT_COLORS[p.slot]; i.title = p.name; dots.append(i);
    }
  });

  const n = S.lobby.players.length;
  const start = $('#btn-start');
  if (S.role === 'host') {
    start.hidden = false;
    start.textContent = n === 1 ? 'Practice vs dummy' : `Start match (${n} players)`;
    lobbyMessage(n === 1 ? 'Waiting for friends. Share the code, or practice against a dummy while you wait.' : 'Everyone ready? Start when you are.');
  } else {
    start.hidden = true;
    lobbyMessage('Waiting for the host to start the match…');
  }
}

function lobbyMessage(text, isError = false) {
  const m = $('#lobby-msg'); m.textContent = text; m.classList.toggle('error', isError);
}

// Build the 4 fighter cards once
const rosterCards = [];
for (const id of CHARACTER_ORDER) {
  const c = CHARACTERS[id];
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'fighter-card';
  card.dataset.char = id;
  card.setAttribute('role', 'radio');
  const specials = c.specials.map(([dir, name, desc]) =>
    `<span class="sp"><span class="sp-dir">${dir}</span><span class="sp-txt"><b>${name}</b> ${desc}</span></span>`).join('');
  card.innerHTML = `<canvas width="440" height="300"></canvas><span class="nm">${c.name}</span><span class="rl">${c.role}</span><span class="bl">${c.blurb}</span>` +
    `<span class="specials"><span class="sp-head">Specials</span>${specials}</span><span class="pickers"></span>`;
  card.addEventListener('click', () => pickChar(id));
  $('#roster').append(card);
  rosterCards.push({ id, cv: card.querySelector('canvas'), card });
}

function pickChar(id) {
  audio.unlock(); audio.play('ui');
  store.set('ss-char', id);
  if (S.role === 'host') {
    const me = S.lobby.players.find(p => p.slot === 0);
    if (me) me.char = id;
    broadcastLobby(); renderLobby();
  } else {
    S.net?.sendCtrl({ t: 'pick', char: id });
    const me = S.lobby.players.find(p => p.slot === S.mySlot);
    if (me) { me.char = id; renderLobby(); }   // optimistic: the host will confirm
  }
}

$('#btn-copy').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?join=${S.lobby.code}`;
  try { await navigator.clipboard.writeText(url); lobbyMessage('Invite link copied. Paste it to your friends.'); }
  catch { lobbyMessage(`Share this link: ${url}`); }
});
$('#btn-leave-lobby').addEventListener('click', () => { audio.play('uiBack'); leaveToTitle(''); });

function leaveToTitle(message) {
  clearInterval(S.pingTimer);
  if (S.role === 'host') S.net?.broadcastCtrl({ t: 'reject', reason: 'The host closed the game.' });
  const net = S.net;
  S.net = null; S.game = null; S.role = null; S.match = null; S.ping = null;
  setTimeout(() => net?.close(), 150);
  $('#ping').textContent = '';
  $('#pause').hidden = true;
  setBusy(false);
  show('title');
  titleMessage(message);
}

// ═════════════════════════════════════════════════════════════
// Matches
// ═════════════════════════════════════════════════════════════
function processEvents(list) {
  for (const e of list) {
    if (e.id <= S.lastEventId) continue;
    S.lastEventId = e.id;
    gameR.onEvent(e);
    audio.onEvent(e);
  }
}

function beginMatchCommon(match) {
  S.match = match;
  S.lastEventId = 0;
  S.lastCount = null;
  S.resultsSent = false;
  gameR.setMatch(match);
  show('game');
  audio.unlock();
}

// ── HOST LOOP ─────────────────────────────────────────────────
// Fixed timestep: the simulation always advances in exact 1/60 s steps,
// no matter the monitor's refresh rate. We collect real elapsed time
// in an "accumulator" and run as many whole steps as fit.
function startHostMatch(match) {
  beginMatchCommon(match);
  S.game = new Game({ players: match.players, stageId: match.stageId, stocks: match.stocks });
  for (const st of S.hostInputs.values()) st.pending = 0;
  kb.sample();     // discard presses from the menu
  let last = performance.now(), acc = 0;
  const g = S.game;

  const frame = now => {
    if (S.game !== g || S.screen !== 'game' && S.screen !== 'results') return;
    acc += Math.min(250, now - last); last = now;
    let steps = 0;
    while (acc >= STEP_MS && steps < 5) {
      const local = kb.sample();
      g.setInput(0, local.held, (g.inputs.get(0)?.pressed || 0) | local.pressed);
      for (const [slot, st] of S.hostInputs) {
        g.setInput(slot, st.held, (g.inputs.get(slot)?.pressed || 0) | st.pending);
        st.pending = 0;
      }
      g.step();
      S.net?.broadcastGame(g.snapshot());
      acc -= STEP_MS; steps++;
    }
    if (acc > STEP_MS * 5) acc = 0;   // way behind (tab was hidden) → don't try to catch up
    const snap = g.snapshot();
    processEvents(snap.E);
    countdownBeeps(snap);
    if (S.screen === 'game') gameR.draw(snap);

    if (g.phase === 'over' && g.overT > 150 && !S.resultsSent) {
      S.resultsSent = true;
      const results = g.results();
      S.net?.broadcastCtrl({ t: 'results', results });
      showResults(results);
      return;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ── GUEST LOOP ────────────────────────────────────────────────
// We draw ~3 frames in the past and blend between the two snapshots
// around that moment. Costs ~50 ms of delay, buys smooth motion even
// when packets arrive unevenly.
const INTERP_DELAY = 3;
function startGuestMatch(match) {
  beginMatchCommon(match);
  S.snaps = [];
  S.playF = null;
  let seq = 0, last = performance.now(), lastSend = 0;
  const token = S.match;

  const frame = now => {
    if (S.match !== token || S.screen !== 'game') return;
    const dt = Math.min(100, now - last); last = now;
    if (now - lastSend >= 14) { S.net?.sendGame(kb.packet(seq++)); lastSend = now; }

    const snaps = S.snaps;
    if (snaps.length) {
      const newest = snaps[snaps.length - 1].f;
      const target = newest - INTERP_DELAY;
      if (S.playF === null || Math.abs(target - S.playF) > 12) S.playF = target;
      else S.playF += dt / STEP_MS + (target - S.playF) * 0.08;   // run at real speed, gently steer toward target
      const snap = sampleSnapshots(snaps, S.playF);
      processEvents(snap.E.filter(e => e.f <= S.playF + 1));
      countdownBeeps(snap);
      gameR.draw(snap);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function guestOnSnapshot(s) {
  if (!S.snaps || !s || typeof s.f !== 'number') return;
  const arr = S.snaps;
  if (arr.length && s.f <= arr[arr.length - 1].f) return;   // out of order → drop
  arr.push(s);
  if (arr.length > 40) arr.shift();
}

function sampleSnapshots(arr, f) {
  let b = arr.findIndex(s => s.f >= f);
  if (b === -1) return arr[arr.length - 1];
  if (b === 0) return arr[0];
  const A = arr[b - 1], B = arr[b];
  const t = (f - A.f) / (B.f - A.f);
  const lerpObj = (oa, ob, keyFields) => {
    if (!oa) return ob;
    if (Math.abs(oa.x - ob.x) > 200 || Math.abs(oa.y - ob.y) > 200) return ob;   // teleport/respawn → don't blend
    const o = { ...ob };
    for (const k of keyFields) o[k] = oa[k] + (ob[k] - oa[k]) * t;
    return o;
  };
  return {
    ...B,
    E: B.E,
    F: B.F.map(fb => lerpObj(A.F.find(q => q.i === fb.i), fb, ['x', 'y'])),
    P: B.P.map(pb => lerpObj(A.P.find(q => q.i === pb.i), pb, ['x', 'y'])),
  };
}

function countdownBeeps(snap) {
  if (snap.ph !== 'countdown') return;
  const n = Math.ceil((RULES.countdownFrames - snap.f) / 60);
  if (n !== S.lastCount && n > 0) { S.lastCount = n; audio.play('count'); }
}

// ── Pause menu (match keeps running) ──────────────────────────
function togglePause(open) {
  $('#pause').hidden = !open;
  kb.enabled = !open && S.screen === 'game';
  if (open) $('#btn-resume').focus();
}
window.addEventListener('keydown', e => {
  if (e.code !== 'Escape') return;
  if (!$('#controls').hidden) { $('#controls').hidden = true; return; }
  if (S.screen === 'game') togglePause($('#pause').hidden);
});
$('#btn-pause').addEventListener('click', () => togglePause(true));
$('#btn-resume').addEventListener('click', () => togglePause(false));
$('#btn-quit').addEventListener('click', () => leaveToTitle(S.role === 'host' ? 'You closed the game.' : 'You left the match.'));

// ═════════════════════════════════════════════════════════════
// Results
// ═════════════════════════════════════════════════════════════
const resultCanvases = [];
function showResults(results) {
  S.results = results;
  $('#pause').hidden = true;
  show('results');
  const ol = $('#results');
  ol.innerHTML = '';
  resultCanvases.length = 0;
  const winner = results[0];
  $('#results-title').textContent = winner.dummy ? 'The dummy wins?!' : `${winner.name} wins!`;
  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'result';
    li.style.setProperty('--slot', SLOT_COLORS[r.slot]);
    const cv = document.createElement('canvas'); cv.width = 168; cv.height = 144;
    resultCanvases.push({ cv, r });
    li.innerHTML = `<span class="place">${r.place}</span>`;
    const info = document.createElement('div');
    info.innerHTML = `<div class="nm"></div><div class="ch">${CHARACTERS[r.charId].name}${r.left ? ' · left the match' : ''}</div>`;
    info.querySelector('.nm').textContent = r.name;
    const stats = document.createElement('div');
    stats.className = 'stats';
    stats.innerHTML = `<span><b>${r.kos}</b>KOs</span><span><b>${r.falls}</b>Falls</span><span><b>${Math.round(r.dealt)}%</b>Dealt</span>`;
    li.append(li.firstChild, cv, info, stats);
    ol.append(li);
  }
  const host = S.role === 'host';
  $('#btn-lobby').hidden = !host;
  $('#results-msg').textContent = host ? '' : 'Waiting for the host to go back to the lobby…';
}

$('#btn-lobby').addEventListener('click', () => {
  if (S.role !== 'host') return;
  audio.play('ui');
  S.game = null;
  S.net.broadcastCtrl({ t: 'toLobby' });
  broadcastLobby();
  show('lobby');
  renderLobby();
});

// ═════════════════════════════════════════════════════════════
// Menu animation: sky + idling fighters on the title, live previews
// ═════════════════════════════════════════════════════════════
let menuT = 0;
function resizeScene() { sceneR.resize(); gameR.resize(); }
window.addEventListener('resize', resizeScene);
resizeScene();
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function menuFrame() {
  requestAnimationFrame(menuFrame);
  if (S.screen === 'game') return;
  menuT += reduceMotion ? 0.25 : 1;
  const ctx = sceneR.ctx;
  ctx.setTransform(sceneR.dpr, 0, 0, sceneR.dpr, 0, 0);
  sceneR.t = menuT;
  sceneR.cam = { x: Math.sin(menuT * 0.002) * 120, y: -160, z: Math.min(sceneR.W / 1500, sceneR.H / 900) * 1.2 };
  sceneR.drawBackground(ctx);

  if (S.screen === 'title') drawTitleScene(ctx);

  for (const r of rosterCards) {
    const c = r.cv.getContext('2d');
    c.clearRect(0, 0, r.cv.width, r.cv.height);
    const ch = CHARACTERS[r.id];
    const selected = r.card.getAttribute('aria-checked') === 'true';
    drawFighterPreview(c, r.id, 0, 220, 250, 2.3 * 72 / ch.h, menuT, 1, selected ? 'run' : 'idle');
  }
  for (const s of slotCanvases) {
    const c = s.cv.getContext('2d');
    c.clearRect(0, 0, 112, 112);
    const ch = CHARACTERS[s.char];
    drawFighterPreview(c, s.char, 0, 56, 100, 1.15 * 72 / ch.h, menuT, 1);
  }
  for (const { cv, r } of resultCanvases) {
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    const ch = CHARACTERS[r.charId];
    drawFighterPreview(c, r.charId, r.palette, 84, 132, 1.5 * 72 / ch.h, menuT, 1, r.place === 1 ? 'run' : 'idle');
  }
}

function drawTitleScene(ctx) {
  const W = sceneR.W, H = sceneR.H;
  const wide = W > 860;
  const cx = wide ? W * 0.68 : W * 0.5;
  const base = wide ? H * 0.74 : H * 0.92;
  const sc = Math.min(W / (wide ? 1300 : 700), H / 820) * 1.5;
  // floating slab
  ctx.save();
  ctx.translate(cx, base + Math.sin(menuT * 0.02) * 4);
  ctx.scale(sc, sc);
  const w = 300;
  ctx.fillStyle = '#2c2160'; ctx.strokeStyle = '#120c2e'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(-w, 0); ctx.lineTo(w, 0); ctx.lineTo(w - 40, 50); ctx.lineTo(0, 120); ctx.lineTo(-w + 40, 50); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffe7a8'; ctx.fillRect(-w, -3, w * 2, 8);
  ctx.fillStyle = '#ff8f6b'; ctx.fillRect(-w, 5, w * 2, 4);
  const spots = [['zip', -210, 1], ['nova', -75, 1], ['prism', 70, -1], ['bastion', 205, -1]];
  for (const [id, x, fa] of spots) drawFighterPreview(ctx, id, 0, x, -2, 1.25, menuT + x, fa);
  ctx.restore();
}
requestAnimationFrame(menuFrame);

// Unlock audio on first interaction anywhere
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
window.addEventListener('keydown', () => audio.unlock(), { once: true });

if (joinParam) { $('#code').focus(); titleMessage(`Press Join to enter game ${joinParam}.`, false); }

// Expose for debugging in the console: window.SS
window.SS = S;
