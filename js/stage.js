// ─────────────────────────────────────────────────────────────
// stage.js — level geometry. World coordinates:
//   x grows to the right, y grows DOWNWARD (same as <canvas>).
//   y = 0 is the top surface of the main platform.
// ─────────────────────────────────────────────────────────────

export const STAGES = {
  skyforge: {
    id: 'skyforge',
    name: 'Skyforge',
    // The solid main platform: you stand on top, collide with sides/bottom.
    main: { x1: -460, x2: 460, y: 0, bottom: 110 },
    // Soft ("pass-through") platforms: land from above, jump up through, press down to drop.
    platforms: [
      { x1: -320, x2: -130, y: -165 },
      { x1: 130, x2: 320, y: -165 },
      { x1: -95, x2: 95, y: -315 },
    ],
    // dir = which way is "off-stage" from that ledge
    ledges: [
      { x: -460, y: 0, dir: -1 },
      { x: 460, y: 0, dir: 1 },
    ],
    // Cross one of these lines = lose a stock.
    blast: { left: -1350, right: 1350, top: -1020, bottom: 820 },
    spawns: [
      { x: -300, y: 0 }, { x: 300, y: 0 }, { x: -110, y: 0 }, { x: 110, y: 0 },
    ],
    respawn: { x: 0, y: -470 },
  },
};
