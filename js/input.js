// ─────────────────────────────────────────────────────────────
// input.js — keyboard → buttons.
//
// We track two things per button:
//   held:     is it down right now? (bit flags, one number)
//   counters: how many times has it been PRESSED? (wraps at 256)
// Why counters? Over an unreliable network a packet can be lost.
// If we sent "attack was pressed this frame" and that packet vanished,
// the press is gone. With counters the host sees "attack count went
// 41 → 42" in the NEXT packet that arrives, so no press is ever lost.
// ─────────────────────────────────────────────────────────────

import { BTN, BTN_NAMES } from './config.js';

// Two layouts work at the same time — use whichever feels better.
// A key can press several buttons: W is "up" AND a jump (Smash calls this tap jump).
export const KEYMAP = {
  KeyA: 'LEFT', KeyD: 'RIGHT', KeyW: ['UP', 'TAPJUMP'], KeyS: 'DOWN',
  ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN',
  Space: 'JUMP',
  KeyJ: 'ATTACK', KeyZ: 'ATTACK',
  KeyK: 'SPECIAL', KeyX: 'SPECIAL',
  KeyI: 'SMASH', KeyC: 'SMASH',
  KeyL: 'SHIELD', KeyV: 'SHIELD', ShiftLeft: 'SHIELD', ShiftRight: 'SHIELD',
  Semicolon: 'GRAB', KeyB: 'GRAB',
};

export const CONTROLS_HELP = [
  ['Move', 'W A S D', 'Arrow keys'],
  ['Jump', 'Space or W', 'Space'],
  ['Attack', 'J', 'Z'],
  ['Special', 'K', 'X'],
  ['Smash attack (hold to charge)', 'I', 'C'],
  ['Shield / dodge', 'L or Shift', 'V or Shift'],
  ['Grab', ';', 'B'],
];

export class KeyboardInput {
  constructor() {
    this.held = 0;
    this.counters = new Array(BTN_NAMES.length).fill(0);
    this.lastSampled = this.counters.slice();
    this.enabled = false;
    this.keysDown = new Set();

    window.addEventListener('keydown', e => {
      const b = KEYMAP[e.code];
      if (!b || !this.enabled) return;
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();               // stop Space/arrows from scrolling the page
      if (e.repeat || this.keysDown.has(e.code)) return;
      this.keysDown.add(e.code);
      for (const name of [].concat(b)) {
        const bit = BTN[name];
        if (!(this.held & bit)) {
          const i = Math.log2(bit);
          this.counters[i] = (this.counters[i] + 1) & 255;
        }
      }
      this.recompute();
    });
    window.addEventListener('keyup', e => {
      if (!KEYMAP[e.code]) return;
      this.keysDown.delete(e.code);
      this.recompute();
    });
    // Losing focus (alt-tab) would otherwise leave keys "stuck" down.
    window.addEventListener('blur', () => { this.keysDown.clear(); this.held = 0; });
  }

  recompute() {
    let h = 0;
    for (const code of this.keysDown) for (const name of [].concat(KEYMAP[code])) h |= BTN[name];
    this.held = h;
  }

  /** For the local player on the host: held bits + which buttons were pressed since last call. */
  sample() {
    return { held: this.held, pressed: pressedFromCounters(this.lastSampled, this.counters, true) };
  }

  /** Compact message for the network: [seq, held, c0, c1, …] */
  packet(seq) { return [seq, this.held, ...this.counters]; }
}

/** Compare two counter arrays → bitmask of buttons pressed in between. */
export function pressedFromCounters(prev, next, update = false) {
  let mask = 0;
  for (let i = 0; i < next.length; i++) {
    if (prev[i] !== next[i]) { mask |= 1 << i; if (update) prev[i] = next[i]; }
  }
  return mask;
}
