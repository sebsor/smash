// ─────────────────────────────────────────────────────────────
// config.js — every "magic number" lives here.
// Keeping tuning values in one place means you can tweak feel
// (gravity, knockback, shield size…) without hunting through logic.
// ─────────────────────────────────────────────────────────────

export const GAME_NAME = 'SHAPESHOCK';
export const VERSION = '0.1.0';
export const FPS = 60;              // simulation runs at a fixed 60 steps/second
export const STEP_MS = 1000 / FPS;

// Buttons are stored as bit flags so a whole input state fits in ONE number.
// e.g. holding LEFT + ATTACK = 1 | 32 = 33. Cheap to send over the network.
export const BTN = {
  LEFT: 1 << 0,
  RIGHT: 1 << 1,
  UP: 1 << 2,
  DOWN: 1 << 3,
  JUMP: 1 << 4,
  ATTACK: 1 << 5,
  SPECIAL: 1 << 6,
  SMASH: 1 << 7,
  SHIELD: 1 << 8,
  GRAB: 1 << 9,
};
export const BTN_NAMES = Object.keys(BTN);   // index i  ↔  bit (1 << i)

export const RULES = {
  stocks: 3,
  maxPlayers: 4,
  countdownFrames: 180,   // 3-2-1-GO
};

// Movement/physics shared by all fighters (per-character stats live in characters.js).
// Units: world pixels and frames. "vy = 13" means 13 px per frame upward.
export const PHYS = {
  groundFriction: 0.85,     // px/frame² of slowdown when not running
  jumpSquat: 4,             // frames crouching before leaving the ground
  landLag: 3,               // normal landing frames
  helplessLandLag: 22,      // landing after an up-special
  airdodgeLandLag: 10,
  dropThroughFrames: 10,    // ignore soft platforms this long after pressing down
  inputBuffer: 8,           // a press is remembered this many frames (Smash buffers ~10)
  ledgeHangMax: 300,        // 5 s then you drop
  ledgeRegrab: 40,          // frames before you can grab a ledge again
  ledgeInvuln: 50,
  respawnWait: 70,
  respawnInvuln: 120,
  respawnPlatformMax: 240,
};

export const SHIELD = {
  max: 50,
  drainPerFrame: 0.14,
  regenPerFrame: 0.09,
  breakResetTo: 30,
  dropLag: 7,
  dizzyFrames: 200,
};

// Knockback. The formula is modelled on the published Smash 4 / Ultimate
// formula, but the conversion to OUR world units (launchK, decay) is my
// own tuning — see tests/ko-test.mjs which measures KO percents.
export const KB = {
  launchK: 0.15,      // knockback units → px/frame launch speed
  decay: 0.32,       // px/frame removed from launch speed every frame
  hitstunK: 0.4,     // hitstun frames = knockback × 0.4   (same ratio as Smash)
  tumbleAt: 80,      // knockback above this = tumble (spinning, must tech)
  flinchBelow: 25,   // tiny knockback on the ground = just a flinch, no launch
  diMaxDeg: 15,      // directional influence: max angle change
  techWindow: 20,    // press shield within 20 frames before landing to tech
  hitlagBase: 4,
  hitlagPerDmg: 0.6,
  hitlagMax: 20,
};
