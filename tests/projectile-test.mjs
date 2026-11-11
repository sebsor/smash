// Regression test: projectiles must spawn next to the fighter who fired them,
// wherever that fighter is (ground, platform, mid-air) and whichever way they face.
// Bug it guards against: spawn position was overwritten by the move's raw offset.
// Run:  node tests/projectile-test.mjs
import { Game } from '../js/game.js';
import { BTN } from '../js/config.js';

const cases = [
  // [character, extra button (side special), where]
  ['prism', 0, 'main stage, facing right', { x: -200, y: 0, ground: 0, facing: 1 }],
  ['prism', 0, 'left platform', { x: -230, y: -165, ground: 1, facing: 1 }],
  ['prism', 0, 'mid-air, facing left', { x: 250, y: -400, ground: null, facing: -1 }],
  ['prism', BTN.RIGHT, 'boomerang on top platform', { x: 0, y: -315, ground: 3, facing: 1 }],
  ['nova', 0, 'star ball mid-air', { x: -350, y: -300, ground: null, facing: 1 }],
];

let fails = 0;
for (const [charId, extra, where, pos] of cases) {
  const g = new Game({ players: [{ id: 0, slot: 0, name: 'A', charId }] });
  g.phase = 'play';
  const f = g.fighters[0];
  Object.assign(f, pos);
  if (pos.ground === null) f.setState('air');
  g.setInput(0, BTN.SPECIAL | extra, BTN.SPECIAL | extra);
  let p;
  for (let i = 0; i < 20 && !p; i++) { g.step(); g.setInput(0, 0, 0); p = g.projectiles[0]; }
  // Measure from the fighter's position at the moment of firing (they may drift in the air).
  const dx = p ? (p.x - p.vx) - f.x : NaN, dy = p ? (p.y - p.vy) - f.y : NaN;
  const ok = p && Math.abs(dx) < 80 && dy < 0 && dy > -f.h * 1.2 && Math.sign(p.vx) === f.facing;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${charId} ${where}: spawned ${p ? `${dx.toFixed(0)}px ahead, ${(-dy).toFixed(0)}px up, moving ${p.vx > 0 ? 'right' : 'left'}` : 'nothing'}`);
  if (!ok) fails++;
}
process.exit(fails ? 1 : 0);
