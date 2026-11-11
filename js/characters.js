// ─────────────────────────────────────────────────────────────
// characters.js — the 4 fighters, defined as DATA.
//
// A move is mostly a list of hitboxes: "between frame s and e, a circle
// of radius r sits at (x, y) relative to my feet, and if it touches
// someone it deals dmg and launches at angle ang".
//   • x is measured in the direction you FACE (so we never write left/right twice)
//   • y is negative = above your feet (canvas y grows downward)
//   • ang: 0 = straight forward, 90 = straight up, 270 = straight down (a "meteor")
//   • bkb = base knockback (always applied), kbg = knockback growth (scales with %)
//   • limb tells the RENDERER which hand/foot to swing there, so the animation
//     is generated from the same numbers that decide the hit. One source of truth.
//
// Specials need custom behaviour (dashing, teleporting, projectiles…), so they
// get an onFrame(fighter, game, frame) hook that the simulation calls each frame.
// ─────────────────────────────────────────────────────────────

import { BTN } from './config.js';

// Hitbox helper — keeps the move tables readable.
function H(s, e, x, y, r, dmg, ang, bkb, kbg, limb = 'hand', extra = {}) {
  return { s, e, x, y, r, dmg, ang, bkb, kbg, limb, ...extra };
}

// Read the 8-way direction a player is holding (used by recovery moves).
function heldDir(f, fallbackUp = true) {
  let dx = (f.input.held & BTN.RIGHT ? 1 : 0) - (f.input.held & BTN.LEFT ? 1 : 0);
  let dy = (f.input.held & BTN.DOWN ? 1 : 0) - (f.input.held & BTN.UP ? 1 : 0);
  if (!dx && !dy && fallbackUp) dy = -1;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

// ── Shared "normal" moveset, scaled per character ─────────────
// p.sp = speed multiplier for frame counts (lower = faster)
// p.pw = damage multiplier, p.rc = reach multiplier, p.kb = knockback growth multiplier
function makeNormals(c, p) {
  const F = n => Math.max(1, Math.round(n * p.sp));
  const R = c.w / 2 + 16 * p.rc;          // "arm's length" for this body size
  const h = c.h;
  const d = n => +(n * p.pw).toFixed(1);  // damage helper
  const g = n => Math.round(n * p.kb);    // growth helper
  const r = n => Math.round(n * p.rc);    // radius helper

  return {
    // ── Ground ──
    jab: { total: F(17), hb: [H(F(3), F(5), R * 0.95, -h * 0.55, r(15), d(3.5), 35, 18, 30, 'hand')] },
    ftilt: { total: F(28), hb: [H(F(7), F(9), R * 1.15, -h * 0.42, r(18), d(8), 36, 24, g(95), 'foot')] },
    utilt: {
      total: F(29), hb: [
        H(F(6), F(7), R * 0.8, -h * 0.75, r(18), d(7), 95, 34, g(110), 'hand'),
        H(F(8), F(11), R * 0.05, -h * 1.15, r(21), d(7), 92, 34, g(110), 'hand'),
      ],
    },
    dtilt: { total: F(22), pose: 'crouch', hb: [H(F(6), F(8), R * 1.15, -9, r(15), d(6), 78, 30, g(70), 'foot')] },
    dash: { total: F(38), slide: 0.965, hb: [H(F(7), F(12), R * 0.75, -h * 0.45, r(22), d(10), 52, 42, g(85), 'body')] },

    // Smash attacks: hold the smash button to charge at frame `charge` (up to 60 frames, ×1.4 dmg)
    fsmash: {
      total: F(54), charge: F(10), smash: true,
      hb: [H(F(17), F(19), R * 1.35, -h * 0.5, r(22), d(16), 38, 34, g(100), 'hand', { scaleCharge: 0.4 })],
    },
    usmash: {
      total: F(49), charge: F(8), smash: true,
      hb: [
        H(F(12), F(13), R * 0.95, -h * 0.65, r(20), d(13), 88, 34, g(112), 'hand', { scaleCharge: 0.4 }),
        H(F(14), F(17), R * 0.1, -h * 1.3, r(25), d(15), 90, 36, g(110), 'hand', { scaleCharge: 0.4 }),
      ],
    },
    dsmash: {
      total: F(47), charge: F(6), smash: true, pose: 'crouch',
      hb: [
        H(F(10), F(12), R * 1.2, -9, r(18), d(13), 30, 32, g(98), 'foot', { scaleCharge: 0.4 }),
        H(F(16), F(18), -R * 1.2, -9, r(18), d(13), 150, 32, g(98), 'foot2', { scaleCharge: 0.4 }),
      ],
    },

    // ── Aerials (land = landing lag if you touch the ground mid-move) ──
    nair: {
      total: F(36), land: 7, spin: [F(5), F(20), 1],
      hb: [
        H(F(5), F(8), R * 0.55, -h * 0.5, r(27), d(10), 45, 28, g(90), 'body', { g: 'a' }),
        H(F(9), F(20), R * 0.5, -h * 0.5, r(23), d(6), 45, 20, g(80), 'body', { g: 'a' }),
      ],
    },
    fair: {
      total: F(40), land: 11,
      hb: [
        H(F(10), F(11), R * 0.85, -h * 0.95, r(19), d(12), 42, 30, g(95), 'hand'),
        H(F(12), F(14), R * 1.15, -h * 0.4, r(20), d(12), 42, 30, g(95), 'hand'),
      ],
    },
    bair: { total: F(36), land: 10, hb: [H(F(8), F(11), -R * 1.15, -h * 0.5, r(20), d(13), 140, 32, g(106), 'foot2')] },
    uair: {
      total: F(32), land: 7,
      hb: [
        H(F(6), F(7), R * 0.7, -h * 1.0, r(20), d(8), 85, 30, g(100), 'foot'),
        H(F(8), F(10), -R * 0.25, -h * 1.25, r(22), d(8), 85, 30, g(100), 'foot'),
      ],
    },
    dair: { total: F(44), land: 15, hb: [H(F(14), F(17), R * 0.1, h * 0.2, r(21), d(13), 270, 22, g(82), 'foot')] },

    // ── Grab & throws ──
    grab: { total: F(30), hb: [H(F(6), F(8), R * 0.85, -h * 0.5, r(19), 0, 0, 0, 0, 'hand', { grab: true })] },
    pummel: { total: 14, pummel: { f: 4, dmg: d(1.5) } },
    fthrow: { total: 30, throwHit: { f: 12, dmg: d(8), ang: 40, bkb: 60, kbg: g(60), dir: 1 } },
    bthrow: { total: 32, throwHit: { f: 14, dmg: d(10), ang: 135, bkb: 60, kbg: g(72), dir: -1 } },
    uthrow: { total: 30, throwHit: { f: 12, dmg: d(7), ang: 90, bkb: 70, kbg: g(60), dir: 0 } },
    dthrow: { total: 30, throwHit: { f: 12, dmg: d(6), ang: 75, bkb: 48, kbg: g(38), dir: 0 } },

    // Getting up from lying on the floor while attacking
    getupAttack: {
      total: 34, intang: [0, 16],
      hb: [H(14, 16, R * 1.1, -14, 22, 7, 40, 60, 30, 'foot'), H(14, 16, -R * 1.1, -14, 22, 7, 140, 60, 30, 'foot2')],
    },
    ledgeAttack: { total: 40, intang: [0, 20], hb: [H(22, 25, R * 1.1, -h * 0.35, 24, 8, 40, 60, 35, 'foot')] },
    counterHit: { total: 40, intang: [0, 12], hb: [H(8, 10, R * 1.2, -h * 0.5, 30, 0, 40, 60, 90, 'hand', { counter: true })] },
  };
}

// ═════════════════════════════════════════════════════════════
// 1) ZIP — the speedster. Light, 3 mid-air jumps, fast but weak.
// ═════════════════════════════════════════════════════════════
const zip = {
  id: 'zip', name: 'Zip', role: 'Speedster',
  blurb: 'Tiny, twitchy and hard to pin down. Wins with speed, not power.',
  specials: [
    ['Neutral', 'Pinwheel', 'Spinning multi-hit that drags people in, then launches.'],
    ['Side', 'Blitz', 'Straight-line dash strike. Once per trip through the air.'],
    ['Up', 'Zipline', 'Rocket in any of 8 directions. Great recovery.'],
    ['Down', 'Meteor Heel', 'Diving kick. The first frames spike foes downward.'],
  ],
  shape: 'circle', w: 44, h: 60,
  palettes: ['#33e1ff', '#ff5fa2', '#9cff57', '#f5f5f5'],
  weight: 78, run: 10.2, runAccel: 1.6, air: 4.6, airAccel: 0.55,
  gravity: 0.62, fall: 9.6, ffall: 14.5, jump: 13.2, hop: 8.4, airJump: 12, airJumps: 2,
};
zip.moves = {
  ...makeNormals(zip, { sp: 0.85, pw: 0.85, rc: 0.9, kb: 1.06 }),

  // Neutral special: Pinwheel — multi-hit spin that drags people in, then a launcher.
  nspec: {
    total: 40, spin: [6, 28, 4], airGrav: 0.3,
    hb: [
      H(6, 22, 0, -30, 34, 1.4, 80, 12, 0, 'body', { rehit: 4 }),
      H(25, 27, 6, -30, 38, 5, 45, 46, 110, 'body'),
    ],
  },
  // Side special: Blitz — a straight-line dash. Usable once per trip through the air.
  sspec: {
    total: 34, airOnce: true, spin: [6, 22, 2],
    hb: [H(6, 22, 20, -30, 26, 8, 40, 45, 70, 'body')],
    onFrame(f, g, t) {
      if (t >= 6 && t <= 22) { f.vx = 15.5 * f.facing; f.vy = 0; }
      if (t === 23) f.vx *= 0.35;
    },
  },
  // Up special: Zipline — rocket in any of 8 directions, then helpless.
  uspec: {
    total: 46, helpless: true, ledgeGrab: 8,
    hb: [H(8, 20, 0, -30, 26, 5, 75, 40, 50, 'body')],
    onFrame(f, g, t) {
      if (t < 8) { f.vx *= 0.8; f.vy *= 0.5; return; }
      if (t === 8) { const d = heldDir(f); f.mv = d; if (d.x) f.facing = Math.sign(d.x); }
      if (t >= 8 && t <= 20) { f.vx = f.mv.x * 18; f.vy = f.mv.y * 18; }
      if (t === 21) { f.vx *= 0.4; f.vy = Math.min(f.vy, 0) * 0.3; }
    },
  },
  // Down special: Meteor Heel — dive kick. Early part spikes downward.
  dspec: {
    total: 70, landEnd: 18,
    hb: [
      H(6, 12, 22, 4, 22, 10, 285, 30, 80, 'foot', { g: 'k' }),
      H(13, 70, 22, 4, 18, 7, 45, 40, 60, 'foot', { g: 'k' }),
    ],
    onFrame(f, g, t) {
      if (t === 0 && f.ground) { f.leaveGround(); f.vy = -9; }
      if (t < 6) { f.vy = Math.min(f.vy, 1); f.vx *= 0.8; return; }
      f.vy = 17; f.vx = 6.5 * f.facing;
    },
  },
};

// ═════════════════════════════════════════════════════════════
// 2) BASTION — the heavyweight. Slow, huge damage, armored charges.
// ═════════════════════════════════════════════════════════════
const bastion = {
  id: 'bastion', name: 'Bastion', role: 'Heavyweight',
  blurb: 'A walking wall. Every hit hurts, but so does missing.',
  specials: [
    ['Neutral', 'Megaton', 'Hold to charge a huge armored punch.'],
    ['Side', 'Bulldoze', 'Shoulder charge that shrugs off weak hits.'],
    ['Up', 'Rocket Riser', 'Multi-hit rising uppercut. Short reach.'],
    ['Down', 'Quake', 'Leap and slam. The shockwave hits both sides.'],
  ],
  shape: 'square', w: 66, h: 84,
  palettes: ['#ff8a3d', '#5aa2ff', '#c7c7c7', '#e04848'],
  weight: 128, run: 6.4, runAccel: 0.9, air: 3.4, airAccel: 0.35,
  gravity: 0.72, fall: 11.2, ffall: 16.5, jump: 13.6, hop: 8.8, airJump: 13, airJumps: 1,
};
bastion.moves = {
  ...makeNormals(bastion, { sp: 1.2, pw: 1.35, rc: 1.15, kb: 1.04 }),

  // Neutral special: Megaton — hold Special to charge (up to 100 frames). Armored swing.
  nspec: {
    total: 46, charge: 8, chargeMax: 100, chargeBtn: 'SPECIAL', armor: [12, 22, 999],
    hb: [H(16, 19, 62, -46, 34, 12, 40, 40, 92, 'hand', { scaleCharge: 1.35 })],
  },
  // Side special: Bulldoze — armored shoulder charge. Shrugs off weak hits.
  sspec: {
    total: 44, airOnce: true, armor: [6, 30, 60],
    hb: [H(8, 30, 34, -42, 30, 9, 40, 50, 80, 'body')],
    onFrame(f, g, t) {
      if (t >= 8 && t <= 30) { f.vx = 11 * f.facing; if (!f.ground) f.vy = Math.min(f.vy, 1.5); }
      if (t === 31) f.vx *= 0.3;
    },
  },
  // Up special: Rocket Riser — multi-hit uppercut. Short recovery, as heavies should have.
  uspec: {
    total: 50, helpless: true, ledgeGrab: 6,
    hb: [
      H(6, 20, 26, -70, 30, 2, 85, 22, 8, 'hand', { rehit: 4 }),
      H(22, 24, 26, -80, 36, 6, 80, 55, 92, 'hand'),
    ],
    onFrame(f, g, t) {
      if (t < 6) { f.vy *= 0.5; f.vx *= 0.8; return; }
      if (t <= 24) {
        f.vy = -15.5 + (t - 6) * 0.38;
        const dx = (f.input.held & BTN.RIGHT ? 1 : 0) - (f.input.held & BTN.LEFT ? 1 : 0);
        f.vx = dx * 5;
      }
    },
  },
  // Down special: Quake — leap and slam; a shockwave hits both sides on landing.
  dspec: {
    total: 80, landTo: 'quakeLand',
    hb: [H(8, 80, 0, 6, 28, 9, 270, 25, 70, 'foot')],
    onFrame(f, g, t) {
      if (t === 0 && f.ground) { f.leaveGround(); f.vy = -10.5; }
      if (t < 8) { f.vy = Math.min(f.vy + 0.5, 1); f.vx *= 0.85; return; }
      f.vy = 20; f.vx *= 0.9;
    },
  },
  quakeLand: {
    total: 34, sfx: 'quake',
    hb: [
      H(0, 4, 70, -14, 36, 14, 72, 60, 85, 'foot'),
      H(0, 4, -70, -14, 36, 14, 108, 60, 85, 'foot2'),
    ],
  },
};

// ═════════════════════════════════════════════════════════════
// 3) PRISM — the zoner. Floaty, long reach, projectiles, reflector.
// ═════════════════════════════════════════════════════════════
const prism = {
  id: 'prism', name: 'Prism', role: 'Zoner',
  blurb: 'Keeps you out with bolts and boomerangs. Hates being cornered.',
  specials: [
    ['Neutral', 'Shard Bolt', 'Hold to charge, release to fire.'],
    ['Side', 'Boomerang', 'Flies out and comes back, hitting both ways.'],
    ['Up', 'Warp', 'Teleport in any direction. Untouchable while gone.'],
    ['Down', 'Mirror', 'Reflects projectiles back with 1.5× damage.'],
  ],
  shape: 'triangle', w: 50, h: 72,
  palettes: ['#b46bff', '#3ddc97', '#ffb547', '#ff6b6b'],
  weight: 90, run: 7.2, runAccel: 1.0, air: 3.8, airAccel: 0.45,
  gravity: 0.48, fall: 8.2, ffall: 13, jump: 12.6, hop: 8, airJump: 11.5, airJumps: 1,
};
prism.moves = {
  ...makeNormals(prism, { sp: 1.0, pw: 0.95, rc: 1.25, kb: 0.96 }),

  // Neutral special: Shard Bolt — hold to charge a bigger bolt, release to fire.
  nspec: {
    total: 30, charge: 6, chargeMax: 60, chargeBtn: 'SPECIAL',
    onFrame(f, g, t) {
      if (t === 12) {
        const c = f.chargeF / 60;
        g.spawnProjectile(f, {
          kind: 'bolt', x: 36, y: -40, vx: 12.5, vy: 0, r: 10 + c * 10, life: 85,
          dmg: +(4 + c * 9).toFixed(1), ang: 38, bkb: 30 + c * 20, kbg: 45 + c * 30,
        });
      }
    },
  },
  // Side special: Boomerang — flies out, slows, and comes back. One at a time.
  sspec: {
    total: 34,
    onFrame(f, g, t) {
      if (t === 10 && !g.projectiles.some(p => p.owner === f.id && p.kind === 'boomer')) {
        g.spawnProjectile(f, {
          kind: 'boomer', x: 30, y: -42, vx: 14, vy: 0, r: 15, life: 150,
          dmg: 6, ang: 50, bkb: 30, kbg: 50, returning: true, rehit: 18,
        });
      }
    },
  },
  // Up special: Warp — vanish and reappear in the held direction (intangible), then helpless.
  uspec: {
    total: 44, helpless: true, ledgeGrab: 16, intang: [4, 16],
    hb: [H(16, 19, 0, -36, 44, 6, 70, 50, 60, 'body')],
    onFrame(f, g, t) {
      if (t < 10) { f.vx *= 0.7; f.vy *= 0.4; return; }
      if (t === 10) { const d = heldDir(f); f.mv = d; if (d.x) f.facing = Math.sign(d.x); }
      if (t >= 10 && t < 16) { f.vx = f.mv.x * 40; f.vy = f.mv.y * 40; }
      if (t === 16) { f.vx *= 0.15; f.vy = Math.min(0, f.vy) * 0.1; }
    },
  },
  // Down special: Mirror — reflects projectiles back (1.5× damage) and pushes people away.
  dspec: {
    total: 36, airGrav: 0.3, reflect: [4, 26, 30, -38, 48],
    hb: [H(4, 5, 30, -38, 40, 3, 30, 55, 20, 'body')],
  },
};

// ═════════════════════════════════════════════════════════════
// 4) NOVA — the all-rounder. Good at everything, best at nothing.
// ═════════════════════════════════════════════════════════════
const nova = {
  id: 'nova', name: 'Nova', role: 'All-rounder',
  blurb: 'A solid kit for every situation, plus a counter for the reckless.',
  specials: [
    ['Neutral', 'Star Ball', 'Bouncing projectile. Two on screen at once.'],
    ['Side', 'Comet Roll', 'Rolling multi-hit dash that ends in a launcher.'],
    ['Up', 'Supernova', 'Rising multi-hit spin.'],
    ['Down', 'Counter', 'Get hit during the stance to strike back harder.'],
  ],
  shape: 'hexagon', w: 52, h: 70,
  palettes: ['#ffd23d', '#ff7b54', '#6be0ff', '#8f7bff'],
  weight: 100, run: 8.2, runAccel: 1.2, air: 3.9, airAccel: 0.48,
  gravity: 0.6, fall: 10, ffall: 15, jump: 13.2, hop: 8.5, airJump: 12.2, airJumps: 1,
};
nova.moves = {
  ...makeNormals(nova, { sp: 1.0, pw: 1.0, rc: 1.0, kb: 1.0 }),

  // Neutral special: Star Ball — a bouncing projectile. Max 2 on screen.
  nspec: {
    total: 36,
    onFrame(f, g, t) {
      if (t === 12 && g.projectiles.filter(p => p.owner === f.id && p.kind === 'star').length < 2) {
        g.spawnProjectile(f, {
          kind: 'star', x: 30, y: -40, vx: 8.5, vy: -3, r: 13, life: 120, grav: 0.42, bounces: 3,
          dmg: 6, ang: 45, bkb: 25, kbg: 50,
        });
      }
    },
  },
  // Side special: Comet Roll — rolling multi-hit dash ending in a launcher.
  sspec: {
    total: 48, airOnce: true, spin: [8, 34, 4],
    hb: [
      H(8, 30, 18, -34, 28, 2.5, 60, 25, 8, 'body', { rehit: 6 }),
      H(32, 34, 22, -34, 32, 6, 40, 55, 85, 'body'),
    ],
    onFrame(f, g, t) {
      if (t >= 8 && t <= 34) { f.vx = 12 * f.facing; if (!f.ground) f.vy = Math.min(f.vy, 2); }
      if (t === 35) f.vx *= 0.3;
    },
  },
  // Up special: Supernova — rising multi-hit spin, then helpless.
  uspec: {
    total: 52, helpless: true, ledgeGrab: 4, spin: [4, 30, 5],
    hb: [
      H(4, 26, 0, -40, 34, 1.5, 88, 20, 8, 'body', { rehit: 5 }),
      H(28, 30, 0, -40, 44, 5, 80, 55, 95, 'body'),
    ],
    onFrame(f, g, t) {
      if (t < 4) { f.vy *= 0.5; return; }
      if (t <= 26) {
        f.vy = -16.2 + (t - 4) * 0.4;
        const dx = (f.input.held & BTN.RIGHT ? 1 : 0) - (f.input.held & BTN.LEFT ? 1 : 0);
        f.vx = dx * 5.5;
      }
    },
  },
  // Down special: Counter — get hit during the window and strike back harder.
  dspec: { total: 46, counter: [5, 28], airGrav: 0.4 },
};

export const CHARACTERS = { zip, bastion, prism, nova };
export const CHARACTER_ORDER = ['zip', 'bastion', 'prism', 'nova'];

// Pre-compute, per move, the frame range where hitboxes exist (renderer uses it for wind-up/recovery timing).
for (const c of Object.values(CHARACTERS)) {
  for (const [key, m] of Object.entries(c.moves)) {
    m.key = key;
    if (m.hb && m.hb.length) {
      m.firstActive = Math.min(...m.hb.map(h => h.s));
      m.lastActive = Math.max(...m.hb.map(h => Math.min(h.e, m.total)));
    }
  }
}
