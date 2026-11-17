// lib/rng.js — seeded PRNG (mulberry32, seed 42). Every "random" value in the room goes through this,
// so the scene is identical on every load. No three.js import.

export const SEED = 42;

/** Raw mulberry32: returns a function yielding floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a over the label, mixed with the parent seed: fork() streams depend only on (seed, label),
// never on how many numbers the parent has already produced.
function hashLabel(seed, label) {
  let h = (2166136261 ^ seed) >>> 0;
  const s = String(label);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return h >>> 0;
}

/**
 * @typedef {(() => number) & {
 *   seed: number,
 *   float: (min?: number, max?: number) => number,
 *   range: (min?: number, max?: number) => number,
 *   int: (min: number, max: number) => number,
 *   pick: <T>(list: T[]) => T,
 *   chance: (p?: number) => boolean,
 *   sign: () => 1 | -1,
 *   gauss: (mean?: number, sd?: number) => number,
 *   shuffle: <T>(list: T[]) => T[],
 *   fork: (label: string | number) => Rng,
 * }} Rng
 */

/**
 * Create a seeded generator. Call it directly for a float in [0, 1), or use the helpers:
 *   rng.float(min, max)  float in [min, max)            (alias: rng.range)
 *   rng.int(min, max)    integer in [min, max], inclusive
 *   rng.pick(list)       one element
 *   rng.chance(p)        true with probability p
 *   rng.sign()           +1 or −1
 *   rng.gauss(mean, sd)  roughly normal (sum of 4 uniforms)
 *   rng.shuffle(list)    in-place Fisher–Yates, returns the list
 *   rng.fork(label)      independent deterministic stream; depends only on (this seed, label)
 * @param {number} [seed=42]
 * @returns {Rng}
 */
export function createRng(seed = SEED) {
  const next = mulberry32(seed);
  const rng = () => next();
  rng.seed = seed >>> 0;
  rng.float = (min = 0, max = 1) => min + (max - min) * next();
  rng.range = rng.float;
  rng.int = (min, max) => Math.floor(min + (max - min + 1) * next());
  rng.pick = (list) => list[Math.floor(next() * list.length)];
  rng.chance = (p = 0.5) => next() < p;
  rng.sign = () => (next() < 0.5 ? -1 : 1);
  rng.gauss = (mean = 0, sd = 1) => mean + sd * (next() + next() + next() + next() - 2) * 1.7320508;
  rng.shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  };
  rng.fork = (label) => createRng(hashLabel(rng.seed, label));
  return rng;
}

/** Root stream (seed 42). Prefer `ctx.rng` (already forked per module) or `rng.fork("my-label")`. */
export const rng = createRng(SEED);

export default rng;
