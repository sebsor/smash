// Fuzz test: 4 fighters press random buttons for many frames.
// Catches crashes, NaN positions and fighters stuck in a state forever.
// Run:  node tests/fuzz-test.mjs
import { Game } from '../js/game.js';
import { BTN, RULES } from '../js/config.js';
import { CHARACTER_ORDER } from '../js/characters.js';

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const FRAMES = +(process.argv[2] || 60000);
let failures = 0, matches = 0, kos = 0;
const stateCounts = {};

function makeGame() {
  return new Game({
    players: CHARACTER_ORDER.map((c, i) => ({ id: i, slot: i, name: 'P' + (i + 1), charId: c, palette: 0 })),
    stocks: 3,
  });
}

let g = makeGame();
const held = [0, 0, 0, 0];
const stuck = [0, 0, 0, 0], lastState = ['', '', '', ''];

for (let fr = 0; fr < FRAMES; fr++) {
  for (let i = 0; i < 4; i++) {
    // Random "human-ish" input: hold directions for a while, tap action buttons.
    let h = held[i], pressed = 0;
    if (rand() < 0.08) {
      h &= ~(BTN.LEFT | BTN.RIGHT | BTN.UP | BTN.DOWN);
      const r = rand();
      if (r < 0.3) h |= BTN.LEFT; else if (r < 0.6) h |= BTN.RIGHT;
      // drift toward the centre so fighters actually meet
      const f = g.fighters[i];
      if (rand() < 0.5 && f) { h &= ~(BTN.LEFT | BTN.RIGHT); h |= f.x > 0 ? BTN.LEFT : BTN.RIGHT; }
      const r2 = rand(); if (r2 < 0.15) h |= BTN.UP; else if (r2 < 0.25) h |= BTN.DOWN;
    }
    for (const b of [BTN.JUMP, BTN.ATTACK, BTN.SPECIAL, BTN.SMASH, BTN.SHIELD, BTN.GRAB]) {
      if (h & b) { if (rand() < 0.2) h &= ~b; }
      else if (rand() < (b === BTN.SHIELD ? 0.01 : 0.025)) { h |= b; pressed |= b; }
    }
    const newDirs = h & ~held[i] & (BTN.LEFT | BTN.RIGHT | BTN.UP | BTN.DOWN);
    pressed |= newDirs;
    held[i] = h;
    g.setInput(i, h, pressed);
  }
  try { g.step(); }
  catch (e) { console.error('CRASH at frame', g.frame, e); failures++; break; }

  for (const f of g.fighters) {
    stateCounts[f.state] = (stateCounts[f.state] || 0) + 1;
    for (const k of ['x', 'y', 'vx', 'vy', 'kvx', 'kvy', 'dmg']) {
      if (!Number.isFinite(f[k])) { console.error(`NaN: fighter ${f.id} ${k}=${f[k]} state=${f.state} move=${f.move} frame=${g.frame}`); failures++; }
    }
    if (f.state === lastState[f.id] && !['out', 'idle', 'air', 'run', 'shield', 'crouch', 'ledge', 'helpless', 'tumble'].includes(f.state)) {
      if (++stuck[f.id] > 900) { console.error(`STUCK: fighter ${f.id} in ${f.state} for 900 frames (move ${f.move})`); failures++; stuck[f.id] = -1e9; }
    } else stuck[f.id] = 0;
    lastState[f.id] = f.state;
  }
  if (failures > 5) break;
  for (const e of g.events) if (e.t === 'ko' && e.f === g.frame) kos++;
  if (g.phase === 'over' && g.overT > 10) { matches++; g = makeGame(); }
}

console.log(`frames=${FRAMES} matchesFinished=${matches} kos=${kos} failures=${failures}`);
console.log('state time share:', Object.entries(stateCounts).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${(n / FRAMES / 4 * 100).toFixed(1)}%`).join(' '));
process.exit(failures ? 1 : 0);
