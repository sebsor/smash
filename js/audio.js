// ─────────────────────────────────────────────────────────────
// audio.js — every sound is synthesized with the Web Audio API.
// No audio files to download or license: a "hit" is a burst of
// filtered noise plus a falling low tone; bigger hits = longer & lower.
// Browsers only allow audio after a user gesture, so unlock() is
// called on the first click/keypress.
// ─────────────────────────────────────────────────────────────

let ac = null, master = null, noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem('ss-muted') === '1'; } catch { /* storage blocked */ }

export function unlock() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ac = new AC();
  master = ac.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ac.destination);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

export function toggleMute() {
  muted = !muted;
  try { localStorage.setItem('ss-muted', muted ? '1' : '0'); } catch { /* ignore */ }
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}
export const isMuted = () => muted;

function tone({ f0, f1 = f0, dur = 0.15, type = 'sine', vol = 0.3, delay = 0 }) {
  if (!ac) return;
  const t = ac.currentTime + delay;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise({ dur = 0.12, vol = 0.3, freq = 1500, q = 1, type = 'bandpass', delay = 0 }) {
  if (!ac) return;
  const t = ac.currentTime + delay;
  const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  s.buffer = noiseBuf;
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(master);
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
}

export function play(name, opt = {}) {
  if (!ac || muted) return;
  switch (name) {
    case 'hit': {
      const k = Math.min(1, (opt.kb || 30) / 170);
      noise({ dur: 0.06 + k * 0.18, vol: 0.25 + k * 0.3, freq: 2400 - k * 1500, q: 0.8 });
      tone({ f0: 220 - k * 120, f1: 50, dur: 0.1 + k * 0.25, type: 'triangle', vol: 0.35 + k * 0.25 });
      if (k > 0.75) tone({ f0: 1400, f1: 300, dur: 0.35, type: 'sawtooth', vol: 0.06 });
      break;
    }
    case 'shieldHit': tone({ f0: 900, f1: 600, dur: 0.08, type: 'square', vol: 0.08 }); noise({ dur: 0.05, vol: 0.1, freq: 4000 }); break;
    case 'shieldBreak': tone({ f0: 1200, f1: 200, dur: 0.6, type: 'square', vol: 0.12 }); noise({ dur: 0.4, vol: 0.3, freq: 3000 }); break;
    case 'ko':
      noise({ dur: 0.9, vol: 0.5, freq: 400, q: 0.5, type: 'lowpass' });
      tone({ f0: 160, f1: 30, dur: 0.9, type: 'sawtooth', vol: 0.3 });
      tone({ f0: 1800, f1: 200, dur: 0.5, type: 'sine', vol: 0.12, delay: 0.05 });
      break;
    case 'jump': tone({ f0: 300, f1: 600, dur: 0.09, type: 'sine', vol: 0.08 }); break;
    case 'djump': tone({ f0: 450, f1: 900, dur: 0.1, type: 'triangle', vol: 0.08 }); break;
    case 'swing': noise({ dur: 0.08, vol: 0.06, freq: 2000, q: 2 }); break;
    case 'shoot': tone({ f0: 900, f1: 1500, dur: 0.12, type: 'square', vol: 0.05 }); break;
    case 'grab': noise({ dur: 0.05, vol: 0.15, freq: 900 }); break;
    case 'land': noise({ dur: 0.05, vol: 0.06, freq: 500, type: 'lowpass' }); break;
    case 'thud': noise({ dur: 0.12, vol: 0.2, freq: 300, type: 'lowpass' }); break;
    case 'tech': tone({ f0: 1300, f1: 1600, dur: 0.06, type: 'sine', vol: 0.12 }); break;
    case 'counter': tone({ f0: 600, f1: 1800, dur: 0.25, type: 'triangle', vol: 0.18 }); break;
    case 'reflect': tone({ f0: 1500, f1: 2500, dur: 0.12, type: 'sine', vol: 0.12 }); break;
    case 'quake': tone({ f0: 90, f1: 30, dur: 0.5, type: 'sawtooth', vol: 0.3 }); noise({ dur: 0.4, vol: 0.4, freq: 200, type: 'lowpass' }); break;
    case 'count': tone({ f0: 660, dur: 0.16, type: 'square', vol: 0.08 }); break;
    case 'go': tone({ f0: 880, dur: 0.35, type: 'square', vol: 0.1 }); tone({ f0: 1320, dur: 0.35, type: 'square', vol: 0.06 }); break;
    case 'game': [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.3, type: 'square', vol: 0.07, delay: i * 0.09 })); break;
    case 'ui': tone({ f0: 700, f1: 900, dur: 0.05, type: 'triangle', vol: 0.06 }); break;
    case 'uiBack': tone({ f0: 500, f1: 350, dur: 0.06, type: 'triangle', vol: 0.06 }); break;
    case 'join': tone({ f0: 520, f1: 780, dur: 0.12, type: 'triangle', vol: 0.1 }); tone({ f0: 780, f1: 1040, dur: 0.12, type: 'triangle', vol: 0.08, delay: 0.1 }); break;
  }
}

// Map simulation events to sounds.
export function onEvent(e) {
  switch (e.t) {
    case 'hit': play('hit', { kb: e.kb }); break;
    case 'shieldHit': play('shieldHit'); break;
    case 'shieldBreak': play('shieldBreak'); break;
    case 'ko': play('ko'); break;
    case 'grab': play('grab'); break;
    case 'tech': play('tech'); break;
    case 'counter': play('counter'); break;
    case 'reflect': play('reflect'); break;
    case 'bounce': play('thud'); break;
    case 'land': if ((e.v || 0) > 6) play('land'); break;
    case 'go': play('go'); break;
    case 'game': play('game'); break;
    case 'sfx': play(e.name); break;
  }
}
