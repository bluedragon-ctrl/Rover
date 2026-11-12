/** Deterministic integer hashing and PRNG. No Math.random anywhere in core. */

/** 32-bit avalanche hash of up to three ints plus a seed. */
export function hash3(seed: number, x: number, y: number, salt = 0): number {
  let h = (seed ^ 0x9e3779b9) | 0;
  h = Math.imul(h ^ x, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ y, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h ^ salt, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x165667b1);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash mapped to [0, 1). */
export function hash01(seed: number, x: number, y: number, salt = 0): number {
  return hash3(seed, x, y, salt) / 4294967296;
}

/**
 * Value noise on an integer lattice with cell size `scale`, smoothstep interpolated.
 * Uses only + - * / so results are bit-identical across JS engines.
 */
export function valueNoise(seed: number, x: number, y: number, scale: number, salt = 0): number {
  const gx = Math.floor(x / scale);
  const gy = Math.floor(y / scale);
  const fx = (x - gx * scale) / scale;
  const fy = (y - gy * scale) / scale;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash01(seed, gx, gy, salt);
  const b = hash01(seed, gx + 1, gy, salt);
  const c = hash01(seed, gx, gy + 1, salt);
  const d = hash01(seed, gx + 1, gy + 1, salt);
  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

/** Two-octave fractal value noise in [0, 1). */
export function fbm(seed: number, x: number, y: number, scale: number, salt = 0): number {
  return valueNoise(seed, x, y, scale, salt) * 0.65 + valueNoise(seed, x, y, scale / 2, salt + 101) * 0.35;
}

/** Mulberry32 sequential PRNG for storyteller/events. */
export class Rng {
  constructor(public state: number) {}
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
