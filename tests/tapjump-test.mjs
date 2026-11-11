// Checks the W "tap jump" rules: W+K = up-special, W+J = up-tilt, W alone = jump,
// and in the air W+attack/special doesn't waste your double jump.
// Run:  node tests/tapjump-test.mjs
import { Game } from '../js/game.js';
import { BTN } from '../js/config.js';

const W = BTN.UP | BTN.TAPJUMP;
let fails = 0;
function check(name, cond, info) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  → ' + info}`); if (!cond) fails++; }

function setup() {
  const g = new Game({ players: [{ id: 0, slot: 0, name: 'A', charId: 'nova' }] });
  g.phase = 'play';
  return [g, g.fighters[0]];
}
function frame(g, held, pressed = 0) { g.setInput(0, held, pressed); g.step(); }
function run(g, n, held = 0) { for (let i = 0; i < n; i++) frame(g, held); }

{ // W + K together on the ground → up-special (not a wasted jump)
  const [g, f] = setup();
  frame(g, W | BTN.SPECIAL, W | BTN.SPECIAL); run(g, 3, W);
  check('ground: W+K → up-special', f.state === 'attack' && f.move === 'uspec', `${f.state}/${f.move}`);
}
{ // W then K two frames later (still inside jump squat) → up-special
  const [g, f] = setup();
  frame(g, W, W); run(g, 1, W); frame(g, W | BTN.SPECIAL, BTN.SPECIAL); run(g, 1, W);
  check('ground: W, then K 2 frames later → up-special', f.move === 'uspec', `${f.state}/${f.move}`);
}
{ // W + J → up-tilt
  const [g, f] = setup();
  frame(g, W | BTN.ATTACK, W | BTN.ATTACK); run(g, 2, W);
  check('ground: W+J → up-tilt', f.move === 'utilt' && !f.airborne, `${f.state}/${f.move} airborne=${f.airborne}`);
}
{ // Space + J → jump then up-air? No: Space+J is a jump; J becomes an aerial (neutral air since no direction)
  const [g, f] = setup();
  frame(g, BTN.JUMP | BTN.ATTACK, BTN.JUMP | BTN.ATTACK); run(g, 6, BTN.JUMP);
  check('ground: Space+J → jump + aerial (unchanged behaviour)', f.airborne && f.move === 'nair', `${f.state}/${f.move}`);
}
{ // W alone → jump; hold = full hop
  const [g, f] = setup();
  frame(g, W, W); run(g, 12, W);
  check('ground: W → jump', f.airborne && f.state === 'air', `${f.state}`);
  check('W jump keeps double jump', f.airJumps === 1, `airJumps=${f.airJumps}`);
  // tap W again in the air → double jump (after the 3-frame grace)
  run(g, 3, 0); frame(g, W, W); run(g, 4, W);
  check('air: W → double jump', f.airJumps === 0 && f.djT < 10, `airJumps=${f.airJumps} djT=${f.djT}`);
}
{ // In the air: W + K → up-special, double jump NOT used
  const [g, f] = setup();
  frame(g, BTN.JUMP, BTN.JUMP); run(g, 15, 0);
  frame(g, W | BTN.SPECIAL, W | BTN.SPECIAL); run(g, 6, W);
  check('air: W+K → up-special', f.move === 'uspec', `${f.state}/${f.move}`);
  check('air: W+K keeps double jump', f.airJumps === 1, `airJumps=${f.airJumps}`);
}
{ // In the air: W, then J 2 frames later → up-air, double jump kept
  const [g, f] = setup();
  frame(g, BTN.JUMP, BTN.JUMP); run(g, 15, 0);
  frame(g, W, W); frame(g, W); frame(g, W | BTN.ATTACK, BTN.ATTACK); run(g, 5, W);
  check('air: W then J → up-air', f.move === 'uair', `${f.state}/${f.move}`);
  check('air: W then J keeps double jump', f.airJumps === 1, `airJumps=${f.airJumps}`);
}
process.exit(fails ? 1 : 0);
