// lib/audio.js — tiny WebAudio synth: the bag thump + chain clinks (SPEC §6.4) and a drum / pad kit.
// No three.js import, no samples.
//
// The AudioContext is created and resumed ONLY inside unlock(), which main.js calls from real user
// gestures (pointerdown / keydown). Every sound function is a silent no-op until then, so programmatic
// calls (e.g. window.__room.hitBag) never trigger an autoplay warning.
//
// API (also available as the default export / ctx.audio):
//   unlock() -> boolean            create/resume the context; call from a user-gesture handler
//   isReady() -> boolean           context running and not muted
//   isMuted() / setMuted(bool) / toggleMute() -> boolean
//   onMuteChange(fn) -> unsubscribe  fn(muted) is called on every change
//   thump(strength = 1)            bag impact: lowpassed noise burst + 70→45 Hz sine
//   clinks(strength = 1)           2–3 quiet chain clinks, 30–90 ms later
//   bagHit(strength = 1)           thump + clinks
//   hit(kind, velocity = 0.8)      drum synth; kind ∈ KINDS: kick snare hat tom1 tom2 floor crash ride pad0..pad7,
//                                  plus the booth instruments: tabla-na tabla-tin tabla-ge (dayan rim / open dayan /
//                                  bayan bass with a little pitch bend), guitar (acoustic strum), eguitar (electric,
//                                  lightly driven), and ep<midi> (electric piano note, e.g. "ep62"; midi 24..108)
//   KINDS                          string[] (the fixed kinds; ep<midi> is a pattern)

import { createRng, SEED } from "./rng.js";

const MASTER = 0.5;
const STORE_KEY = "room.muted";

export const KINDS = [
  "kick", "snare", "hat", "tom1", "tom2", "floor", "crash", "ride", "pad0", "pad1", "pad2", "pad3", "pad4", "pad5", "pad6", "pad7",
  "tabla-na", "tabla-tin", "tabla-ge", "guitar", "eguitar",
];

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
// Strums, low string first. Dm9 for the acoustic (sits with the D minor pentatonic pads), a Dm voicing for the electric.
const STRUM_ACOUSTIC = [50, 57, 60, 64, 65, 69].map(midiHz);
const STRUM_ELECTRIC = [50, 57, 62, 65].map(midiHz);
const DAYAN_HZ = 293.66; // dayan tuned to D4

// D minor pentatonic, D4 → G5: any two pads sound fine together.
const PAD_HZ = [293.66, 349.23, 392.0, 440.0, 523.25, 587.33, 698.46, 783.99];

const rng = createRng(SEED).fork("audio");
const listeners = new Set();

let ac = null;
let master = null;
let noiseBuffer = null;
let driveCurve = null; // soft-clip curve for the electric guitar, built once in unlock()
let muted = false;
try {
  muted = localStorage.getItem(STORE_KEY) === "1";
} catch {
  /* storage unavailable: start unmuted */
}

/** Create / resume the AudioContext. Call only from a user-gesture handler. Returns false if unsupported. */
export function unlock() {
  if (!ac) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    try {
      ac = new Ctor({ latencyHint: "interactive" });
    } catch {
      ac = null;
      return false;
    }
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master = ac.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(limiter).connect(ac.destination);

    const length = ac.sampleRate; // 1 s of white noise, shared by every voice
    noiseBuffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    const noiseRng = createRng(SEED).fork("audio-noise");
    for (let i = 0; i < length; i++) data[i] = noiseRng() * 2 - 1;
    driveCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      driveCurve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
    }
  }
  if (ac.state === "suspended") ac.resume().catch(() => {});
  return true;
}

/** True when sounds will actually be heard. */
export const isReady = () => !!ac && ac.state === "running" && !muted;

export const isMuted = () => muted;

export function setMuted(value) {
  muted = !!value;
  try {
    localStorage.setItem(STORE_KEY, muted ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER, ac.currentTime, 0.015);
  for (const fn of listeners) fn(muted);
  return muted;
}

export const toggleMute = () => setMuted(!muted);

/** Subscribe to mute changes. Returns an unsubscribe function. */
export function onMuteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- voices ---------------------------------------------------------------------------------------

const live = () => !!ac && !muted && ac.state === "running";

// Exponential pluck envelope on a fresh gain node.
function envelope(t, peak, attack, decay, dest) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest || master);
  return g;
}

// Oscillator with an optional pitch drop from f0 to f1 over `sweep` seconds.
function tone(t, type, f0, f1, sweep, peak, decay, attack = 0.002, dest) {
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  osc.connect(envelope(t, peak, attack, decay, dest));
  osc.start(t);
  osc.stop(t + attack + decay + 0.03);
}

// Filtered noise burst.
function burst(t, filterType, freq, q, peak, decay, attack = 0.001, dest) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const filter = ac.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.value = freq;
  filter.Q.value = q;
  src.connect(filter).connect(envelope(t, peak, attack, decay, dest));
  src.start(t, rng() * 0.8);
  src.stop(t + attack + decay + 0.03);
}

// Inharmonic partials through a highpass: the metallic part of a cymbal.
function metal(t, freqs, type, peak, decay, highpass) {
  const filter = ac.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = highpass;
  const env = envelope(t, peak, 0.001, decay);
  filter.connect(env);
  for (const f of freqs) {
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.value = f;
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}

// One plucked string: two slightly detuned oscillators through a lowpass whose cutoff falls (bright attack,
// mellow ring), then an exponential envelope. `drive` routes it through the soft clipper first.
function pluck(t, f, peak, decay, bright, type, drive) {
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(bright, t);
  filter.frequency.exponentialRampToValueAtTime(Math.max(f * 1.5, 380), t + decay * 0.45);
  const env = envelope(t, peak, 0.003, decay);
  if (drive && driveCurve) {
    const shaper = ac.createWaveShaper();
    shaper.curve = driveCurve;
    filter.connect(shaper).connect(env);
  } else filter.connect(env);
  for (const [ty, det, g] of [[type, -4, 0.6], ["triangle", 5, 0.5]]) {
    const osc = ac.createOscillator();
    osc.type = ty;
    osc.frequency.value = f;
    osc.detune.value = det;
    const og = ac.createGain();
    og.gain.value = g;
    osc.connect(og).connect(filter);
    osc.start(t);
    osc.stop(t + decay + 0.06);
  }
}

// Two-operator FM electric piano: sine carrier, sine modulator at 1:1 whose index decays (bark -> mellow),
// plus a quiet, quickly decaying 14:1 "tine" partial.
function epiano(t, f, v) {
  const decay = Math.max(0.8, 2.2 - (f / 1000) * 1.2);
  const env = envelope(t, 0.42 * v, 0.004, decay);
  const car = ac.createOscillator();
  car.type = "sine";
  car.frequency.value = f;
  const mod = ac.createOscillator();
  mod.type = "sine";
  mod.frequency.value = f;
  const idx = ac.createGain();
  idx.gain.setValueAtTime(f * (1.4 + 1.6 * v), t);
  idx.gain.exponentialRampToValueAtTime(f * 0.18, t + 0.7);
  mod.connect(idx).connect(car.frequency);
  car.connect(env);
  car.start(t);
  mod.start(t);
  car.stop(t + decay + 0.06);
  mod.stop(t + decay + 0.06);
  tone(t, "sine", f * 14, f * 14, 0, 0.035 * v, 0.06, 0.001);
}

/** Bag impact. Gain follows the impulse strength (≈ 0..2). */
export function thump(strength = 1) {
  if (!live()) return;
  const t = ac.currentTime;
  const g = Math.min(1.4, Math.max(0.05, strength));
  burst(t, "lowpass", 180, 0.7, 0.9 * g, 0.12);
  tone(t, "sine", 70, 45, 0.15, 0.95 * g, 0.2);
}

/** 2–3 quiet chain clinks, 30–90 ms after the hit. */
export function clinks(strength = 1) {
  if (!live()) return;
  const t = ac.currentTime;
  const g = Math.min(1.4, Math.max(0.05, strength));
  const count = rng.int(2, 3);
  for (let i = 0; i < count; i++) {
    burst(t + rng.float(0.03, 0.09), "highpass", rng.float(3000, 5000), 2.5, rng.float(0.04, 0.09) * g, rng.float(0.012, 0.03), 0.0005);
  }
}

/** Thump + clinks: what objects/bag.js calls on every registered hit. */
export function bagHit(strength = 1) {
  thump(strength);
  clinks(strength);
}

/**
 * Drum / pad synth. Short, soft, synthesized; overlapping hits are fine.
 * @param {string} kind  one of KINDS
 * @param {number} [velocity=0.8]  0..1
 * @returns {boolean} false if the kind is unknown or audio is not running / muted
 */
export function hit(kind, velocity = 0.8) {
  if (!live()) return false;
  const t = ac.currentTime;
  const v = Math.min(1.2, Math.max(0.05, velocity));
  switch (kind) {
    case "kick":
      tone(t, "sine", 150, 48, 0.09, 1.0 * v, 0.32);
      tone(t, "triangle", 320, 80, 0.03, 0.22 * v, 0.05);
      burst(t, "lowpass", 2400, 0.7, 0.14 * v, 0.02);
      break;
    case "snare":
      tone(t, "triangle", 215, 178, 0.05, 0.5 * v, 0.12);
      tone(t, "sine", 335, 285, 0.04, 0.18 * v, 0.08);
      burst(t, "highpass", 1800, 0.7, 0.5 * v, 0.17);
      burst(t, "bandpass", 5200, 0.8, 0.22 * v, 0.09);
      break;
    case "hat":
      burst(t, "highpass", 7500, 0.8, 0.3 * v, 0.045);
      burst(t, "bandpass", 10500, 1.2, 0.18 * v, 0.03);
      metal(t, [5230, 6790, 8120], "square", 0.03 * v, 0.04, 6000);
      break;
    case "tom1":
      tone(t, "sine", 262, 172, 0.08, 0.8 * v, 0.28);
      burst(t, "bandpass", 900, 1, 0.12 * v, 0.03);
      break;
    case "tom2":
      tone(t, "sine", 212, 136, 0.09, 0.82 * v, 0.34);
      burst(t, "bandpass", 760, 1, 0.12 * v, 0.03);
      break;
    case "floor":
      tone(t, "sine", 150, 88, 0.11, 0.9 * v, 0.5);
      burst(t, "bandpass", 520, 1, 0.12 * v, 0.04);
      break;
    case "crash":
      burst(t, "highpass", 4200, 0.6, 0.34 * v, 1.3);
      burst(t, "bandpass", 7800, 0.7, 0.24 * v, 0.9);
      metal(t, [2051, 3187, 4127, 5437, 6791], "square", 0.045 * v, 1.0, 3500);
      break;
    case "ride":
      metal(t, [3120, 4670, 5890, 7430], "triangle", 0.11 * v, 0.75, 2500);
      tone(t, "triangle", 920, 900, 0.1, 0.1 * v, 0.14);
      burst(t, "bandpass", 9000, 0.9, 0.08 * v, 0.28);
      break;
    case "tabla-na": {
      // rim stroke on the dayan: bright, ringing, nearly harmonic partials (the syahi), a crisp click
      const f = DAYAN_HZ;
      tone(t, "sine", f * 1.02, f, 0.03, 0.42 * v, 0.55, 0.001);
      tone(t, "sine", f * 2, f * 2, 0, 0.26 * v, 0.38, 0.001);
      tone(t, "sine", f * 3, f * 3, 0, 0.14 * v, 0.24, 0.001);
      tone(t, "sine", f * 4.02, f * 4.02, 0, 0.06 * v, 0.12, 0.001);
      burst(t, "bandpass", 3200, 1.4, 0.16 * v, 0.018, 0.0005);
      break;
    }
    case "tabla-tin": {
      // open stroke nearer the syahi: rounder, the 2nd and 3rd partials ring longer
      const f = DAYAN_HZ;
      tone(t, "sine", f, f, 0, 0.3 * v, 0.7, 0.002);
      tone(t, "sine", f * 2, f * 2, 0, 0.3 * v, 0.85, 0.002);
      tone(t, "sine", f * 3, f * 3, 0, 0.12 * v, 0.5, 0.002);
      burst(t, "bandpass", 1800, 1.2, 0.08 * v, 0.02, 0.0008);
      break;
    }
    case "tabla-ge": {
      // open bayan stroke: deep, with the wrist's pitch glide upward, and a soft palm thud
      const osc = ac.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(82, t);
      osc.frequency.exponentialRampToValueAtTime(112, t + 0.28);
      osc.frequency.exponentialRampToValueAtTime(104, t + 0.8);
      osc.connect(envelope(t, 0.95 * v, 0.004, 0.85));
      osc.start(t);
      osc.stop(t + 0.92);
      tone(t, "sine", 165, 210, 0.3, 0.12 * v, 0.4, 0.004);
      burst(t, "lowpass", 420, 0.8, 0.22 * v, 0.05);
      break;
    }
    case "guitar":
      STRUM_ACOUSTIC.forEach((f, i) => pluck(t + i * 0.018, f, (0.16 - i * 0.01) * v, 2.1 - i * 0.12, 2600 + 1400 * v, "sawtooth", false));
      burst(t, "bandpass", 180, 1.2, 0.12 * v, 0.06); // body knock
      break;
    case "eguitar":
      STRUM_ELECTRIC.forEach((f, i) => pluck(t + i * 0.012, f, 0.2 * v, 1.6, 1500 + 900 * v, "sawtooth", true));
      break;
    default: {
      const e = /^ep(\d{2,3})$/.exec(kind);
      if (e) {
        const midi = +e[1];
        if (midi < 24 || midi > 108) return false;
        epiano(t, midiHz(midi), v);
        break;
      }
      const m = /^pad([0-7])$/.exec(kind);
      if (!m) return false;
      const f = PAD_HZ[+m[1]];
      tone(t, "sine", f, f, 0, 0.5 * v, 0.6, 0.003); // soft mallet: fundamental…
      tone(t, "triangle", f * 2, f * 2, 0, 0.07 * v, 0.22, 0.003); // …a little body…
      tone(t, "sine", f * 4, f * 4, 0, 0.11 * v, 0.08, 0.001); // …and the strike
    }
  }
  return true;
}

const audio = { unlock, isReady, isMuted, setMuted, toggleMute, onMuteChange, thump, clinks, bagHit, hit, KINDS };
export default audio;
