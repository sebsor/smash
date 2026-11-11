// ─────────────────────────────────────────────────────────────
// render.js — draws a snapshot onto a <canvas>.
//
// Important idea: the renderer NEVER changes game state. It receives
// a snapshot (positions, states, move frames) and decides how it looks.
// That's why guests and the host can share this file: both just hand
// it a snapshot.
//
// Animation trick: fighters are "Rayman-style" — a body shape plus
// floating hands and feet. Each frame we compute where each limb SHOULD
// be (a target pose), then move the drawn limb part of the way there
// (a spring). That turns choppy 60 fps state into smooth motion, and an
// attack's limb target is simply its hitbox position from characters.js.
// ─────────────────────────────────────────────────────────────

import { CHARACTERS } from './characters.js';
import { STAGES } from './stage.js';
import { RULES } from './config.js';

export const SLOT_COLORS = ['#ff4d6d', '#3fa9ff', '#ffc93c', '#4fdc8a'];
export const SLOT_NAMES = ['P1', 'P2', 'P3', 'P4'];
const FONT_DISPLAY = '"Bowlby One", "Arial Black", sans-serif';
const FONT_UI = 'Rubik, system-ui, sans-serif';

export function fighterColor(charId, pal) {
  const c = CHARACTERS[charId];
  return c.palettes[pal % c.palettes.length];
}

// ── small math helpers ──
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => t * t * (3 - 2 * t);
function shade(hex, amt) {
  // amt -1..1 → darken/lighten
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return `rgb(${r},${g},${b})`;
}
function damageColor(d) {
  const stops = [[0, [255, 255, 255]], [50, [255, 228, 120]], [100, [255, 150, 70]], [150, [240, 50, 80]], [220, [150, 20, 50]]];
  for (let i = 1; i < stops.length; i++) {
    if (d <= stops[i][0]) {
      const [a0, c0] = stops[i - 1], [a1, c1] = stops[i];
      const t = (d - a0) / (a1 - a0);
      return `rgb(${c0.map((v, k) => Math.round(lerp(v, c1[k], t))).join(',')})`;
    }
  }
  return 'rgb(150,20,50)';
}

// ═════════════════════════════════════════════════════════════
// POSE: where should each limb be right now? (local coords, x = forward)
// ═════════════════════════════════════════════════════════════
function restPose(ch, t) {
  const w = ch.w, h = ch.h, bob = Math.sin(t * 0.08) * 2;
  return {
    hand: { x: w * 0.62, y: -h * 0.42 + bob },
    hand2: { x: -w * 0.55, y: -h * 0.4 + bob * 0.8 },
    foot: { x: w * 0.24, y: -2 },
    foot2: { x: -w * 0.24, y: -2 },
  };
}

function limbTargetFromMove(ch, m, mt, limb, rest) {
  const hbs = (m.hb || []).filter(h => h.limb === limb);
  if (!hbs.length) return null;
  const first = hbs[0], last = hbs[hbs.length - 1];
  const P = h => ({ x: h.x, y: h.y });
  if (mt < first.s) {
    // wind-up: pull the limb back the opposite way
    const k = ease(clamp(mt / Math.max(1, first.s), 0, 1));
    const wind = { x: -first.x * 0.35, y: first.y * 0.75 + (first.y > -10 ? -10 : 0) };
    return { x: lerp(rest.x, wind.x, k), y: lerp(rest.y, wind.y, k), snap: false };
  }
  for (let i = 0; i < hbs.length; i++) {
    const h = hbs[i];
    if (mt >= h.s && mt <= h.e) return { ...P(h), snap: true, active: true };
    const nx = hbs[i + 1];
    if (nx && mt > h.e && mt < nx.s) {
      const k = (mt - h.e) / (nx.s - h.e);
      return { x: lerp(h.x, nx.x, k), y: lerp(h.y, nx.y, k), snap: true };
    }
  }
  const k = ease(clamp((mt - last.e) / Math.max(1, m.total - last.e), 0, 1));
  return { x: lerp(last.x, rest.x, k), y: lerp(last.y, rest.y, k), snap: false };
}

function computePose(fs, ch, vis, t) {
  const w = ch.w, h = ch.h;
  const p = { limbs: restPose(ch, t + vis.seed), rot: 0, sx: 1, sy: 1, bodyDx: 0, bodyDy: 0, alpha: 1, eyes: 'normal', glow: 0, flash: 0, shakeX: 0 };
  const L = p.limbs;
  const s = fs.s;

  switch (s) {
    case 'run': case 'turn': {
      vis.runPhase += Math.abs(fs.vx) * 0.055;
      const ph = vis.runPhase;
      L.foot = { x: Math.sin(ph) * w * 0.38, y: -Math.max(0, Math.cos(ph)) * 12 };
      L.foot2 = { x: Math.sin(ph + Math.PI) * w * 0.38, y: -Math.max(0, Math.cos(ph + Math.PI)) * 12 };
      L.hand = { x: w * 0.45 - Math.sin(ph) * w * 0.3, y: -h * 0.42 };
      L.hand2 = { x: -w * 0.3 - Math.sin(ph + Math.PI) * w * 0.3, y: -h * 0.4 };
      p.rot = s === 'turn' ? -0.25 : 0.14;
      p.bodyDy = -Math.abs(Math.sin(ph)) * 4;
      break;
    }
    case 'crouch':
      p.sy = 0.72; p.sx = 1.15;
      L.hand = { x: w * 0.55, y: -h * 0.22 }; L.hand2 = { x: -w * 0.5, y: -h * 0.2 };
      L.foot = { x: w * 0.32, y: -1 }; L.foot2 = { x: -w * 0.32, y: -1 };
      break;
    case 'jumpsquat': case 'land':
      p.sy = 0.8; p.sx = 1.12;
      L.foot = { x: w * 0.3, y: -1 }; L.foot2 = { x: -w * 0.3, y: -1 };
      break;
    case 'air': case 'helpless': case 'shieldbreak': {
      const rising = fs.vy < 0;
      L.foot = { x: w * 0.18, y: rising ? -10 : -4 }; L.foot2 = { x: -w * 0.22, y: rising ? -14 : 2 };
      L.hand = { x: w * 0.62, y: -h * (rising ? 0.62 : 0.78) }; L.hand2 = { x: -w * 0.6, y: -h * (rising ? 0.55 : 0.8) };
      p.sy = rising ? 1.06 : 0.98; p.sx = rising ? 0.95 : 1.02;
      if (fs.dj < 20) p.rot = -fs.dj / 20 * Math.PI * 2;      // double-jump flip
      if (s === 'helpless') { p.alpha = 0.85; p.eyes = 'tired'; }
      break;
    }
    case 'shield': case 'shieldstun':
      L.hand = { x: w * 0.4, y: -h * 0.6 }; L.hand2 = { x: w * 0.25, y: -h * 0.45 };
      p.sy = 0.94; p.eyes = 'focus';
      break;
    case 'roll': case 'getupRoll': case 'ledgeRoll':
      p.rot = (fs.sf / 30) * Math.PI * 2 * (fs.vx >= 0 ? 1 : -1) * fs.fa; p.sy = 0.85; p.alpha = 0.6;
      L.hand = { x: w * 0.2, y: -h * 0.5 }; L.hand2 = { x: -w * 0.2, y: -h * 0.5 };
      break;
    case 'spotdodge': case 'airdodge': case 'tech':
      p.alpha = 0.55; p.flash = 0.35;
      if (s === 'spotdodge') { p.sy = 0.85; p.bodyDx = -6; }
      break;
    case 'hitstun': case 'tumble': {
      p.eyes = 'hurt';
      const flail = Math.sin(t * 0.6) * 6;
      L.hand = { x: w * 0.7, y: -h * 0.85 + flail }; L.hand2 = { x: -w * 0.7, y: -h * 0.75 - flail };
      L.foot = { x: w * 0.35, y: 8 - flail }; L.foot2 = { x: -w * 0.35, y: 4 + flail };
      if (s === 'tumble') { vis.spin += 0.32 * fs.fa; p.rot = vis.spin; }
      else p.rot = -0.35;
      break;
    }
    case 'down':
      p.rot = -Math.PI / 2 * 0.95; p.bodyDy = h * 0.32; p.eyes = 'hurt';
      L.hand = { x: w * 0.6, y: -6 }; L.hand2 = { x: -w * 0.5, y: -4 }; L.foot = { x: -w * 0.9, y: -3 }; L.foot2 = { x: -w * 1.1, y: -6 };
      break;
    case 'getup':
      p.sy = 0.8 + Math.min(1, fs.sf / 20) * 0.2; p.alpha = 0.7;
      break;
    case 'dizzy':
      p.eyes = 'dizzy'; p.rot = Math.sin(t * 0.1) * 0.15;
      L.hand = { x: w * 0.6, y: -h * 0.2 }; L.hand2 = { x: -w * 0.6, y: -h * 0.2 };
      break;
    case 'ledge':
      L.hand = { x: w * 0.35, y: -h * 0.98 }; L.hand2 = { x: w * 0.2, y: -h * 0.98 };
      L.foot = { x: w * 0.05, y: 6 }; L.foot2 = { x: -w * 0.1, y: 2 };
      p.rot = 0.1;
      break;
    case 'ledgeClimb':
      p.sy = 0.85 + Math.min(1, fs.sf / 16) * 0.15;
      break;
    case 'held':
      p.eyes = 'hurt';
      L.hand = { x: w * 0.6, y: -h * 0.85 + Math.sin(t * 0.7) * 5 }; L.hand2 = { x: -w * 0.6, y: -h * 0.85 - Math.sin(t * 0.7) * 5 };
      L.foot = { x: w * 0.25, y: 4 }; L.foot2 = { x: -w * 0.25, y: 6 };
      break;
    case 'holding':
      L.hand = { x: w * 0.8, y: -h * 0.55 }; L.hand2 = { x: w * 0.7, y: -h * 0.4 };
      break;
    case 'respawn':
      p.glow = 0.6;
      break;
    case 'attack': {
      const m = ch.moves[fs.m];
      if (!m) break;
      const mt = fs.mt;
      p.eyes = 'focus';
      if (fs.g === 0) {   // aerial attacks start from an airborne pose
        L.foot = { x: w * 0.18, y: -8 }; L.foot2 = { x: -w * 0.22, y: -6 };
      }
      if (m.pose === 'crouch') { p.sy = 0.78; p.sx = 1.1; }
      for (const limb of ['hand', 'hand2', 'foot', 'foot2']) {
        const tg = limbTargetFromMove(ch, m, mt, limb, L[limb]);
        if (tg) { L[limb] = tg; if (tg.active) vis.activeLimb = limb; }
      }
      // body-type hitboxes lunge the whole body
      const bh = (m.hb || []).find(hh => hh.limb === 'body' && mt >= hh.s && mt <= hh.e);
      if (bh) { p.bodyDx = clamp(bh.x * 0.25, -12, 12); p.sx = 1.08; p.sy = 0.94; }
      if (m.spin && mt >= m.spin[0] && mt <= m.spin[1]) {
        p.rot = ((mt - m.spin[0]) / (m.spin[1] - m.spin[0])) * Math.PI * 2 * m.spin[2];
      }
      // projectile casts / specials without a hand hitbox: thrust a hand forward
      if (!m.hb && (fs.m === 'nspec' || fs.m === 'sspec')) {
        const k = mt < 10 ? ease(mt / 10) : clamp(1 - (mt - 14) / 14, 0, 1);
        L.hand = { x: lerp(-w * 0.2, w * 0.95, k), y: -h * 0.55 };
      }
      if (m.counter) {
        const on = mt >= m.counter[0] && mt <= m.counter[1];
        L.hand = { x: w * 0.4, y: -h * 0.7 }; L.hand2 = { x: w * 0.45, y: -h * 0.35 };
        if (on) p.glow = 0.7;
      }
      if (m.reflect) {
        L.hand = { x: w * 0.75, y: -h * 0.6 }; L.hand2 = { x: w * 0.7, y: -h * 0.4 };
      }
      if (m.intang && mt >= m.intang[0] && mt <= m.intang[1] && fs.m === 'uspec') p.alpha = 0.15;
      if (fs.m === 'bthrow') p.rot = Math.min(1, mt / 14) * Math.PI * 2 * -1;
      if (fs.m === 'uthrow') { L.hand = { x: w * 0.1, y: -h * 1.3 }; L.hand2 = { x: -w * 0.1, y: -h * 1.3 }; }
      if (fs.m === 'dthrow') { L.hand = { x: w * 0.6, y: -6 }; p.sy = 0.8; }
      if (fs.m === 'fthrow') { const k = clamp(mt / 12, 0, 1); L.hand = { x: lerp(w * 0.5, w * 1.2, k), y: -h * 0.5 }; L.hand2 = { x: lerp(w * 0.4, w * 1.1, k), y: -h * 0.4 }; }
      if (fs.c > 0) {   // charging a smash / special
        p.glow = Math.min(1, fs.c / 60); p.shakeX = (Math.random() - 0.5) * 2 * p.glow * 2;
        p.flash = (Math.floor(t / 4) % 2) * 0.25 * p.glow;
      }
      break;
    }
  }
  if (fs.iv && !['airdodge', 'spotdodge', 'roll', 'getupRoll', 'ledgeRoll', 'tech', 'respawn'].includes(s) && s !== 'attack') {
    p.alpha *= (Math.floor(t / 3) % 2) ? 0.55 : 0.95;   // invincibility blink
  }
  if (fs.hl > 0) p.shakeX += (Math.random() - 0.5) * 6;  // hitlag shake
  return p;
}

// ═════════════════════════════════════════════════════════════
// Drawing one fighter (also used by the menus)
// ═════════════════════════════════════════════════════════════
function bodyPath(ctx, shape, w, h) {
  ctx.beginPath();
  const cy = -h * 0.56;
  if (shape === 'circle') ctx.arc(0, cy, w * 0.52, 0, Math.PI * 2);
  else if (shape === 'square') {
    const s = w * 0.98, r = 12;
    ctx.roundRect(-s / 2, cy - s * 0.55, s, s * 1.1, r);
  } else if (shape === 'triangle') {
    const s = w * 0.62;
    ctx.moveTo(0, cy - h * 0.48);
    ctx.lineTo(s + 4, cy + h * 0.38);
    ctx.lineTo(-s - 4, cy + h * 0.38);
    ctx.closePath();
  } else if (shape === 'hexagon') {
    const r = w * 0.56;
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * Math.PI / 3;
      const x = Math.cos(a) * r, y = cy + Math.sin(a) * r * 1.08;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
}

function drawEyes(ctx, ch, mode, t, seed) {
  const w = ch.w, h = ch.h;
  const ey = -h * 0.6 + (ch.shape === 'triangle' ? h * 0.1 : 0);
  const ex = w * 0.14, ex2 = w * 0.36, er = Math.max(4.5, w * 0.11);
  const blink = ((t + seed * 37) % 220) < 6;
  ctx.lineCap = 'round';
  for (const x of [ex, ex2]) {
    if (mode === 'hurt') {
      ctx.strokeStyle = '#1a1238'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - er * 0.7, ey - er * 0.7); ctx.lineTo(x + er * 0.7, ey + er * 0.7);
      ctx.moveTo(x + er * 0.7, ey - er * 0.7); ctx.lineTo(x - er * 0.7, ey + er * 0.7); ctx.stroke();
      continue;
    }
    if (mode === 'dizzy') {
      ctx.strokeStyle = '#1a1238'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, ey, er * 0.7, t * 0.2, t * 0.2 + Math.PI * 1.5); ctx.stroke();
      continue;
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    const sq = blink ? 0.12 : mode === 'focus' ? 0.6 : mode === 'tired' ? 0.45 : 1;
    ctx.ellipse(x, ey, er, er * 1.25 * sq, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!blink) {
      ctx.fillStyle = '#1a1238';
      ctx.beginPath(); ctx.ellipse(x + er * 0.35, ey + (mode === 'tired' ? er * 0.2 : 0), er * 0.48, er * 0.6 * Math.max(0.5, sq), 0, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (mode === 'focus') {   // determined brows
    ctx.strokeStyle = '#1a1238'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(ex - er, ey - er * 1.3); ctx.lineTo(ex + er, ey - er * 0.8);
    ctx.moveTo(ex2 - er, ey - er * 0.8); ctx.lineTo(ex2 + er, ey - er * 1.3); ctx.stroke();
  }
}

/**
 * Draw a fighter at world/screen position (x, y = feet) in the current transform.
 * `vis` holds the smoothed limb positions; `pose` is computePose's target.
 */
function drawFighterBody(ctx, ch, color, vis, pose, facing, t, outline) {
  const w = ch.w, h = ch.h;
  const dark = shade(color, -0.45), light = shade(color, 0.35);
  ctx.save();
  ctx.scale(facing, 1);
  ctx.globalAlpha *= pose.alpha;

  if (pose.glow > 0) {
    ctx.save();
    ctx.globalAlpha *= 0.5 * pose.glow;
    const g = ctx.createRadialGradient(0, -h * 0.55, 4, 0, -h * 0.55, w * 1.4);
    g.addColorStop(0, light); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, -h * 0.55, w * 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  const limbR = Math.max(6, w * 0.16), footRX = Math.max(8, w * 0.22), footRY = Math.max(5, w * 0.13);
  const drawLimb = (name) => {
    const l = vis.limbs[name];
    const back = name.endsWith('2');
    ctx.fillStyle = back ? dark : color;
    ctx.strokeStyle = outline; ctx.lineWidth = 3;
    ctx.beginPath();
    if (name.startsWith('hand')) ctx.arc(l.x, l.y, limbR, 0, Math.PI * 2);
    else ctx.ellipse(l.x, l.y - footRY * 0.6, footRX, footRY, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  };
  // back limbs behind the body
  drawLimb('hand2'); drawLimb('foot2');

  // body (rotates/squashes around its centre)
  ctx.save();
  ctx.translate(pose.bodyDx + pose.shakeX, -h * 0.5 + pose.bodyDy);
  ctx.rotate(vis.rot);
  ctx.scale(vis.sx, vis.sy);
  ctx.translate(0, h * 0.5);
  bodyPath(ctx, ch.shape, w, h);
  const grad = ctx.createLinearGradient(0, -h, 0, 0);
  grad.addColorStop(0, light); grad.addColorStop(0.55, color); grad.addColorStop(1, dark);
  ctx.fillStyle = grad; ctx.fill();
  ctx.lineWidth = 3.5; ctx.strokeStyle = outline; ctx.stroke();
  if (pose.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${pose.flash})`; ctx.fill(); }
  // highlight
  ctx.save(); ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.ellipse(-w * 0.18, -h * 0.82, w * 0.32, h * 0.12, -0.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  drawEyes(ctx, ch, pose.eyes, t, vis.seed);
  ctx.restore();

  drawLimb('foot'); drawLimb('hand');
  ctx.restore();
}

function newVis(ch, seed = 0) {
  const r = restPose(ch, 0);
  return { limbs: JSON.parse(JSON.stringify(r)), rot: 0, sx: 1, sy: 1, runPhase: 0, spin: 0, seed, trail: [], pummel: 0, activeLimb: null };
}

function springVis(vis, pose, snappy) {
  const k = snappy ? 0.6 : 0.32;
  for (const n of ['hand', 'hand2', 'foot', 'foot2']) {
    const a = vis.limbs[n], b = pose.limbs[n];
    const kk = b.snap ? 0.75 : k;
    a.x += (b.x - a.x) * kk; a.y += (b.y - a.y) * kk;
  }
  // rotation: shortest path unless spinning
  let dr = pose.rot - vis.rot;
  if (Math.abs(dr) > Math.PI * 1.2 && !snappy) vis.rot = pose.rot;
  else vis.rot += dr * (snappy ? 0.7 : 0.3);
  vis.sx += (pose.sx - vis.sx) * 0.35; vis.sy += (pose.sy - vis.sy) * 0.35;
}

// Menu helper: an idling fighter for character select / title screen.
const previewVis = new Map();
export function drawFighterPreview(ctx, charId, palette, x, y, scale, t, facing = 1, state = 'idle') {
  const ch = CHARACTERS[charId];
  const key = charId + palette + state + facing;
  if (!previewVis.has(key)) previewVis.set(key, newVis(ch, previewVis.size * 7));
  const vis = previewVis.get(key);
  const fs = { s: state, sf: t % 60, vx: state === 'run' ? 8 : 0, vy: 0, fa: facing, g: 1, dj: 99, iv: 0, hl: 0, c: 0 };
  const pose = computePose(fs, ch, vis, t);
  springVis(vis, pose, false);
  ctx.save();
  ctx.translate(x, y); ctx.scale(scale, scale);
  // shadow
  ctx.fillStyle = 'rgba(10,6,30,0.35)';
  ctx.beginPath(); ctx.ellipse(0, 2, ch.w * 0.55, 6, 0, 0, Math.PI * 2); ctx.fill();
  drawFighterBody(ctx, ch, fighterColor(charId, palette), vis, pose, facing, t, '#1a1238');
  ctx.restore();
}

// ═════════════════════════════════════════════════════════════
// The match renderer
// ═════════════════════════════════════════════════════════════
export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: -150, z: 0.6 };
    this.vis = new Map();
    this.parts = [];
    this.shake = 0;
    this.flash = 0;
    this.t = 0;
    this.hudShake = {};
    this.lastDmg = {};
    this.bgShapes = Array.from({ length: 26 }, (_, i) => ({
      x: (Math.sin(i * 91.7) * 0.5 + 0.5) * 3600 - 1800,
      y: (Math.cos(i * 37.3) * 0.5 + 0.5) * 1500 - 1250,
      s: 20 + (i * 53 % 70), depth: 0.12 + (i % 5) * 0.07, kind: i % 4, rot: i,
    }));
    this.stars = Array.from({ length: 90 }, (_, i) => ({ x: (i * 997 % 1000) / 1000, y: (i * 613 % 1000) / 1000 * 0.7, s: (i % 3) + 1 }));
    this.resize();
  }

  setMatch(info) {
    this.match = info;   // { players:[{id,slot,name,charId,palette}], stageId }
    this.stage = STAGES[info.stageId || 'skyforge'];
    this.vis.clear(); this.parts = []; this.lastDmg = {}; this.hudShake = {};
    this.cam = { x: 0, y: -160, z: 0.55 };
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.cv.clientWidth || window.innerWidth, h = this.cv.clientHeight || window.innerHeight;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    this.dpr = dpr; this.W = w; this.H = h;
  }

  playerInfo(id) { return this.match.players.find(p => p.id === id); }

  // ── events → particles & shake ──
  onEvent(e) {
    const info = e.slot != null ? this.match.players.find(p => p.slot === e.slot) : null;
    const col = info ? fighterColor(info.charId, info.palette) : '#ffe7a8';
    switch (e.t) {
      case 'hit': {
        const strong = Math.min(1, (e.kb || 0) / 160);
        const n = 6 + Math.round(strong * 14);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * (6 + strong * 14);
          this.parts.push({ k: 'spark', x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 14 + strong * 10, max: 14 + strong * 10, c: i % 3 ? '#fff6c8' : '#ffb347', w: 3 + strong * 3 });
        }
        this.parts.push({ k: 'ring', x: e.x, y: e.y, r: 10, vr: 4 + strong * 8, life: 14, max: 14, c: '#ffffff', w: 4 + strong * 6 });
        if (e.armor) this.parts.push({ k: 'ring', x: e.x, y: e.y, r: 20, vr: 3, life: 12, max: 12, c: '#ffd23d', w: 6 });
        this.shake = Math.max(this.shake, 2 + strong * 14);
        if (e.slot != null) this.hudShake[e.slot] = 14;
        if (strong > 0.65) this.flash = Math.max(this.flash, 0.15);
        break;
      }
      case 'shieldHit':
        this.parts.push({ k: 'ring', x: e.x, y: e.y, r: 8, vr: 5, life: 10, max: 10, c: '#9fd8ff', w: 4 });
        break;
      case 'shieldBreak':
        for (let i = 0; i < 16; i++) {
          const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 9;
          this.parts.push({ k: 'shard', x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 3, rot: a, vr: (Math.random() - 0.5) * 0.4, life: 40, max: 40, c: '#9fd8ff', s: 8 + Math.random() * 10 });
        }
        this.shake = 14;
        break;
      case 'ko': {
        const B = this.stage.blast;
        // Big beam from the blast zone toward the stage (like Smash's KO blast)
        const ang = Math.atan2(-120 - e.y, 0 - e.x);
        this.parts.push({ k: 'beam', x: e.x, y: e.y, ang, life: 55, max: 55, c: col });
        for (let i = 0; i < 40; i++) {
          const a = ang + (Math.random() - 0.5) * 1.4, sp = 6 + Math.random() * 26;
          this.parts.push({ k: 'spark', x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 40, max: 40, c: i % 2 ? col : '#fff', w: 6 });
        }
        this.shake = 26; this.flash = 0.35;
        void B;
        break;
      }
      case 'land':
        if ((e.v || 0) > 6) this.dust(e.x, e.y, 4);
        break;
      case 'tech': this.dust(e.x, e.y, 6); this.parts.push({ k: 'ring', x: e.x, y: e.y - 30, r: 10, vr: 4, life: 12, max: 12, c: '#ffffff', w: 3 }); break;
      case 'bounce': this.dust(e.x, e.y, 8); this.shake = Math.max(this.shake, 6); break;
      case 'sfx':
        if (e.name === 'jump') this.dust(e.x, e.y, 3);
        if (e.name === 'djump') this.parts.push({ k: 'ring', x: e.x, y: e.y, r: 6, vr: 3, life: 14, max: 14, c: '#ffffff', w: 3, flat: true });
        if (e.name === 'quake') { this.dust(e.x - 50, e.y, 6); this.dust(e.x + 50, e.y, 6); this.shake = 12; }
        break;
      case 'counter':
        this.parts.push({ k: 'ring', x: e.x, y: e.y, r: 10, vr: 9, life: 16, max: 16, c: '#ffe7a8', w: 8 });
        this.flash = 0.2;
        break;
      case 'reflect': this.parts.push({ k: 'ring', x: e.x, y: e.y, r: 12, vr: 6, life: 12, max: 12, c: '#c9a7ff', w: 5 }); break;
      case 'clank': this.parts.push({ k: 'ring', x: e.x, y: e.y, r: 6, vr: 5, life: 10, max: 10, c: '#ffffff', w: 4 }); break;
      case 'grab': this.parts.push({ k: 'ring', x: e.x, y: e.y, r: 6, vr: 3, life: 8, max: 8, c: '#ffffff', w: 2 }); break;
    }
  }

  dust(x, y, n) {
    for (let i = 0; i < n; i++) {
      const dir = i % 2 ? 1 : -1;
      this.parts.push({ k: 'dust', x: x + dir * 8, y: y - 4, vx: dir * (1.5 + Math.random() * 3), vy: -Math.random() * 1.5, r: 8 + Math.random() * 8, life: 26, max: 26 });
    }
  }

  // ── camera ──
  updateCamera(snap) {
    const S = this.stage;
    // always keep the whole stage in view (like Smash), then grow to include everyone
    let x1 = S.main.x1 - 90, x2 = S.main.x2 + 90, y1 = -400, y2 = S.main.bottom + 30;
    for (const f of snap.F) {
      if (f.s === 'dead' || f.s === 'out') continue;
      const ch = CHARACTERS[this.playerInfo(f.i)?.charId || 'nova'];
      x1 = Math.min(x1, f.x - 120); x2 = Math.max(x2, f.x + 120);
      y1 = Math.min(y1, f.y - ch.h - 110); y2 = Math.max(y2, f.y + 70);
    }
    // keep the camera inside the blast zones
    const B = S.blast;
    x1 = Math.max(x1, B.left + 80); x2 = Math.min(x2, B.right - 80);
    y1 = Math.max(y1, B.top + 60); y2 = Math.min(y2, B.bottom - 60);
    const hudPad = 130;
    const zx = this.W / (x2 - x1), zy = (this.H - hudPad) / (y2 - y1);
    const base = Math.min(this.W / 1500, this.H / 900) * 1.6;
    const tz = clamp(Math.min(zx, zy), base * 0.32, base * 1.05);
    const tx = (x1 + x2) / 2, ty = (y1 + y2) / 2 + hudPad * 0.5 / tz;
    this.cam.x += (tx - this.cam.x) * 0.09;
    this.cam.y += (ty - this.cam.y) * 0.09;
    this.cam.z += (tz - this.cam.z) * 0.06;
  }

  worldToScreen(x, y) {
    return [(x - this.cam.x) * this.cam.z + this.W / 2, (y - this.cam.y) * this.cam.z + this.H / 2];
  }

  // ═════════════════════════════════════════════════════════════
  draw(snap) {
    if (!this.match || !snap) return;
    this.t++;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.updateCamera(snap);

    this.drawBackground(ctx);

    // world transform
    ctx.save();
    const sk = this.shake;
    const sx = (Math.random() - 0.5) * sk, sy = (Math.random() - 0.5) * sk;
    this.shake *= 0.86; if (this.shake < 0.3) this.shake = 0;
    ctx.translate(this.W / 2 + sx, this.H / 2 + sy);
    ctx.scale(this.cam.z, this.cam.z);
    ctx.translate(-this.cam.x, -this.cam.y);

    this.drawStage(ctx);
    this.drawRespawnPlatforms(ctx, snap);
    this.drawProjectiles(ctx, snap);
    // draw grabbed/hit fighters first so attackers appear on top
    const order = [...snap.F].sort((a, b) => (b.s === 'attack') - (a.s === 'attack'));
    for (const f of order) this.drawFighter(ctx, f);
    this.drawParticles(ctx);
    ctx.restore();

    this.drawOffscreen(ctx, snap);
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,248,230,${this.flash})`;
      ctx.fillRect(0, 0, this.W, this.H);
      this.flash *= 0.8; if (this.flash < 0.01) this.flash = 0;
    }
    this.drawHUD(ctx, snap);
    this.drawOverlayText(ctx, snap);
  }

  drawBackground(ctx) {
    const W = this.W, H = this.H;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#120c2e'); g.addColorStop(0.45, '#2b2163'); g.addColorStop(0.78, '#7a3f78'); g.addColorStop(1, '#ff8f6b');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // stars
    ctx.fillStyle = 'rgba(255,240,220,0.7)';
    for (const s of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(this.t * 0.03 + s.x * 40);
      ctx.globalAlpha = 0.25 + tw * 0.5;
      ctx.fillRect(s.x * W, s.y * H, s.s, s.s);
    }
    ctx.globalAlpha = 1;
    // big setting sun
    const sunY = H * 0.86 - (this.cam.y + 160) * 0.05;
    const sg = ctx.createRadialGradient(W * 0.5, sunY, 10, W * 0.5, sunY, H * 0.5);
    sg.addColorStop(0, 'rgba(255,231,168,0.55)'); sg.addColorStop(1, 'rgba(255,143,107,0)');
    ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);
    // parallax floating shapes
    for (const b of this.bgShapes) {
      const px = (b.x - this.cam.x * b.depth) * this.cam.z * 0.6 + W / 2;
      const py = (b.y - this.cam.y * b.depth) * this.cam.z * 0.6 + H / 2;
      const s = b.s * (0.5 + b.depth) * this.cam.z;
      ctx.save();
      ctx.translate(px, py + Math.sin(this.t * 0.01 + b.rot) * 8);
      ctx.rotate(b.rot + this.t * 0.002 * (b.kind % 2 ? 1 : -1));
      ctx.globalAlpha = 0.1 + b.depth * 0.35;
      ctx.fillStyle = b.depth > 0.3 ? '#4a3a8f' : '#3a2d78';
      ctx.beginPath();
      if (b.kind === 0) ctx.arc(0, 0, s, 0, Math.PI * 2);
      else if (b.kind === 1) ctx.rect(-s, -s, s * 2, s * 2);
      else if (b.kind === 2) { ctx.moveTo(0, -s); ctx.lineTo(s, s * 0.8); ctx.lineTo(-s, s * 0.8); ctx.closePath(); }
      else for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; i ? ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s) : ctx.moveTo(Math.cos(a) * s, Math.sin(a) * s); }
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  drawStage(ctx) {
    const m = this.stage.main;
    // island body: solid slab that tapers into a rocky underside
    ctx.save();
    const body = new Path2D();
    body.moveTo(m.x1, m.y);
    body.lineTo(m.x2, m.y);
    body.lineTo(m.x2, m.bottom * 0.55);
    body.lineTo(m.x2 - 60, m.bottom);
    body.lineTo(m.x2 * 0.45, m.bottom + 70);
    body.lineTo(0, m.bottom + 150);
    body.lineTo(m.x1 * 0.45, m.bottom + 70);
    body.lineTo(m.x1 + 60, m.bottom);
    body.lineTo(m.x1, m.bottom * 0.55);
    body.closePath();
    const g = ctx.createLinearGradient(0, m.y, 0, m.bottom + 150);
    g.addColorStop(0, '#4b3a8a'); g.addColorStop(0.5, '#2c2160'); g.addColorStop(1, '#1a1238');
    ctx.fillStyle = g; ctx.fill(body);
    ctx.lineWidth = 4; ctx.strokeStyle = '#120c2e'; ctx.stroke(body);
    // geometric facets on the underside
    ctx.clip(body);
    ctx.strokeStyle = 'rgba(255,231,168,0.08)'; ctx.lineWidth = 3;
    for (let i = -6; i <= 6; i++) {
      ctx.beginPath(); ctx.moveTo(i * 80, m.y + 20); ctx.lineTo(i * 40, m.bottom + 160); ctx.stroke();
    }
    // glowing core
    const cg = ctx.createRadialGradient(0, m.bottom * 0.9, 4, 0, m.bottom * 0.9, 120);
    cg.addColorStop(0, 'rgba(255,170,110,0.75)'); cg.addColorStop(1, 'rgba(255,170,110,0)');
    ctx.fillStyle = cg; ctx.fillRect(-140, m.bottom * 0.9 - 130, 280, 260);
    ctx.restore();
    // top surface
    ctx.fillStyle = '#ffe7a8';
    ctx.fillRect(m.x1, m.y - 3, m.x2 - m.x1, 9);
    ctx.fillStyle = '#ff8f6b';
    ctx.fillRect(m.x1, m.y + 6, m.x2 - m.x1, 5);
    // ledge caps
    for (const L of this.stage.ledges) {
      ctx.fillStyle = '#ffe7a8';
      ctx.beginPath(); ctx.arc(L.x, L.y + 1, 7, 0, Math.PI * 2); ctx.fill();
    }
    // soft platforms
    for (const p of this.stage.platforms) {
      ctx.fillStyle = 'rgba(255,231,168,0.16)';
      ctx.fillRect(p.x1, p.y, p.x2 - p.x1, 16);
      ctx.fillStyle = '#ffe7a8';
      ctx.fillRect(p.x1, p.y - 2, p.x2 - p.x1, 5);
      ctx.fillStyle = 'rgba(255,143,107,0.6)';
      ctx.fillRect(p.x1 + 6, p.y + 16, p.x2 - p.x1 - 12, 3);
    }
  }

  drawRespawnPlatforms(ctx, snap) {
    for (const f of snap.F) {
      if (f.s !== 'respawn') continue;
      const life = 1 - Math.min(1, f.sf / 240);
      ctx.save();
      ctx.globalAlpha = 0.6 + 0.4 * life;
      const g = ctx.createLinearGradient(f.x - 50, 0, f.x + 50, 0);
      g.addColorStop(0, 'rgba(255,231,168,0)'); g.addColorStop(0.5, '#ffe7a8'); g.addColorStop(1, 'rgba(255,231,168,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(f.x, f.y + 4, 56 * (0.6 + 0.4 * life), 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  drawProjectiles(ctx, snap) {
    for (const p of snap.P) {
      const info = this.match.players.find(q => q.slot === p.o);
      const col = info ? fighterColor(info.charId, info.palette) : '#fff';
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.shadowColor = col; ctx.shadowBlur = 18;
      if (p.k === 'bolt') {
        ctx.rotate(Math.atan2(p.vy, p.vx));
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.moveTo(p.r * 1.8, 0); ctx.lineTo(0, -p.r * 0.8); ctx.lineTo(-p.r * 1.4, 0); ctx.lineTo(0, p.r * 0.8); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.stroke();
        ctx.globalAlpha = 0.4; ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(-p.r * 1.2, -p.r * 0.5); ctx.lineTo(-p.r * 4, 0); ctx.lineTo(-p.r * 1.2, p.r * 0.5); ctx.fill();
      } else if (p.k === 'boomer') {
        ctx.rotate(this.t * 0.4);
        ctx.fillStyle = col; ctx.strokeStyle = '#1a1238'; ctx.lineWidth = 3;
        ctx.beginPath(); for (let i = 0; i < 3; i++) { const a = i * 2.094; i ? ctx.lineTo(Math.cos(a) * p.r * 1.3, Math.sin(a) * p.r * 1.3) : ctx.moveTo(Math.cos(a) * p.r * 1.3, Math.sin(a) * p.r * 1.3); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      } else if (p.k === 'star') {
        ctx.rotate(this.t * 0.25);
        ctx.fillStyle = '#fff3b0'; ctx.strokeStyle = col; ctx.lineWidth = 3;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5, r = i % 2 ? p.r * 0.5 : p.r * 1.25; i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawFighter(ctx, f) {
    if (f.s === 'dead' || f.s === 'out') return;
    const info = this.playerInfo(f.i);
    if (!info) return;
    const ch = CHARACTERS[info.charId];
    if (!this.vis.has(f.i)) this.vis.set(f.i, newVis(ch, f.i * 13));
    const vis = this.vis.get(f.i);
    const pose = computePose(f, ch, vis, this.t);
    springVis(vis, pose, f.s === 'attack' || f.s === 'tumble' || ['roll', 'getupRoll', 'ledgeRoll'].includes(f.s));
    if (vis.prevState !== f.s && ['tumble', 'roll', 'getupRoll', 'ledgeRoll'].includes(f.s)) vis.rot = pose.rot;
    if (f.s === 'air' && f.dj < 20) vis.rot = pose.rot;
    if (f.s === 'attack') {
      const m = ch.moves[f.m];
      if (m && m.spin && f.mt >= m.spin[0] && f.mt <= m.spin[1]) vis.rot = pose.rot;
    }
    vis.prevState = f.s;
    const color = fighterColor(info.charId, info.palette);

    // knockback smoke trail
    const spd = Math.hypot(f.vx, f.vy);
    if (f.hs && spd > 9 && this.t % 2 === 0) {
      this.parts.push({ k: 'smoke', x: f.x, y: f.y - ch.h / 2, vx: 0, vy: -0.3, r: 10 + spd * 0.6, life: 30, max: 30 });
    }

    // shadow on the ground below
    ctx.save();
    ctx.fillStyle = 'rgba(10,6,30,0.35)';
    const ground = this.groundBelow(f.x, f.y);
    if (ground !== null) {
      const d = ground - f.y, s = clamp(1 - d / 400, 0.2, 1);
      ctx.beginPath(); ctx.ellipse(f.x, ground + 2, ch.w * 0.55 * s, 6 * s, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // attack trail: remember where the active limb was
    if (f.s === 'attack' && vis.activeLimb) {
      const l = vis.limbs[vis.activeLimb];
      vis.trail.push({ x: f.x + l.x * f.fa, y: f.y + l.y, a: 1 });
    }
    vis.activeLimb = null;
    if (vis.trail.length) {
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 1; i < vis.trail.length; i++) {
        const a = vis.trail[i - 1], b = vis.trail[i];
        ctx.strokeStyle = `rgba(255,248,220,${b.a * 0.75})`;
        ctx.lineWidth = 18 * b.a;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
      for (const p of vis.trail) p.a -= 0.18;
      vis.trail = vis.trail.filter(p => p.a > 0);
    }

    ctx.save();
    ctx.translate(f.x, f.y);
    drawFighterBody(ctx, ch, color, vis, pose, f.fa, this.t, '#1a1238');

    // shield bubble
    if (f.s === 'shield' || f.s === 'shieldstun') {
      const r = (ch.h * 0.36 + 18) * (0.35 + 0.65 * f.sh / 50);
      ctx.save();
      ctx.globalAlpha = 0.45;
      const sg = ctx.createRadialGradient(0, -ch.h * 0.5, r * 0.2, 0, -ch.h * 0.5, r);
      sg.addColorStop(0, 'rgba(255,255,255,0.15)'); sg.addColorStop(1, SLOT_COLORS[info.slot]);
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(0, -ch.h * 0.5, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.9; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }
    // reflector
    if (f.s === 'attack' && ch.moves[f.m]?.reflect) {
      const [r0, r1, rx, ry, rr] = ch.moves[f.m].reflect;
      if (f.mt >= r0 && f.mt <= r1) {
        ctx.save(); ctx.translate(rx * f.fa, ry); ctx.rotate(this.t * 0.05);
        ctx.strokeStyle = '#e6d4ff'; ctx.lineWidth = 4; ctx.globalAlpha = 0.85;
        ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; i ? ctx.lineTo(Math.cos(a) * rr * 0.8, Math.sin(a) * rr * 0.8) : ctx.moveTo(Math.cos(a) * rr * 0.8, Math.sin(a) * rr * 0.8); }
        ctx.closePath(); ctx.stroke(); ctx.fillStyle = 'rgba(200,170,255,0.2)'; ctx.fill();
        ctx.restore();
      }
    }
    // dizzy stars
    if (f.s === 'dizzy') {
      for (let i = 0; i < 3; i++) {
        const a = this.t * 0.1 + i * 2.094;
        ctx.fillStyle = '#ffe7a8';
        ctx.beginPath(); ctx.arc(Math.cos(a) * ch.w * 0.5, -ch.h - 10 + Math.sin(a) * 6, 5, 0, Math.PI * 2); ctx.fill();
      }
    }
    // player tag above head
    if (!info.dummy) {
      const ty = -ch.h - 26 + (f.s === 'ledge' ? -10 : 0);
      ctx.fillStyle = SLOT_COLORS[info.slot];
      ctx.beginPath(); ctx.moveTo(-7, ty); ctx.lineTo(7, ty); ctx.lineTo(0, ty + 9); ctx.closePath(); ctx.fill();
      ctx.font = `16px ${FONT_DISPLAY}`; ctx.textAlign = 'center';
      ctx.lineWidth = 4; ctx.strokeStyle = '#1a1238';
      ctx.strokeText(SLOT_NAMES[info.slot], 0, ty - 4);
      ctx.fillText(SLOT_NAMES[info.slot], 0, ty - 4);
    }
    ctx.restore();
  }

  groundBelow(x, y) {
    const S = this.stage;
    let best = null;
    for (const s of [S.main, ...S.platforms]) {
      if (x >= s.x1 && x <= s.x2 && s.y >= y - 1 && (best === null || s.y < best)) best = s.y;
    }
    return best;
  }

  drawParticles(ctx) {
    const keep = [];
    for (const p of this.parts) {
      p.life--;
      if (p.life <= 0) continue;
      keep.push(p);
      const a = p.life / p.max;
      ctx.save();
      switch (p.k) {
        case 'spark':
          p.x += p.vx; p.y += p.vy; p.vx *= 0.88; p.vy *= 0.88;
          ctx.strokeStyle = p.c; ctx.globalAlpha = a; ctx.lineWidth = p.w * a + 1; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2); ctx.stroke();
          break;
        case 'ring':
          p.r += p.vr; p.vr *= 0.88;
          ctx.strokeStyle = p.c; ctx.globalAlpha = a; ctx.lineWidth = p.w * a + 0.5;
          ctx.beginPath();
          if (p.flat) ctx.ellipse(p.x, p.y, p.r * 1.6, p.r * 0.4, 0, 0, Math.PI * 2); else ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'dust': case 'smoke':
          p.x += p.vx; p.y += p.vy; p.vx *= 0.92; p.r *= 1.02;
          ctx.fillStyle = p.k === 'dust' ? 'rgba(255,231,200,1)' : 'rgba(230,220,255,1)';
          ctx.globalAlpha = a * (p.k === 'dust' ? 0.45 : 0.3);
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
          break;
        case 'shard':
          p.x += p.vx; p.y += p.vy; p.vy += 0.4; p.rot += p.vr;
          ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = a; ctx.fillStyle = p.c;
          ctx.beginPath(); ctx.moveTo(0, -p.s); ctx.lineTo(p.s * 0.5, p.s * 0.6); ctx.lineTo(-p.s * 0.5, p.s * 0.6); ctx.closePath(); ctx.fill();
          break;
        case 'beam': {
          ctx.translate(p.x, p.y); ctx.rotate(p.ang);
          const len = 2200, wid = 260 * a + 40;
          const g = ctx.createLinearGradient(0, 0, len, 0);
          g.addColorStop(0, '#ffffff'); g.addColorStop(0.15, p.c); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = a * 0.9; ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, -wid); ctx.lineTo(len, wid); ctx.closePath(); ctx.fill();
          break;
        }
      }
      ctx.restore();
    }
    this.parts = keep.length > 600 ? keep.slice(-600) : keep;
  }

  // Magnifier bubbles for fighters outside the view (Smash does this too)
  drawOffscreen(ctx, snap) {
    for (const f of snap.F) {
      if (f.s === 'dead' || f.s === 'out') continue;
      const info = this.playerInfo(f.i); if (!info) continue;
      const ch = CHARACTERS[info.charId];
      const [sx, sy] = this.worldToScreen(f.x, f.y - ch.h / 2);
      const m = 30;
      if (sx > -m && sx < this.W + m && sy > -m && sy < this.H + m) continue;
      const bx = clamp(sx, 50, this.W - 50);
      let by = clamp(sy, 50, this.H - 170);
      if (bx > this.W - 200 && by < 100) by = 100;   // keep clear of the Menu button
      ctx.save();
      ctx.fillStyle = 'rgba(18,12,46,0.85)'; ctx.strokeStyle = SLOT_COLORS[info.slot]; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(bx, by, 38, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(bx, by, 36, 0, Math.PI * 2); ctx.clip();
      const vis = this.vis.get(f.i);
      if (vis) {
        ctx.translate(bx, by + ch.h * 0.25); ctx.scale(0.5, 0.5);
        drawFighterBody(ctx, ch, fighterColor(info.charId, info.palette), vis, { alpha: 1, glow: 0, bodyDx: 0, bodyDy: 0, shakeX: 0, flash: 0, eyes: f.hs ? 'hurt' : 'normal' }, f.fa, this.t, '#1a1238');
      }
      ctx.restore();
    }
  }

  drawHUD(ctx, snap) {
    const players = this.match.players;
    const n = players.length;
    const cw = Math.min(230, (this.W - 40) / Math.max(n, 1) - 14), chh = 84;
    const total = n * cw + (n - 1) * 14;
    let x = (this.W - total) / 2;
    const y = this.H - chh - 16;
    for (const p of players) {
      const f = snap.F.find(q => q.i === p.id);
      if (!f) continue;
      const out = f.s === 'out';
      const col = fighterColor(p.charId, p.palette);
      ctx.save();
      let shx = 0, shy = 0;
      if (this.hudShake[p.slot] > 0) { shx = (Math.random() - 0.5) * this.hudShake[p.slot]; shy = (Math.random() - 0.5) * this.hudShake[p.slot]; this.hudShake[p.slot] *= 0.8; if (this.hudShake[p.slot] < 0.5) this.hudShake[p.slot] = 0; }
      ctx.translate(x, y);
      ctx.globalAlpha = out ? 0.45 : 1;
      // hard offset shadow + slab
      ctx.fillStyle = '#0c0820';
      ctx.beginPath(); ctx.roundRect(5, 6, cw, chh, 10); ctx.fill();
      ctx.fillStyle = 'rgba(30,22,72,0.92)';
      ctx.beginPath(); ctx.roundRect(0, 0, cw, chh, 10); ctx.fill();
      ctx.fillStyle = SLOT_COLORS[p.slot];
      ctx.beginPath(); ctx.roundRect(0, 0, 8, chh, [10, 0, 0, 10]); ctx.fill();
      // portrait
      ctx.save();
      ctx.beginPath(); ctx.roundRect(14, 10, 58, 64, 8); ctx.fillStyle = shade(col, -0.55); ctx.fill(); ctx.clip();
      const pch = CHARACTERS[p.charId];
      drawFighterPreview(ctx, p.charId, p.palette, 43, 10 + 58, 48 / pch.h, this.t, 1);
      ctx.restore();
      // name
      ctx.fillStyle = '#f4f0ff'; ctx.font = `600 13px ${FONT_UI}`; ctx.textAlign = 'left';
      ctx.fillText(p.name.slice(0, 14), 82, 22);
      // damage %
      const dmg = Math.floor(f.d);
      ctx.font = `38px ${FONT_DISPLAY}`;
      ctx.lineWidth = 6; ctx.strokeStyle = '#120c2e';
      const label = out ? '—' : dmg + '%';
      ctx.strokeText(label, 82 + shx, 62 + shy);
      ctx.fillStyle = out ? '#9a90c0' : damageColor(f.d);
      ctx.fillText(label, 82 + shx, 62 + shy);
      // stocks
      for (let i = 0; i < f.st; i++) {
        ctx.fillStyle = col; ctx.strokeStyle = '#120c2e'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cw - 16 - i * 16, 18, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
      x += cw + 14;
    }
  }

  drawOverlayText(ctx, snap) {
    let text = null, size = 140, col = '#ffe7a8';
    if (snap.ph === 'countdown') {
      const left = RULES.countdownFrames - snap.f;
      text = String(Math.max(1, Math.ceil(left / 60)));
      const k = 1 - (left % 60) / 60;
      size = 120 + 80 * (1 - k);
    } else if (snap.ph === 'play' && snap.f < RULES.countdownFrames + 45) {
      text = 'GO!'; size = 170; col = '#ffffff';
    } else if (snap.ph === 'over') {
      text = 'GAME!'; size = 170 + Math.min(1, snap.ov / 20) * 20; col = '#ffffff';
    }
    if (!text) return;
    const scale = Math.min(1, this.W / 900);
    ctx.save();
    ctx.translate(this.W / 2, this.H * 0.42);
    ctx.font = `${size * scale}px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 18 * scale; ctx.strokeStyle = '#120c2e';
    ctx.strokeText(text, 6, 8);
    ctx.lineWidth = 14 * scale; ctx.strokeStyle = '#ff8f6b';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = col;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}
