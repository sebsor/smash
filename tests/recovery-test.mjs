// Can each fighter get back to the ledge from off-stage?
// Script: drift toward stage, double jump(s) at the peak, then up-special toward the ledge.
// Run:  node tests/recovery-test.mjs
import { Game } from '../js/game.js';
import { BTN } from '../js/config.js';
import { CHARACTER_ORDER } from '../js/characters.js';

function attempt(charId, dist, depth) {
  const g = new Game({ players: [{ id: 0, slot: 0, name: 'A', charId }] });
  g.phase = 'play';
  const f = g.fighters[0];
  const L = g.stage.ledges[1];
  f.x = L.x + dist; f.y = L.y + depth; f.ground = null; f.setState('air'); f.vy = 6; f.facing = -1;
  let usedUp = false;
  for (let i = 0; i < 400; i++) {
    let held = BTN.LEFT, pressed = 0;
    // double jump when falling, then up-special when out of jumps
    if (f.state === 'air' && f.vy > 0 && f.airJumps > 0) { held |= BTN.JUMP; pressed |= BTN.JUMP; }
    else if (f.state === 'air' && f.vy > 0 && f.airJumps === 0 && !usedUp) {
      held |= BTN.UP | BTN.SPECIAL; pressed |= BTN.SPECIAL; usedUp = true;
      if (charId === 'zip' || charId === 'prism') held |= BTN.LEFT;  // 8-way recoveries aim diagonally
    } else if (usedUp && f.state === 'attack') held |= BTN.UP;
    g.setInput(0, held, pressed);
    g.step();
    if (f.state === 'ledge' || f.ground !== null) return true;
    if (f.state === 'dead') return false;
  }
  return false;
}

const rows = [];
for (const c of CHARACTER_ORDER) {
  const row = { char: c };
  for (const [d, dep] of [[150, 100], [300, 100], [400, 150], [500, 200], [600, 250]]) {
    row[`${d}px out, ${dep}px low`] = attempt(c, d, dep) ? 'ok' : 'FAIL';
  }
  rows.push(row);
}
console.table(rows);
