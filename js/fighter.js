// ─────────────────────────────────────────────────────────────
// fighter.js — ONE fighter and its state machine.
//
// A state machine means the fighter is always in exactly one named
// state ('idle', 'run', 'air', 'attack', 'shield', 'ledge', …) and
// each state decides (a) what inputs it accepts and (b) which state
// comes next. This is how almost every fighting game is structured:
// it makes rules like "you can't attack while rolling" automatic,
// because the 'roll' state simply never checks the attack button.
//
// The fighter knows nothing about drawing or networking. game.js
// owns the world (stage, other fighters, projectiles, hit detection).
// ─────────────────────────────────────────────────────────────

import { BTN, BTN_NAMES, PHYS, SHIELD, KB } from './config.js';
import { CHARACTERS } from './characters.js';

// States where you are standing on something and may stand still at an edge
// (instead of walking off). Running, getting hit and moving specials DO go off.
const EDGE_STOP = new Set(['idle', 'crouch', 'land', 'jumpsquat', 'shield', 'shieldstun', 'shieldDrop',
  'spotdodge', 'roll', 'holding', 'grabbed', 'down', 'getup', 'tech', 'dizzy', 'turn', 'throw']);

export class Fighter {
  constructor({ id, slot, name, charId, palette = 0, x = 0, y = 0, stocks = 3, dummy = false }) {
    this.id = id;
    this.slot = slot;
    this.name = name;
    this.charId = charId;
    this.ch = CHARACTERS[charId];
    this.palette = palette;
    this.dummy = dummy;            // practice sandbag: never acts
    this.w = this.ch.w;
    this.h = this.ch.h;
    this.weight = this.ch.weight;

    this.x = x; this.y = y;
    this.px = x; this.py = y;      // previous position (for "did I cross the floor this frame?")
    this.vx = 0; this.vy = 0;      // self-propelled velocity (running, jumping, gravity)
    this.kvx = 0; this.kvy = 0;    // knockback velocity — kept separate so it can decay on its own
    this.facing = x > 0 ? -1 : 1;
    this.ground = 0;               // index of the surface we stand on (0 = main), or null in the air

    this.state = 'idle'; this.sf = 0;     // current state + frames spent in it
    this.move = null; this.mf = 0; this.mt = 0; // current attack, its frame counter, frame being "shown"
    this.chargeF = 0; this.charging = false;
    this.hitMap = new Map();              // who this move already hit (each move hits once)

    this.dmg = 0;
    this.stocks = stocks;
    this.airJumps = this.ch.airJumps;
    this.airDodged = false;
    this.usedAirOnce = false;
    this.ffall = false;
    this.dropThrough = 0;
    this.shieldHP = SHIELD.max;
    this.invuln = 0;
    this.hitlag = 0;
    this.hitstun = 0;
    this.pendingLaunch = null;
    this.lagT = 0;

    this.ledge = -1; this.ledgeCD = 0; this.hangT = 0;
    this.climb = null;
    this.holding = -1; this.heldBy = -1; this.grabTimer = 0; this.pummelT = 0;
    this.respawnT = 0;
    this.djT = 99;          // frames since last double jump (renderer flips you)
    this.lastHitBy = -1; this.lastHitT = -9999;
    this.counterDmg = 0;
    this.mv = { x: 0, y: -1 };
    this.stats = { kos: 0, falls: 0, sds: 0, dealt: 0 };

    // Input: held bits, plus a buffer of "frames since this button was pressed".
    this.input = { held: 0, pressed: 0 };
    this.buf = new Array(BTN_NAMES.length).fill(99);
  }

  get moveDef() { return this.move ? this.ch.moves[this.move] : null; }
  get airborne() { return this.ground === null; }
  get alive() { return this.state !== 'dead' && this.state !== 'out'; }

  // ── Input helpers ───────────────────────────────────────────
  // Called once per frame by the game with this player's buttons.
  feedInput(held, pressed) {
    if (this.dummy) { held = 0; pressed = 0; }
    this.input.held = held; this.input.pressed = pressed;
    for (let i = 0; i < this.buf.length; i++) {
      this.buf[i] = (pressed & (1 << i)) ? 0 : Math.min(99, this.buf[i] + 1);
    }
  }
  // "Was this pressed recently?" — the input buffer. Lets you press jump a few
  // frames BEFORE landing and still get the jump, which makes controls feel tight.
  pressedBuf(btn, win = PHYS.inputBuffer) { return this.buf[Math.log2(btn)] <= win; }
  use(btn) { this.buf[Math.log2(btn)] = 99; }
  isHeld(btn) { return (this.input.held & btn) !== 0; }

  // A jump can come from Space (pure jump) or W ("tap jump": jump + up at once).
  // We remember which, because tap jumps allow a few Smash-style cancels.
  jumpPressed() {
    if (this.pressedBuf(BTN.JUMP)) { this.use(BTN.JUMP); this.tapJump = false; return true; }
    if (this.pressedBuf(BTN.TAPJUMP)) { this.use(BTN.TAPJUMP); this.tapJump = true; return true; }
    return false;
  }
  get jumpHeld() { return this.isHeld(BTN.JUMP) || this.isHeld(BTN.TAPJUMP); }
  get dirX() { return (this.isHeld(BTN.RIGHT) ? 1 : 0) - (this.isHeld(BTN.LEFT) ? 1 : 0); }
  get dirY() { return (this.isHeld(BTN.DOWN) ? 1 : 0) - (this.isHeld(BTN.UP) ? 1 : 0); }

  // ── State helpers ───────────────────────────────────────────
  setState(s) { this.state = s; this.sf = 0; if (s !== 'attack') { this.move = null; this.charging = false; } }
  setLag(n, s = 'land') { this.setState(s); this.lagT = n; }

  startMove(key, game) {
    const m = this.ch.moves[key];
    if (!m) return false;
    this.setState('attack');
    this.move = key; this.mf = 0; this.mt = 0; this.chargeF = 0; this.charging = false;
    this.hitMap.clear();
    this.moveAir = this.airborne;
    if (m.sfx && game) game.event('sfx', { name: m.sfx, x: this.x, y: this.y });
    return true;
  }

  leaveGround() {
    if (this.ground === null) return;
    this.ground = null;
  }

  // Is anything currently able to hurt me?
  intangible() {
    if (this.invuln > 0) return true;
    const s = this.state, t = this.sf;
    if (s === 'roll' || s === 'getupRoll') return t >= 3 && t <= 20;
    if (s === 'spotdodge') return t >= 3 && t <= 17;
    if (s === 'airdodge') return t >= 3 && t <= 27;
    if (s === 'tech' || s === 'getup') return t <= 18;
    if (s === 'ledgeClimb') return t <= 24;
    if (s === 'ledgeRoll') return t <= 30;
    if (s === 'respawn') return true;
    if (s === 'attack') {
      const m = this.moveDef;
      if (m.intang && this.mt >= m.intang[0] && this.mt <= m.intang[1]) return true;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // One simulation frame for this fighter.
  // Order matters: gravity first, THEN state logic (so a move that
  // sets velocity exactly — like a dash — isn't nudged by gravity).
  // ═══════════════════════════════════════════════════════════
  update(game) {
    if (this.state === 'dead' || this.state === 'out') { this.tickDead(game); return; }

    if (this.invuln > 0) this.invuln--;
    if (this.ledgeCD > 0) this.ledgeCD--;
    if (this.dropThrough > 0) this.dropThrough--;
    if (this.djT < 99) this.djT++;
    if (this.state !== 'shield' && this.state !== 'shieldstun') {
      this.shieldHP = Math.min(SHIELD.max, this.shieldHP + SHIELD.regenPerFrame);
    }

    this.applyGravity();
    this.sf++;
    this.stateLogic(game);
    this.integrate();
    game.collide(this);
  }

  applyGravity() {
    if (!this.airborne || this.climb) return;
    if (['ledge', 'held', 'respawn', 'ledgeClimb', 'ledgeRoll'].includes(this.state)) return;
    let g = this.ch.gravity;
    if (this.state === 'attack') {
      const m = this.moveDef;
      if (m.airGrav != null) g *= m.airGrav;
      if (this.charging) g *= 0.5;
    }
    if (this.state === 'airdodge' && this.adDir && this.sf < 20) g = 0;
    this.vy += g;
    const cap = this.ffall ? this.ch.ffall : this.ch.fall;
    if (this.vy > cap) this.vy = cap;
  }

  integrate() {
    this.px = this.x; this.py = this.y;
    if (this.climb) {
      const c = this.climb; c.t++;
      const k = Math.min(1, c.t / c.n), e = k * k * (3 - 2 * k);   // smoothstep easing
      this.x = c.fx + (c.tx - c.fx) * e;
      this.y = c.fy + (c.ty - c.fy) * e;
      if (k >= 1) { this.climb = null; this.ground = 0; this.y = c.ty; }
      return;
    }
    if (['ledge', 'held', 'respawn'].includes(this.state)) return;
    // Knockback decays by a fixed amount each frame (like Smash), not by a percentage.
    const ks = Math.hypot(this.kvx, this.kvy);
    if (ks > 0) {
      const ns = Math.max(0, ks - KB.decay);
      this.kvx *= ns / ks; this.kvy *= ns / ks;
    }
    if (!this.airborne) { this.kvx *= 0.9; if (this.kvy > 0) this.kvy = 0; }
    this.x += this.vx + this.kvx;
    this.y += this.vy + this.kvy;
  }

  friction(amount = PHYS.groundFriction) {
    if (this.vx > 0) this.vx = Math.max(0, this.vx - amount);
    else if (this.vx < 0) this.vx = Math.min(0, this.vx + amount);
  }

  airDrift(mult = 1) {
    const dx = this.dirX, ch = this.ch;
    if (dx) {
      const max = ch.air * mult;
      if (Math.sign(this.vx) === dx && Math.abs(this.vx) >= max) {
        // Already faster than air speed (e.g. after a dash): bleed off gently, never accelerate further.
        this.vx = dx * Math.max(max, Math.abs(this.vx) - 0.3);
      } else {
        this.vx += dx * ch.airAccel * mult;
        if (Math.sign(this.vx) === dx && Math.abs(this.vx) > max) this.vx = dx * max;
      }
    } else {
      this.vx *= 0.97;
    }
  }

  // ═══════════════════════════════════════════════════════════
  stateLogic(game) {
    switch (this.state) {
      case 'idle':
        if (!this.groundActions(game)) this.friction();
        break;

      case 'run': {
        if (this.groundActions(game, true)) break;
        const dx = this.dirX;
        if (!dx) { this.setState('idle'); this.friction(); break; }
        if (dx !== this.facing) { this.facing = dx; this.setState('turn'); break; }
        const target = this.ch.run * this.facing;
        this.vx += Math.sign(target - this.vx) * Math.min(Math.abs(target - this.vx), this.ch.runAccel);
        break;
      }

      case 'turn':   // short skid when reversing a run
        this.friction(1.4);
        if (this.jumpPressed()) { this.setState('jumpsquat'); break; }
        if (this.sf >= 6) this.setState(this.dirX ? 'run' : 'idle');
        break;

      case 'crouch':
        this.friction();
        if (!this.isHeld(BTN.DOWN)) { this.setState('idle'); break; }
        this.groundActions(game);
        break;

      case 'jumpsquat':
        this.friction(0.4);
        // Like Smash: the first frames of a jump can be cancelled into up-special or
        // up-smash. With W (tap jump) also into up-tilt — so W+J is an up-tilt, not a jump.
        if (this.dirY < 0) {
          const cancel = (btn, key) => {
            if (!this.pressedBuf(btn)) return false;
            this.use(btn); this.use(BTN.TAPJUMP); this.startMove(key, game); return true;
          };
          if (cancel(BTN.SPECIAL, 'uspec') || cancel(BTN.SMASH, 'usmash')) break;
          if (this.tapJump && cancel(BTN.ATTACK, 'utilt')) break;
        }
        if (this.sf >= PHYS.jumpSquat) {
          // Still holding jump at the end of the squat = full hop, released = short hop.
          const full = this.jumpHeld;
          this.leaveGround();
          this.vy = -(full ? this.ch.jump : this.ch.hop);
          this.vx = this.vx * 0.85 + this.dirX * 2;
          this.setState('air');
          game.event('sfx', { name: 'jump', x: this.x, y: this.y });
        }
        break;

      case 'land':
        this.friction();
        if (this.sf >= this.lagT) { this.setState('idle'); this.groundActions(game); }
        break;

      case 'air':
        if (!this.airActions(game)) this.airDrift();
        break;

      case 'helpless':   // after an up-special: can drift, cannot act until you land or grab a ledge
        this.airDrift(0.75);
        break;

      case 'attack':
        this.runMove(game);
        break;

      case 'shield': this.shieldLogic(game); break;
      case 'shieldstun':
        this.friction(0.6);
        if (this.sf >= this.lagT) this.setState('shield');
        break;
      case 'shieldDrop':
        this.friction();
        if (this.sf >= SHIELD.dropLag) this.setState('idle');
        break;

      case 'roll':
      case 'getupRoll': {
        const dir = this.rollDir;
        if (this.sf >= 4 && this.sf <= 22) this.vx = dir * 7.2; else this.friction(1.2);
        if (this.sf >= 30) { this.facing = -dir; this.vx = 0; this.setState('idle'); }
        break;
      }
      case 'spotdodge':
        this.friction(1.2);
        if (this.sf >= 24) this.setState('idle');
        break;

      case 'airdodge':
        if (this.adDir) {
          if (this.sf < 20) { this.vx *= 0.9; this.vy *= 0.9; }
          if (this.sf >= 44) this.setState('air');
        } else {
          this.airDrift(0.5);
          if (this.sf >= 32) this.setState('air');
        }
        break;

      case 'hitstun':
      case 'tumble':
        if (this.hitstun > 0) this.hitstun--;
        if (this.airborne) {
          if (this.hitstun <= 0) {
            // Hitstun over. In tumble you may act again, but if you hit the floor still
            // tumbling you must tech or get knocked down.
            if (this.state === 'tumble') { if (this.airActions(game)) break; this.airDrift(0.6); }
            else this.setState('air');
          }
        } else {
          this.friction(0.5);
          if (this.hitstun <= 0) this.setState('idle');
        }
        break;

      case 'down':   // knocked down, lying on the floor
        this.friction(0.8);
        if (this.sf >= 20) {
          if (this.pressedBuf(BTN.ATTACK) || this.pressedBuf(BTN.SMASH)) { this.use(BTN.ATTACK); this.use(BTN.SMASH); this.startMove('getupAttack', game); break; }
          if (this.dirX) { this.rollDir = this.dirX; this.setState('getupRoll'); break; }
          if (this.pressedBuf(BTN.JUMP) || this.pressedBuf(BTN.UP) || this.pressedBuf(BTN.SHIELD)) { this.use(BTN.TAPJUMP); this.setState('getup'); break; }
        }
        if (this.sf >= 90) this.setState('getup');
        break;
      case 'getup':
        if (this.sf >= 24) this.setState('idle');
        break;
      case 'tech':
        if (this.sf >= 2 && this.sf <= 20 && this.techDir) this.vx = this.techDir * 7;
        else this.friction(1.2);
        if (this.sf >= 26) this.setState('idle');
        break;

      case 'shieldbreak':   // pops upward, then dizzy on landing
        this.airDrift(0.2);
        break;
      case 'dizzy':
        this.friction();
        this.dizzyT -= 1 + (this.input.pressed ? 8 : 0);   // mashing helps you recover
        if (this.dizzyT <= 0) this.setState('idle');
        break;

      case 'holding': this.holdingLogic(game); break;
      case 'held': break; // positioned by the holder in game.js

      case 'ledge': this.ledgeLogic(game); break;
      case 'ledgeClimb':
        if (this.sf >= 30) this.setState('idle');
        break;
      case 'ledgeRoll':
        if (this.sf > 16 && this.sf <= 34) this.vx = this.rollDir * 8; else if (!this.climb) this.friction(1.2);
        if (this.sf >= 44) { this.vx = 0; this.setState('idle'); }
        break;

      case 'respawn':
        this.vx = this.vy = 0;
        if (this.sf > 20 && (this.input.pressed || this.input.held & (BTN.LEFT | BTN.RIGHT | BTN.DOWN))
          || this.sf > 240) {
          this.use(BTN.TAPJUMP);   // leaving the platform with W shouldn't also double jump
          this.setState('air');
          this.invuln = 120;
        }
        break;
    }
  }

  // ── What you can do while standing ──────────────────────────
  // Returns true if an action started (so the caller skips its default behaviour).
  groundActions(game, running = false) {
    const dx = this.dirX, dy = this.dirY;

    if (this.jumpPressed()) { this.setState('jumpsquat'); return true; }

    if (this.pressedBuf(BTN.GRAB) || (this.isHeld(BTN.SHIELD) && this.pressedBuf(BTN.ATTACK))) {
      this.use(BTN.GRAB); this.use(BTN.ATTACK); this.startMove('grab', game); return true;
    }
    if (this.isHeld(BTN.SHIELD)) { this.setState('shield'); return true; }

    if (this.pressedBuf(BTN.SMASH)) {
      this.use(BTN.SMASH);
      if (dx) this.facing = dx;
      this.startMove(dy < 0 ? 'usmash' : dy > 0 ? 'dsmash' : 'fsmash', game);
      return true;
    }
    if (this.pressedBuf(BTN.SPECIAL)) { this.use(BTN.SPECIAL); return this.doSpecial(game); }
    if (this.pressedBuf(BTN.ATTACK)) {
      this.use(BTN.ATTACK);
      if (running && Math.abs(this.vx) > this.ch.run * 0.6 && dy === 0) { this.startMove('dash', game); return true; }
      if (dy < 0) this.startMove('utilt', game);
      else if (dy > 0) this.startMove('dtilt', game);
      else if (dx) { this.facing = dx; this.startMove('ftilt', game); }
      else this.startMove('jab', game);
      return true;
    }

    // Pressing down on a soft platform drops you through it.
    if (this.ground > 0 && this.pressedBuf(BTN.DOWN, 1)) {
      this.use(BTN.DOWN);
      this.leaveGround(); this.dropThrough = PHYS.dropThroughFrames; this.y += 2;
      this.setState('air');
      return true;
    }
    if (dy > 0) { if (this.state === 'crouch') return false; this.setState('crouch'); return true; }

    if (dx && this.state !== 'run') {
      if (dx !== this.facing && this.state === 'idle' && Math.abs(this.vx) > 2) { this.facing = dx; this.setState('turn'); return true; }
      this.facing = dx; this.setState('run'); return true;
    }
    return false;
  }

  // ── What you can do in the air ──────────────────────────────
  airActions(game) {
    const dx = this.dirX, dy = this.dirY;

    // W in the air waits 3 frames before double-jumping: if you press Attack/Special
    // in that window you get the up-aerial/up-special and KEEP your double jump.
    const tj = this.buf[Math.log2(BTN.TAPJUMP)];
    const tapJumpReady = tj >= 3 && tj <= PHYS.inputBuffer;
    if ((this.pressedBuf(BTN.JUMP) || tapJumpReady) && this.airJumps > 0) {
      this.use(BTN.JUMP); this.use(BTN.TAPJUMP);
      this.airJumps--; this.ffall = false; this.djT = 0;
      this.vy = -this.ch.airJump;
      this.vx = dx * this.ch.air;           // double jumps let you change direction instantly
      this.kvx *= 0.3; this.kvy = Math.min(this.kvy, 0) * 0.3;
      this.setState('air');
      game.event('sfx', { name: 'djump', x: this.x, y: this.y });
      return true;
    }
    if (this.pressedBuf(BTN.SHIELD, 3) && !this.airDodged) {
      this.use(BTN.SHIELD);
      this.airDodged = true; this.ffall = false;
      this.setState('airdodge');
      if (dx || dy) {
        const len = Math.hypot(dx, dy);
        this.adDir = true; this.vx = dx / len * 11; this.vy = dy / len * 11;
      } else { this.adDir = false; }
      this.kvx = this.kvy = 0;
      return true;
    }
    if (this.pressedBuf(BTN.SPECIAL)) { this.use(BTN.SPECIAL); this.use(BTN.TAPJUMP); return this.doSpecial(game); }
    if (this.pressedBuf(BTN.ATTACK) || this.pressedBuf(BTN.SMASH) || this.pressedBuf(BTN.GRAB)) {
      this.use(BTN.ATTACK); this.use(BTN.SMASH); this.use(BTN.GRAB); this.use(BTN.TAPJUMP);
      let key = 'nair';
      if (dy < 0) key = 'uair';
      else if (dy > 0) key = 'dair';
      else if (dx === this.facing) key = 'fair';
      else if (dx === -this.facing) key = 'bair';
      this.startMove(key, game);
      return true;
    }
    this.checkFastFall();
    return false;
  }

  checkFastFall() {
    // Tap down once you're past the peak of your jump → fall much faster.
    if (!this.ffall && this.vy >= -1 && this.pressedBuf(BTN.DOWN, 1)) {
      this.use(BTN.DOWN);
      this.ffall = true;
      this.vy = this.ch.ffall;
    }
  }

  doSpecial(game) {
    const dx = this.dirX, dy = this.dirY;
    if (dy < 0) return this.startMove('uspec', game);
    if (dy > 0) return this.startMove('dspec', game);
    if (dx) {
      if (this.airborne && this.usedAirOnce) return false;
      this.facing = dx;
      if (this.airborne) this.usedAirOnce = true;
      return this.startMove('sspec', game);
    }
    return this.startMove('nspec', game);
  }

  // ── Executing a move frame by frame ─────────────────────────
  runMove(game) {
    const m = this.moveDef;
    if (this.mf >= m.total) { this.endMove(game); return; }

    // Charging: freeze on the charge frame while the button is held.
    if (m.charge != null && this.mf === m.charge && this.chargeF < (m.chargeMax || 60)) {
      const btn = BTN[m.chargeBtn || 'SMASH'];
      if (this.isHeld(btn)) {
        this.charging = true; this.chargeF++; this.mt = this.mf;
        if (this.airborne) this.airDrift(0.4); else this.friction();
        if (this.isHeld(BTN.SHIELD) && m.chargeBtn === 'SPECIAL') this.endMove(game);  // cancel a stored special
        return;
      }
    }
    this.charging = false;
    this.mt = this.mf;

    // Default movement first (drift in the air, friction on the ground)…
    if (this.airborne) { this.airDrift(); if (this.moveAir && !m.onFrame) this.checkFastFall(); }
    else this.friction(m.slide ? (1 - m.slide) * 12 : PHYS.groundFriction);
    // …then the move's own script may override velocity (dashes, recoveries).
    if (m.onFrame) m.onFrame(this, game, this.mt);

    if (m.pummel && this.mt === m.pummel.f) game.pummelHit(this, m.pummel.dmg);
    if (m.throwHit && this.mt === m.throwHit.f) game.throwHit(this, m.throwHit);

    this.mf++;
  }

  endMove(game) {
    const m = this.moveDef;
    this.move = null;
    if (m && m.helpless && this.airborne) { this.setState('helpless'); return; }
    if (this.airborne) this.setState('air');
    else { this.setState('idle'); this.groundActions(game); }
  }

  // ── Shield ──────────────────────────────────────────────────
  shieldLogic(game) {
    this.friction();
    this.shieldHP -= SHIELD.drainPerFrame;
    if (this.shieldHP <= 0) { game.shieldBreak(this); return; }
    // Out-of-shield options (what makes shield more than a wall)
    if (this.jumpPressed()) { this.setState('jumpsquat'); return; }
    if (this.pressedBuf(BTN.ATTACK) || this.pressedBuf(BTN.GRAB)) { this.use(BTN.ATTACK); this.use(BTN.GRAB); this.startMove('grab', game); return; }
    if (this.pressedBuf(BTN.SPECIAL) && this.dirY < 0) { this.use(BTN.SPECIAL); this.startMove('uspec', game); return; }
    if (this.pressedBuf(BTN.SMASH) && this.dirY < 0) { this.use(BTN.SMASH); this.startMove('usmash', game); return; }
    if (this.pressedBuf(BTN.LEFT, 3)) { this.use(BTN.LEFT); this.rollDir = -1; this.setState('roll'); return; }
    if (this.pressedBuf(BTN.RIGHT, 3)) { this.use(BTN.RIGHT); this.rollDir = 1; this.setState('roll'); return; }
    if (this.pressedBuf(BTN.DOWN, 3)) { this.use(BTN.DOWN); this.setState('spotdodge'); return; }
    if (!this.isHeld(BTN.SHIELD) && this.sf >= 4) this.setState('shieldDrop');
  }

  // ── Holding someone after a grab ────────────────────────────
  holdingLogic(game) {
    this.friction();
    const t = game.byId(this.holding);
    if (!t || t.state !== 'held') { this.holding = -1; this.setState('idle'); return; }
    this.grabTimer--;
    if (this.pummelT > 0) this.pummelT--;
    if (this.grabTimer <= 0) { game.releaseGrab(this, t); return; }
    if (this.sf < 6) return;
    const dx = this.dirX, dy = this.dirY;
    const fresh = b => this.pressedBuf(b, 2);
    if (fresh(BTN.UP) || (dy < 0 && fresh(BTN.SMASH))) { this.use(BTN.UP); this.startMove('uthrow', game); this.keepHold = true; return; }
    if (fresh(BTN.DOWN) || (dy > 0 && fresh(BTN.SMASH))) { this.use(BTN.DOWN); this.startMove('dthrow', game); return; }
    if (fresh(BTN.LEFT) || fresh(BTN.RIGHT) || (dx && fresh(BTN.SMASH))) {
      const d = fresh(BTN.LEFT) ? -1 : fresh(BTN.RIGHT) ? 1 : dx;
      this.use(BTN.LEFT); this.use(BTN.RIGHT); this.use(BTN.SMASH);
      this.startMove(d === this.facing ? 'fthrow' : 'bthrow', game);
      return;
    }
    if ((this.pressedBuf(BTN.ATTACK) || this.pressedBuf(BTN.GRAB)) && this.pummelT <= 0) {
      this.use(BTN.ATTACK); this.use(BTN.GRAB);
      this.pummelT = 16;
      game.pummelHit(this, this.ch.moves.pummel.pummel.dmg);
    }
  }

  // ── Hanging on a ledge ──────────────────────────────────────
  ledgeLogic(game) {
    this.hangT++;
    const L = game.stage.ledges[this.ledge];
    if (this.hangT > PHYS.ledgeHangMax) { game.releaseLedge(this, true); return; }
    if (this.sf < 6) return;
    const toward = -L.dir;
    const stand = { x: L.x + toward * (this.w / 2 + 6), y: L.y };
    const climbTo = () => { this.climb = { fx: this.x, fy: this.y, tx: stand.x, ty: stand.y, t: 0, n: 16 }; };

    if (this.pressedBuf(BTN.JUMP) || this.pressedBuf(BTN.UP, 2)) {
      this.use(BTN.JUMP); this.use(BTN.UP); this.use(BTN.TAPJUMP);
      game.releaseLedge(this);
      this.vy = -this.ch.jump * 1.05; this.vx = toward * 2;
      this.invuln = Math.max(this.invuln, 4);
      this.setState('air');
      return;
    }
    if (this.pressedBuf(BTN.ATTACK) || this.pressedBuf(BTN.SMASH)) {
      this.use(BTN.ATTACK); this.use(BTN.SMASH);
      game.releaseLedge(this); climbTo(); this.ground = 0;
      this.startMove('ledgeAttack', game);
      return;
    }
    if (this.pressedBuf(BTN.SHIELD)) {
      this.use(BTN.SHIELD);
      game.releaseLedge(this); climbTo(); this.ground = 0; this.rollDir = toward;
      this.setState('ledgeRoll');
      return;
    }
    if (this.dirX === toward) {
      game.releaseLedge(this); climbTo(); this.ground = 0;
      this.setState('ledgeClimb');
      return;
    }
    if (this.dirY > 0 || this.dirX === L.dir) {
      game.releaseLedge(this, true);
    }
  }

  tickDead(game) {
    if (this.state === 'out') return;
    this.respawnT--;
    if (this.respawnT <= 0) game.respawn(this);
  }

  // ── Landing on a surface (called by game.collide) ───────────
  land(game, surfIdx, surfY) {
    this.ground = surfIdx;
    this.y = surfY;
    const impactVy = this.vy + this.kvy;
    this.vy = 0;
    this.airJumps = this.ch.airJumps; this.airDodged = false; this.usedAirOnce = false; this.ffall = false;

    switch (this.state) {
      case 'attack': {
        const m = this.moveDef;
        if (m.landTo) { this.kvy = 0; this.startMove(m.landTo, game); }
        else if (m.helpless) this.setLag(PHYS.helplessLandLag);
        else if (m.landEnd != null) this.setLag(m.landEnd);
        else if (this.moveAir && m.land != null) this.setLag(m.land);
        else if (this.moveAir && !m.onFrame) this.setLag(PHYS.landLag);
        // ground-started specials (dashes) keep going
        break;
      }
      case 'helpless': this.setLag(PHYS.helplessLandLag); break;
      case 'airdodge': this.setLag(PHYS.airdodgeLandLag); break;
      case 'tumble': {
        // Tech: press shield shortly before hitting the floor to recover instantly.
        if (this.buf[Math.log2(BTN.SHIELD)] <= KB.techWindow) {
          this.use(BTN.SHIELD);
          this.kvx = this.kvy = 0; this.vx = 0;
          this.techDir = this.dirX;
          this.setState('tech');
          game.event('tech', { x: this.x, y: this.y });
        } else if (impactVy > 9) {
          // Hit the floor hard without teching → bounce
          this.ground = null;
          this.kvy = -Math.abs(this.kvy) * 0.55; this.vy = -Math.min(6, impactVy * 0.25);
          game.event('bounce', { x: this.x, y: this.y });
        } else {
          this.kvx *= 0.5; this.kvy = 0;
          this.setState('down');
          game.event('sfx', { name: 'thud', x: this.x, y: this.y });
        }
        break;
      }
      case 'hitstun':
        if (this.hitstun <= 0) this.setLag(PHYS.landLag);
        break;
      case 'shieldbreak':
        this.setState('dizzy'); this.dizzyT = SHIELD.dizzyFrames;
        break;
      case 'held': case 'ledge': case 'ledgeClimb': case 'ledgeRoll': break;
      default:
        this.setLag(PHYS.landLag);
        game.event('land', { x: this.x, y: this.y, v: impactVy });
    }
  }

  canWalkOff() {
    if (this.state === 'attack') {
      const m = this.moveDef;
      return !!m.onFrame || m.slide;
    }
    return !EDGE_STOP.has(this.state);
  }
}
