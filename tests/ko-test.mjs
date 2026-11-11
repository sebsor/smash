// Measures at what % each strong move KOs, from centre stage and from the ledge.
// This is how the knockback constants in config.js were tuned.
// Run:  node tests/ko-test.mjs
import { Game } from '../js/game.js';
import { CHARACTER_ORDER, CHARACTERS } from '../js/characters.js';

function trial(atk, def, move, pct, startX, opts = {}) {
  const g = new Game({ players: [
    { id: 0, slot: 0, name: 'A', charId: atk },
    { id: 1, slot: 1, name: 'B', charId: def, dummy: true },
  ] });
  g.phase = 'play';
  const [a, b] = g.fighters;
  a.x = startX; a.facing = 1; b.dmg = pct;
  const m = CHARACTERS[atk].moves[move];
  // place the target where the first hitbox lands
  const h = m.hb[m.hb.length - 1];
  b.x = startX + h.x * (h.x < 0 ? -1 : 1);
  if (h.x < 0) a.facing = -1;
  if (opts.air) { a.y = b.y = -200; a.ground = b.ground = null; b.x = startX + Math.abs(h.x); }
  a.startMove(move, g);
  let hitAt = -1;
  for (let i = 0; i < 400; i++) {
    g.step();
    if (hitAt < 0 && g.events.some(e => e.t === 'hit' && e.f === g.frame)) hitAt = i;
    const ko = g.events.find(e => e.t === 'ko' && e.f === g.frame);
    // A real KO = sent through the side/top blast zone while still flying from the hit.
    // (Falling off the bottom later doesn't count — a real player would have recovered.)
    if (ko) return ko.side !== 'bottom' && hitAt >= 0 && i - hitAt < 150;
  }
  return false;
}

function koPercent(atk, def, move, x, opts) {
  for (let p = 0; p <= 300; p += 5) if (trial(atk, def, move, p, x, opts)) return p;
  return '>300';
}

const rows = [];
for (const c of CHARACTER_ORDER) {
  for (const mv of ['fsmash', 'usmash', 'bair', 'fthrow', 'nspec']) {
    const m = CHARACTERS[c].moves[mv];
    if (!m.hb && !m.throwHit) continue;
    if (m.throwHit) continue;
    rows.push({
      char: c, move: mv,
      'vs nova centre': koPercent(c, 'nova', mv, 0),
      'vs nova at ledge': koPercent(c, 'nova', mv, 380),
      'vs zip centre': koPercent(c, 'zip', mv, 0),
      'vs bastion centre': koPercent(c, 'bastion', mv, 0),
    });
  }
}
console.table(rows);
