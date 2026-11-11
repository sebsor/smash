// ─────────────────────────────────────────────────────────────
// game.js — the match simulation ("the world").
//
// Only the HOST runs this. Guests send their button presses to the host,
// the host steps this simulation 60×/second, and sends back a compact
// snapshot of the result. That's called a "host-authoritative" model:
// there is exactly one truth, so players can never disagree about who hit whom.
//
// This file has zero DOM / canvas / network code, which is why it can be
// unit-tested in plain Node (see tests/).
// ─────────────────────────────────────────────────────────────

import { PHYS, KB, SHIELD, RULES } from './config.js';
import { STAGES } from './stage.js';
import { Fighter } from './fighter.js';
import { CHARACTERS } from './characters.js';

const r1 = v => Math.round(v * 10) / 10;

// Smash-style knockback formula.
//   p = target's % AFTER the hit, d = damage, w = weight, bkb/kbg from the hitbox.
// Higher % → much more knockback; heavier weight → less.
export function knockback(p, d, w, bkb, kbg) {
  return ((((p / 10 + (p * d) / 20) * (200 / (w + 100)) * 1.4) + 18) * (kbg / 100)) + bkb;
}

function circleRect(cx, cy, r, x1, y1, x2, y2) {
  const nx = Math.max(x1, Math.min(cx, x2));
  const ny = Math.max(y1, Math.min(cy, y2));
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= r * r;
}

export class Game {
  /**
   * @param {object} o
   * @param {{id:number, slot:number, name:string, charId:string, palette:number, dummy?:boolean}[]} o.players
   */
  constructor({ players, stageId = 'skyforge', stocks = RULES.stocks }) {
    this.stage = STAGES[stageId];
    this.frame = 0;
    this.phase = 'countdown';
    this.overT = 0;
    this.events = [];
    this.eventId = 0;
    this.projectiles = [];
    this.projId = 0;
    this.ledgeOwner = this.stage.ledges.map(() => -1);
    this.elimOrder = [];
    this.inputs = new Map();
    this.fighters = players.map((p, i) => {
      const sp = this.stage.spawns[i % this.stage.spawns.length];
      const f = new Fighter({ ...p, x: sp.x, y: sp.y, stocks });
      f.facing = sp.x > 0 ? -1 : 1;
      return f;
    });
  }

  byId(id) { return this.fighters.find(f => f.id === id); }

  event(type, data = {}) {
    this.events.push({ id: ++this.eventId, t: type, f: this.frame, ...data });
  }

  setInput(id, held, pressed) { this.inputs.set(id, { held, pressed }); }

  // ═══════════════════════════════════════════════════════════
  step() {
    this.frame++;
    if (this.phase === 'countdown' && this.frame >= RULES.countdownFrames) {
      this.phase = 'play';
      this.event('go');
    }
    const acting = this.phase === 'play';

    for (const f of this.fighters) {
      const inp = this.inputs.get(f.id) || { held: 0, pressed: 0 };
      f.feedInput(acting ? inp.held : 0, acting ? inp.pressed : 0);
      // A grabbed player mashes to escape faster.
      if (f.state === 'held' && f.input.pressed) {
        const h = this.byId(f.heldBy); if (h) h.grabTimer -= 6;
      }
      if (f.input.pressed) this.inputs.set(f.id, { held: inp.held, pressed: 0 });  // consume
    }

    for (const f of this.fighters) {
      // Hitlag: both fighters freeze for a few frames on impact. It's what makes hits feel heavy.
      if (f.hitlag > 0) {
        f.hitlag--;
        if (f.hitlag === 0 && f.pendingLaunch) this.launch(f);
        continue;
      }
      f.update(this);
    }

    this.positionHeld();
    this.updateProjectiles();
    this.resolveHits();
    for (const f of this.fighters) this.checkLedge(f);
    this.checkBlastZones();
    this.checkGameOver();

    if (this.phase === 'over') this.overT++;
    // forget old events
    if (this.events.length > 64) this.events.splice(0, this.events.length - 64);
  }

  // ── Stage collision ─────────────────────────────────────────
  collide(f) {
    if (!f.alive || f.climb || ['ledge', 'held', 'respawn'].includes(f.state)) return;
    const S = this.stage, m = S.main;

    if (f.ground !== null) {
      const surf = f.ground === 0 ? m : S.platforms[f.ground - 1];
      if (f.kvy < -0.5) { f.leaveGround(); }
      else {
        f.y = surf.y;
        if (f.x < surf.x1 || f.x > surf.x2) {
          if (f.canWalkOff()) {
            f.leaveGround();
            if (['run', 'idle', 'turn', 'crouch', 'land'].includes(f.state)) f.setState('air');
          } else {
            f.x = Math.max(surf.x1, Math.min(surf.x2, f.x));
            f.vx = 0;
          }
        }
        return;
      }
    }

    // Airborne: did we cross a floor while moving down this frame?
    if (f.y >= f.py) {
      if (f.py <= m.y + 0.5 && f.y >= m.y && f.x >= m.x1 && f.x <= m.x2) { f.land(this, 0, m.y); return; }
      if (f.dropThrough === 0) {
        for (let i = 0; i < S.platforms.length; i++) {
          const p = S.platforms[i];
          if (f.py <= p.y + 0.5 && f.y >= p.y && f.x >= p.x1 && f.x <= p.x2) { f.land(this, i + 1, p.y); return; }
        }
      }
    }

    // Solid body of the main platform (walls + underside)
    const hw = f.w * 0.4;
    if (f.x + hw > m.x1 && f.x - hw < m.x2 && f.y > m.y && f.y - f.h < m.bottom) {
      const wall = (side) => {
        f.x = side < 0 ? m.x1 - hw : m.x2 + hw;
        if (f.vx * side < 0) f.vx = 0;
        if (f.state === 'tumble' && Math.abs(f.kvx) > 6) { f.kvx = -f.kvx * 0.5; this.event('bounce', { x: f.x, y: f.y - f.h / 2 }); }
        else if (f.kvx * side < 0) f.kvx = 0;
      };
      if (f.py - f.h >= m.bottom - 1) {
        f.y = m.bottom + f.h; if (f.vy < 0) f.vy = 0; if (f.kvy < 0) f.kvy = -f.kvy * 0.4;
      } else if (f.px + hw <= m.x1 + 1) wall(-1);
      else if (f.px - hw >= m.x2 - 1) wall(1);
      else {
        // Ended up inside (e.g. teleported in): exit through the nearest face.
        const d = [f.x + hw - m.x1, m.x2 - (f.x - hw), f.y - m.y, m.bottom - (f.y - f.h)];
        const k = d.indexOf(Math.min(...d));
        if (k === 0) wall(-1);
        else if (k === 1) wall(1);
        else if (k === 2) { f.land(this, 0, m.y); }
        else { f.y = m.bottom + f.h; f.vy = Math.max(0, f.vy); }
      }
    }
  }

  // ── Ledges ──────────────────────────────────────────────────
  checkLedge(f) {
    if (!f.alive || f.ledgeCD > 0 || !f.airborne || f.dirY > 0 || f.hitlag > 0) return;
    let ok = f.state === 'air' || f.state === 'helpless' || (f.state === 'tumble' && f.hitstun <= 0);
    const upB = f.state === 'attack' && f.moveDef.ledgeGrab != null && f.mt >= f.moveDef.ledgeGrab;
    if (upB) ok = true;
    if (!ok) return;
    if (!upB && f.vy + f.kvy < 0) return;   // only grab while falling (except during recovery moves)

    this.stage.ledges.forEach((L, i) => {
      if (f.state === 'ledge' || this.ledgeOwner[i] !== -1) return;
      const off = (f.x - L.x) * L.dir;            // >0 means you're out past the edge
      if (off < -f.w * 0.25 || off > f.w / 2 + 40) return;
      const below = f.y - L.y;                    // how far your feet are below the ledge
      if (below < -14 || below > f.h + 50) return;
      if (below < 6 && off < f.w * 0.5) return;   // you're basically on the stage → land instead
      this.grabLedge(f, i);
    });
  }

  grabLedge(f, i) {
    const L = this.stage.ledges[i];
    this.ledgeOwner[i] = f.id;
    f.setState('ledge');
    f.ledge = i; f.hangT = 0;
    f.x = L.x + L.dir * (f.w * 0.4 + 2);
    f.y = L.y + f.h * 0.72;
    f.facing = -L.dir;
    f.vx = f.vy = f.kvx = f.kvy = 0;
    f.airJumps = f.ch.airJumps; f.airDodged = false; f.usedAirOnce = false; f.ffall = false;
    f.invuln = Math.max(f.invuln, PHYS.ledgeInvuln);
    this.event('ledge', { x: L.x, y: L.y });
  }

  releaseLedge(f, drop = false) {
    if (f.ledge < 0) return;
    const L = this.stage.ledges[f.ledge];
    this.ledgeOwner[f.ledge] = -1;
    f.ledge = -1;
    f.ledgeCD = drop ? PHYS.ledgeRegrab : 20;
    if (drop) { f.setState('air'); f.vy = 1; f.x += L.dir * 4; }
  }

  // ── Hits ────────────────────────────────────────────────────
  hurtbox(t) {
    let hh = t.h;
    if (t.state === 'crouch' || (t.state === 'attack' && t.moveDef.pose === 'crouch')) hh = t.h * 0.65;
    if (t.state === 'down') hh = t.h * 0.35;
    return [t.x - t.w * 0.42, t.y - hh, t.x + t.w * 0.42, t.y];
  }

  resolveHits() {
    const grabs = [], hits = [];
    for (const a of this.fighters) {
      if (a.state !== 'attack' || a.hitlag > 0 || a.charging) continue;
      const m = a.moveDef;
      if (!m.hb) continue;
      for (let i = 0; i < m.hb.length; i++) {
        const h = m.hb[i];
        if (a.mt < h.s || a.mt > h.e) continue;
        const hx = a.x + a.facing * h.x, hy = a.y + h.y;
        for (const t of this.fighters) {
          if (t === a || !t.alive || t.state === 'respawn') continue;
          if (t.state === 'held' && t.heldBy === a.id) continue;
          // Each move hits a target once, unless the hitbox is a multi-hit (rehit) one.
          const key = t.id + ':' + (h.rehit ? 'r' + i : (h.g || 'm'));
          const last = a.hitMap.get(key);
          if (last !== undefined && !(h.rehit && a.mt - last >= h.rehit)) continue;
          const [x1, y1, x2, y2] = this.hurtbox(t);
          if (!circleRect(hx, hy, h.r, x1, y1, x2, y2)) continue;
          if (t.intangible()) continue;
          a.hitMap.set(key, a.mt);
          if (h.grab) { grabs.push([a, t]); break; }
          hits.push([a, t, h, hx, hy]);
        }
      }
    }
    for (const [a, t] of grabs) {
      if (a.state === 'attack' && a.move === 'grab' && !['held', 'holding'].includes(t.state)) this.grab(a, t);
    }
    for (const [a, t, h, hx, hy] of hits) {
      if (!t.alive) continue;
      let dir = a.facing;
      if (Math.abs(h.x) < 12) dir = Math.sign(t.x - a.x) || a.facing;   // centred hitboxes push away from you
      this.applyHit(a, t, h, { x: (hx + t.x) / 2, y: (hy + t.y - t.h / 2) / 2, dir });
    }
  }

  /** Apply one hit. a = attacker (may be null for orphan projectiles), h = {dmg, ang, bkb, kbg,…} */
  applyHit(a, t, h, src) {
    let dmg = h.dmg;
    if (a && h.scaleCharge) dmg *= 1 + (a.chargeF / (a.moveDef?.chargeMax || 60)) * h.scaleCharge;
    if (a && h.counter) dmg = a.counterDmg;
    dmg = r1(dmg);
    const isProj = !!src.proj;

    // Counter: the defender was waiting for exactly this.
    if (t.state === 'attack' && t.moveDef.counter && !h.unblockable) {
      const [c0, c1] = t.moveDef.counter;
      if (t.mt >= c0 && t.mt <= c1) {
        t.counterDmg = Math.max(8, dmg * 1.3);
        if (a) t.facing = Math.sign(a.x - t.x) || t.facing;
        t.startMove('counterHit', this);
        if (a && !isProj) a.hitlag = 16;
        this.event('counter', { x: t.x, y: t.y - t.h / 2, slot: t.slot });
        return 'counter';
      }
    }

    // Shield: block the damage, but the shield shrinks and you get pushed back.
    if ((t.state === 'shield' || t.state === 'shieldstun') && !h.unblockable) {
      t.shieldHP -= dmg * 1.15 + 1;
      const hl = Math.round(this.hitlagFor(dmg) * 0.7);
      t.hitlag = hl; if (a && !isProj) a.hitlag = hl;
      t.vx = src.dir * Math.min(9, dmg * 0.35 + 1.5);
      if (a && !isProj && !a.airborne) a.vx = -src.dir * Math.min(5, dmg * 0.15 + 0.5);
      this.event('shieldHit', { x: src.x, y: src.y, dmg });
      if (t.shieldHP <= 0) this.shieldBreak(t);
      else t.setLag(Math.round(dmg * 0.85 + 3), 'shieldstun');
      return 'shield';
    }

    t.dmg = Math.min(999, r1(t.dmg + dmg));
    if (a) a.stats.dealt = r1(a.stats.dealt + dmg);
    const kb = knockback(t.dmg, dmg, t.weight, h.bkb, h.kbg);

    // Armor: the move keeps going if the hit isn't strong enough.
    if (t.state === 'attack' && t.moveDef.armor) {
      const [s0, s1, thr] = t.moveDef.armor;
      if (t.mt >= s0 && t.mt <= s1 && kb < thr) {
        t.hitlag = 5; if (a && !isProj) a.hitlag = 5;
        this.event('hit', { x: src.x, y: src.y, dmg, kb: 10, slot: t.slot, armor: 1 });
        return 'armor';
      }
    }

    // Launch direction from the angle (relative to the attacker's facing).
    const rad = h.ang * Math.PI / 180;
    let lx = Math.cos(rad) * src.dir, ly = -Math.sin(rad);
    if (!t.airborne && ly > 0) ly = kb < 80 ? -0.2 : -ly * 0.8;   // spiked on the ground → pop up instead
    const len = Math.hypot(lx, ly) || 1; lx /= len; ly /= len;

    // Being hit cancels whatever you were doing.
    this.breakHolds(t);
    if (t.ledge >= 0) this.releaseLedge(t);
    t.climb = null;

    const speed = kb * KB.launchK;
    if (!t.airborne && kb < KB.flinchBelow) {
      t.setState('hitstun'); t.hitstun = Math.max(8, Math.floor(kb * KB.hitstunK));
      t.pendingLaunch = { lx: Math.sign(lx) || src.dir, ly: 0, speed: speed * 0.5 };
    } else {
      t.setState(kb >= KB.tumbleAt ? 'tumble' : 'hitstun');
      t.hitstun = Math.floor(kb * KB.hitstunK);
      t.pendingLaunch = { lx, ly, speed };
    }
    t.ffall = false;
    const hl = this.hitlagFor(dmg) + (isProj ? 0 : 0);
    t.hitlag = hl;
    if (a && !isProj) a.hitlag = hl;
    if (a) { t.lastHitBy = a.id; t.lastHitT = this.frame; }
    this.event('hit', { x: r1(src.x), y: r1(src.y), dmg, kb: Math.round(kb), slot: t.slot, ang: Math.round(Math.atan2(ly, lx) * 57.3) });
    return 'hit';
  }

  hitlagFor(dmg) { return Math.min(KB.hitlagMax, Math.floor(KB.hitlagBase + dmg * KB.hitlagPerDmg)); }

  // After hitlag ends, actually send them flying (with DI).
  launch(f) {
    let { lx, ly, speed } = f.pendingLaunch;
    f.pendingLaunch = null;
    // DI: holding a direction bends your launch angle a little (up to 15°).
    const dx = f.dirX, dy = f.dirY;
    if ((dx || dy) && speed > 4) {
      const dl = Math.hypot(dx, dy);
      const cross = lx * (dy / dl) - ly * (dx / dl);
      const th = cross * KB.diMaxDeg * Math.PI / 180;
      const c = Math.cos(th), s = Math.sin(th);
      [lx, ly] = [lx * c - ly * s, lx * s + ly * c];
    }
    f.vx = 0; f.vy = 0;
    f.kvx = lx * speed; f.kvy = ly * speed;
    if (f.kvy < -0.5) f.leaveGround();
  }

  shieldBreak(f) {
    f.setState('shieldbreak');
    f.shieldHP = SHIELD.breakResetTo;
    f.leaveGround();
    f.vy = -14; f.vx = 0;
    this.event('shieldBreak', { x: f.x, y: f.y - f.h / 2, slot: f.slot });
  }

  // ── Grabs ───────────────────────────────────────────────────
  grab(a, t) {
    this.breakHolds(t);
    if (t.ledge >= 0) this.releaseLedge(t);
    a.setState('holding'); a.holding = t.id; a.vx = 0;
    a.grabTimer = Math.round(70 + t.dmg * 0.9); a.pummelT = 0;
    t.setState('held'); t.heldBy = a.id;
    t.vx = t.vy = t.kvx = t.kvy = 0;
    t.ground = a.ground;
    this.event('grab', { x: t.x, y: t.y - t.h / 2 });
  }

  breakHolds(f) {
    if (f.holding >= 0) {
      const t = this.byId(f.holding);
      f.holding = -1;
      if (t && t.state === 'held') { t.heldBy = -1; t.setState(t.airborne ? 'air' : 'idle'); }
    }
    if (f.heldBy >= 0) {
      const h = this.byId(f.heldBy);
      if (h && h.holding === f.id) { h.holding = -1; if (h.state === 'holding') h.setState('idle'); }
      f.heldBy = -1;
    }
  }

  positionHeld() {
    for (const t of this.fighters) {
      if (t.state !== 'held') continue;
      const a = this.byId(t.heldBy);
      const ok = a && a.holding === t.id && (a.state === 'holding' || a.state === 'attack');
      if (!ok) { t.heldBy = -1; t.setState(t.airborne ? 'air' : 'idle'); continue; }
      // Back throw swings them behind you.
      const behind = a.move === 'bthrow' && a.mt >= 7;
      const side = behind ? -a.facing : a.facing;
      t.x = a.x + side * (a.w * 0.42 + t.w * 0.42 - 4);
      t.y = a.y - (a.move === 'uthrow' && a.mt >= 6 ? 30 : 0);
      t.facing = -side;
      t.ground = a.ground;
    }
  }

  pummelHit(a, dmg) {
    const t = this.byId(a.holding);
    if (!t) return;
    t.dmg = r1(t.dmg + dmg);
    a.stats.dealt = r1(a.stats.dealt + dmg);
    t.hitlag = 3;
    this.event('hit', { x: t.x, y: t.y - t.h / 2, dmg, kb: 5, slot: t.slot });
  }

  throwHit(a, th) {
    const t = this.byId(a.holding);
    if (!t) return;
    a.holding = -1; t.heldBy = -1;
    // Throws are unblockable and bypass counters.
    this.applyHit(a, t, { dmg: th.dmg, ang: th.ang, bkb: th.bkb, kbg: th.kbg, unblockable: true },
      { x: t.x, y: t.y - t.h / 2, dir: a.facing });
    a.hitlag = 0;
  }

  releaseGrab(a, t) {
    a.holding = -1; t.heldBy = -1;
    a.setLag(14); a.vx = -a.facing * 3;
    t.setState('hitstun'); t.hitstun = 10; t.kvx = a.facing * 5;
    this.event('sfx', { name: 'release', x: t.x, y: t.y });
  }

  // ── Projectiles ─────────────────────────────────────────────
  spawnProjectile(owner, spec) {
    // Order matters: `...spec` copies ALL fields from the move data, and with a spread
    // the LAST value of a field wins. spec.x / spec.y are offsets from the fighter
    // (e.g. "36 px in front, 40 px up"), so the spread must come FIRST and the real
    // world position must be written AFTER it — otherwise the offset overwrites it.
    const p = {
      ...spec,
      id: ++this.projId, owner: owner.id, slot: owner.slot,
      dir: owner.facing, x: owner.x + owner.facing * spec.x, y: owner.y + spec.y,
      px: 0, py: 0, age: 0, hitMap: new Map(),
    };
    p.vx = spec.vx * owner.facing; p.vy = spec.vy || 0; p.sp = Math.abs(p.vx);
    this.projectiles.push(p);
    this.event('sfx', { name: 'shoot', x: p.x, y: p.y, kind: p.kind });
    return p;
  }

  updateProjectiles() {
    const S = this.stage, m = S.main, B = S.blast;
    for (const p of this.projectiles) {
      p.age++; p.px = p.x; p.py = p.y;
      if (p.kind === 'boomer' && p.returning) {
        if (!p.back) { p.vx -= p.dir * 0.42; if (p.vx * p.dir <= 0) p.back = true; }
        else {
          const o = this.byId(p.owner);
          if (!o || !o.alive) { p.dead = true; continue; }
          const dx = o.x - p.x, dy = (o.y - o.h * 0.55) - p.y, d = Math.hypot(dx, dy) || 1;
          p.sp = Math.min(15, (p.sp || 0) + 0.5);
          p.vx = dx / d * p.sp; p.vy = dy / d * p.sp;
          if (d < 28) { p.dead = true; continue; }
        }
      }
      if (p.grav) p.vy += p.grav;
      p.x += p.vx; p.y += p.vy;
      if (--p.life <= 0) p.dead = true;
      if (p.x < B.left || p.x > B.right || p.y > B.bottom || p.y < B.top) p.dead = true;

      // Bouncing projectiles bounce on floors; everything else breaks on the stage body.
      if (p.grav && p.vy > 0) {
        const surfs = [m, ...S.platforms];
        for (const s of surfs) {
          if (p.py + p.r <= s.y + 1 && p.y + p.r >= s.y && p.x >= s.x1 && p.x <= s.x2) {
            p.y = s.y - p.r; p.vy = -7.5;
            if (--p.bounces < 0) p.dead = true;
            break;
          }
        }
      }
      if (p.kind !== 'boomer' && p.x > m.x1 && p.x < m.x2 && p.y > m.y + p.r * 0.5 && p.y < m.bottom) p.dead = true;
      if (p.dead) continue;

      for (const f of this.fighters) {
        if (!f.alive || f.id === p.owner) continue;
        // Reflectors send the projectile back and make it stronger.
        if (f.state === 'attack' && f.moveDef.reflect) {
          const [r0, r1_, rx, ry, rr] = f.moveDef.reflect;
          if (f.mt >= r0 && f.mt <= r1_ && Math.hypot(f.x + f.facing * rx - p.x, f.y + ry - p.y) < rr + p.r) {
            p.owner = f.id; p.slot = f.slot;
            p.returning = false; p.grav = 0;
            p.vx = f.facing * Math.max(10, Math.abs(p.vx) * 1.1); p.vy = 0; p.dir = f.facing;
            p.dmg = r1(p.dmg * 1.5); p.life = 90; p.hitMap.clear();
            this.event('reflect', { x: p.x, y: p.y });
            continue;
          }
        }
        const last = p.hitMap.get(f.id);
        if (last !== undefined && !(p.rehit && p.age - last >= p.rehit)) continue;
        const [x1, y1, x2, y2] = this.hurtbox(f);
        if (!circleRect(p.x, p.y, p.r, x1, y1, x2, y2) || f.intangible()) continue;
        p.hitMap.set(f.id, p.age);
        const res = this.applyHit(this.byId(p.owner), f, p, { proj: true, x: p.x, y: p.y, dir: Math.sign(p.vx) || p.dir });
        if (!p.rehit || res === 'shield' || res === 'counter') p.dead = true;
        break;
      }
    }
    // Opposing projectiles cancel each other out
    for (let i = 0; i < this.projectiles.length; i++) {
      for (let j = i + 1; j < this.projectiles.length; j++) {
        const a = this.projectiles[i], b = this.projectiles[j];
        if (a.dead || b.dead || a.owner === b.owner) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) {
          a.dead = b.dead = true;
          this.event('clank', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
      }
    }
    this.projectiles = this.projectiles.filter(p => !p.dead);
  }

  // ── Stocks, KOs and respawning ──────────────────────────────
  checkBlastZones() {
    const B = this.stage.blast;
    for (const f of this.fighters) {
      if (!f.alive || f.state === 'respawn') continue;
      let side = null;
      if (f.x < B.left) side = 'left';
      else if (f.x > B.right) side = 'right';
      else if (f.y > B.bottom) side = 'bottom';
      else if (f.y - f.h < B.top && (f.hitstun > 0 || f.state === 'tumble')) side = 'top';
      else if (f.y - f.h < B.top) { f.y = B.top + f.h; f.vy = Math.max(0, f.vy); }
      if (side) this.ko(f, side);
    }
  }

  ko(f, side) {
    const B = this.stage.blast;
    this.event('ko', {
      x: r1(Math.max(B.left, Math.min(B.right, f.x))), y: r1(Math.max(B.top, Math.min(B.bottom, f.y - f.h / 2))),
      side, slot: f.slot,
    });
    const killer = f.lastHitBy >= 0 && this.frame - f.lastHitT < 480 ? this.byId(f.lastHitBy) : null;
    if (killer && killer !== f) killer.stats.kos++; else f.stats.sds++;
    f.stats.falls++;
    this.breakHolds(f);
    if (f.ledge >= 0) this.releaseLedge(f);
    f.stocks--;
    f.dmg = 0; f.vx = f.vy = f.kvx = f.kvy = 0; f.hitlag = 0; f.hitstun = 0; f.pendingLaunch = null;
    f.move = null; f.climb = null; f.ground = null;
    if (f.stocks <= 0) { f.state = 'out'; this.elimOrder.push(f.id); }
    else { f.state = 'dead'; f.sf = 0; f.respawnT = PHYS.respawnWait; }
  }

  respawn(f) {
    const R = this.stage.respawn;
    f.x = R.x; f.y = R.y; f.px = f.x; f.py = f.y;
    f.ground = null; f.vx = f.vy = f.kvx = f.kvy = 0;
    f.setState('respawn');
    f.shieldHP = SHIELD.max;
    f.airJumps = f.ch.airJumps; f.airDodged = false; f.usedAirOnce = false;
  }

  removePlayer(id) {
    const f = this.byId(id);
    if (!f || f.state === 'out') return;
    this.breakHolds(f);
    if (f.ledge >= 0) this.releaseLedge(f);
    f.stocks = 0; f.state = 'out'; f.left = true;
    this.elimOrder.push(f.id);
    this.event('left', { slot: f.slot });
  }

  checkGameOver() {
    if (this.phase !== 'play') return;
    const left = this.fighters.filter(f => f.state !== 'out');
    const over = this.fighters.length > 1 ? left.length <= 1 : left.length === 0;
    if (over) { this.phase = 'over'; this.overT = 0; this.event('game'); }
  }

  results() {
    const alive = this.fighters.filter(f => f.state !== 'out')
      .sort((a, b) => b.stocks - a.stocks || a.dmg - b.dmg);
    const order = [...alive, ...[...this.elimOrder].reverse().map(id => this.byId(id))];
    return order.map((f, i) => ({
      place: i + 1, id: f.id, slot: f.slot, name: f.name, charId: f.charId, palette: f.palette,
      ...f.stats, left: !!f.left, dummy: f.dummy,
    }));
  }

  // ── Network snapshot ────────────────────────────────────────
  // Everything a guest needs to DRAW the frame — not to simulate it.
  snapshot() {
    return {
      f: this.frame, ph: this.phase, ov: this.overT,
      F: this.fighters.map(f => ({
        i: f.id, x: r1(f.x), y: r1(f.y), vx: r1(f.vx + f.kvx), vy: r1(f.vy + f.kvy),
        fa: f.facing, s: f.state, sf: f.sf, m: f.move, mt: f.mt, c: f.charging ? f.chargeF : 0,
        d: f.dmg, st: f.stocks, sh: Math.round(f.shieldHP), iv: f.intangible() ? 1 : 0, hl: f.hitlag,
        g: f.ground === null ? 0 : 1, dj: f.djT, hs: f.hitstun > 0 ? 1 : 0, cl: f.climb ? 1 : 0,
      })),
      P: this.projectiles.map(p => ({ i: p.id, k: p.kind, x: r1(p.x), y: r1(p.y), vx: r1(p.vx), vy: r1(p.vy), r: r1(p.r), o: p.slot })),
      E: this.events.filter(e => e.f >= this.frame - 30),
    };
  }
}
