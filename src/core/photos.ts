/**
 * Camera photos (docs/SPEC.md §3.8.5): a deterministic, integer-only image generator.
 * Each subject is a small procedural scene (ported from the preview POC,
 * src/preview/photos.ts); the camera box-filters it, auto-exposes and quantizes it into one
 * of the product formats. Only runs when mission control decodes a product (the recorder
 * stores descriptors), never per tick. No Math.random, no float trig: coordinates are
 * fixed point (1024 = the full frame), colours 0–255, waves from the SIN1000 table.
 */
import { sin1000 } from './Environment';
import { hash3 } from './rng';
import { T } from './WorldRegistry';

type RGB = [number, number, number];

/** Photo format per product type (1–5). */
export interface PhotoFormat {
  w: number;
  h: number;
  bpp: number;
  kind: 'grey' | 'dither' | 'palette' | 'rgb332';
  label: string;
}

export const PHOTO_FORMATS: Record<number, PhotoFormat> = {
  1: { w: 32, h: 32, bpp: 2, kind: 'grey', label: '32×32 · 2 bpp grey' },
  2: { w: 32, h: 32, bpp: 2, kind: 'dither', label: '32×32 · 2 bpp grey, dithered' },
  3: { w: 32, h: 32, bpp: 4, kind: 'palette', label: '32×32 · 4 bpp, 16-colour palette' },
  4: { w: 64, h: 64, bpp: 2, kind: 'dither', label: '64×64 · 2 bpp grey, dithered' },
  5: { w: 32, h: 32, bpp: 8, kind: 'rgb332', label: '32×32 · 8 bpp RGB332' },
};

export const photoBytes = (type: number): number => {
  const f = PHOTO_FORMATS[type];
  return f ? (f.w * f.h * f.bpp) / 8 : 0;
};

// ---------------------------------------------------------------- integer helpers

const ONE = 1024;
const clamp8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const hex = (n: number): RGB => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
/** Colour × k/256. */
const scale = (c: RGB, k: number): RGB => [clamp8((c[0] * k) >> 8), clamp8((c[1] * k) >> 8), clamp8((c[2] * k) >> 8)];
/** Linear mix, t in 0..256. */
const mix = (a: RGB, b: RGB, t: number): RGB => {
  const s = t < 0 ? 0 : t > 256 ? 256 : t;
  return [a[0] + (((b[0] - a[0]) * s) >> 8), a[1] + (((b[1] - a[1]) * s) >> 8), a[2] + (((b[2] - a[2]) * s) >> 8)];
};
const isqrt = (n: number): number => Math.floor(Math.sqrt(n));
const dist = (dx: number, dy: number): number => isqrt(dx * dx + dy * dy);
/** Wave −256..256, phase in 1/1024 of a period. */
const wave = (phase: number): number => (sin1000(Math.floor((phase * 360) / ONE)) * 256 / 1000) | 0;
/** Smoothstep in Q10. */
const smooth = (t: number): number => (((t * t) >> 10) * (3 * ONE - 2 * t)) >> 10;

/** Value noise 0..255 at (u, v) in Q10 with `freq` cells per frame. */
function vnoise(seed: number, u: number, v: number, freq: number, salt: number): number {
  const x = u * freq;
  const y = v * freq;
  const xi = x >> 10;
  const yi = y >> 10;
  const sx = smooth(x & 1023);
  const sy = smooth(y & 1023);
  const a = hash3(seed, xi, yi, salt) & 255;
  const b = hash3(seed, xi + 1, yi, salt) & 255;
  const c = hash3(seed, xi, yi + 1, salt) & 255;
  const d = hash3(seed, xi + 1, yi + 1, salt) & 255;
  const top = a + (((b - a) * sx) >> 10);
  const bot = c + (((d - c) * sx) >> 10);
  return top + (((bot - top) * sy) >> 10);
}
/** Three-octave noise 0..255. */
const fbm = (seed: number, u: number, v: number, salt: number): number =>
  ((5 * vnoise(seed, u, v, 4, salt) + 3 * vnoise(seed, u, v, 8, salt + 1) + 2 * vnoise(seed, u, v, 16, salt + 2)) / 10) | 0;

const SAND = hex(0xb08458);
const DARK = hex(0x3a2c22);

// ---------------------------------------------------------------- scenes

/** A scene: colour at (u, v), both 0..1023; `s` = per-subject seed (same rock, same look). */
type Scene = (u: number, v: number, s: number) => RGB;

const sand: Scene = (u, v, s) => {
  const f = fbm(s, u, v, 1);
  const phase = (v * 16) / 5 + (u * 4) / 5 + ((fbm(s, u, v, 3) * 154) >> 8) + (s & 1023);
  return scale(SAND, 141 + ((38 * wave(phase)) >> 8) + ((64 * f) >> 8));
};

const gravel: Scene = (u, v, s) => {
  const cx = (u * 3) >> 10;
  const cy = (v * 3) >> 10;
  let best = 1 << 30;
  let shade = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const h = hash3(s, cx + dx, cy + dy, 7);
      const px = (((cx + dx) * ONE + (h & 1023)) / 3) | 0;
      const py = (((cy + dy) * ONE + ((h >>> 10) & 1023)) / 3) | 0;
      const d = dist(u - px, v - py);
      if (d < best) {
        best = d;
        shade = (h >>> 20) & 255;
      }
    }
  const pebble = best < 164 ? 115 + ((141 * shade) >> 8) - ((best * 3) >> 3) : 46;
  return scale(hex(0x9a8f82), pebble + ((26 * fbm(s, u, v, 4)) >> 8));
};

const cliff: Scene = (u, v, s) => {
  const layer = v * 5 + ((u * 6) / 10 | 0) + ((fbm(s, u, v, 5) * 205) >> 8);
  const band = hash3(s, layer >> 10, 0, 11) & 255;
  const frac = layer & 1023;
  const crease = (frac * (ONE - frac)) >> 10; // |sin| of the layer, 0..256
  return scale(hex(0xd08a52), 77 + ((154 * band) >> 8) - ((38 * crease) >> 8));
};

const ironOre: Scene = (u, v, s) => {
  const line = 256 + ((u * 55) / 100 | 0) + (((fbm(s, u, v, 6) - 128) * 123) >> 8) + (s & 63) - 32;
  const d = Math.abs(v - line);
  const rock = scale(DARK, 154 + ((154 * vnoise(s, u, v, 12, 9)) >> 8));
  return mix(rock, hex(0xff7a4a), 256 - ((d * 256) / 143 | 0));
};

const siliconOre: Scene = (u, v, s) => {
  const a = (u + (v >> 1)) * 3;
  const b = (v - ((u * 2) / 5 | 0) + 2 * ONE) * 3;
  const facet = (a >> 10) * 7 + (b >> 10);
  let k = 90 + ((166 * (hash3(s, facet, 3, 13) & 255)) >> 8);
  if (Math.min(a & 1023, b & 1023) < 82) k = (k * 5) >> 2;
  return scale(hex(0x8fdcff), k);
};

const vent: Scene = (u, v, s) => {
  const r = dist(u - 512, v - 563);
  const ground = scale(DARK, 128 + ((102 * vnoise(s, u, v, 14, 15)) >> 8));
  const plume = 307 - ((r * 819) >> 10);
  const ring = Math.max(0, 64 - ((Math.abs(r - 369) * 64) / 41 | 0));
  return mix(ground, hex(0xc8ff5a), plume + ring);
};

const sample: Scene = (u, v, s) => {
  const r = dist(((u - 512) * 6) / 5 | 0, v - 512);
  const shadow = Math.max(0, 256 - ((dist(u - 594, v - 614) * 845) >> 10));
  const ground = scale(SAND, 166 - ((90 * shadow) >> 8) + ((38 * fbm(s, u, v, 21)) >> 8));
  if (r >= 266) return ground;
  const lit = 154 + ((154 * (128 - (((u - v) * 154) >> 10))) >> 8) + ((26 * fbm(s, u, v, 22)) >> 8);
  return scale(hex(0xffd23a), lit);
};

/** A box on sand: lit top face, darker front, shadow; `mark` paints the face. */
function crate(u: number, v: number, s: number, color: RGB, mark: (fu: number, fv: number) => boolean, markColor: RGB): RGB {
  const ground = scale(SAND, 150 + ((40 * fbm(s, u, v, 31)) >> 8));
  const inTop = Math.abs(u - 512) < 260 && v > 250 && v < 420;
  const inFront = Math.abs(u - 512) < 260 && v >= 420 && v < 780;
  const inShadow = u > 560 && u < 860 && v >= 780 && v < 860;
  if (inTop) return scale(color, 290);
  if (inFront) {
    const fu = u - 252;
    const fv = v - 420;
    return mark(fu, fv) ? markColor : scale(color, 200);
  }
  return inShadow ? scale(ground, 120) : ground;
}

const repairKit: Scene = (u, v, s) =>
  crate(u, v, s, hex(0xd8d8d8), (fu, fv) => (Math.abs(fu - 260) < 40 && Math.abs(fv - 180) < 120) || (Math.abs(fv - 180) < 40 && Math.abs(fu - 260) < 120), hex(0xc03028));

const supplyCrate: Scene = (u, v, s) => crate(u, v, s, hex(0xffd23a), (fu, fv) => ((fu + fv) & 127) < 48, hex(0x2a1d16));

const rover: Scene = (u, v, s) => {
  const ground = scale(SAND, 140 + ((50 * fbm(s, u, v, 41)) >> 8));
  for (const wx of [250, 512, 774]) if (dist(u - wx, v - 720) < 90) return dist(u - wx, v - 720) < 40 ? hex(0x777777) : hex(0x202020);
  if (Math.abs(u - 512) < 380 && v > 430 && v < 680) return scale(hex(0xd0d4d8), 200 + ((v - 430) >> 3));
  if (Math.abs(u - 600) < 30 && v > 200 && v <= 430) return hex(0x909090);
  if (dist(u - 600, v - 190) < 70) return hex(0xe8e8e8);
  return ground;
};

const SCENES: Record<number, Scene> = {
  [T.FLAT_SAND]: sand,
  [T.ROUGH_GRAVEL]: gravel,
  [T.ACID_VENT]: vent,
  [T.CLIFF_WALL]: cliff,
  [T.IRON_ORE]: ironOre,
  [T.SILICON_ORE]: siliconOre,
  [T.SAMPLE]: sample,
  [T.REPAIR_KIT]: repairKit,
  [T.SUPPLY_CRATE]: supplyCrate,
  [T.ROVER]: rover,
};

// ---------------------------------------------------------------- landscape (nothing within reach)

/**
 * What the camera sees looking out over open ground, sampled from the real world when the
 * photo is taken (so it can be redrawn later without the world): a skyline of 16 columns
 * across a 90° field of view, the ground ahead, the sun and the light.
 */
export interface HorizonView {
  /** Apparent height of the tallest obstacle per column, 0–256 (256 = top of the frame). */
  h: number[];
  /** Distance in tiles of that obstacle (0 = open view). */
  d: number[];
  /** Its tile id (colour). */
  t: number[];
  /** Most common terrain on the first tiles ahead. */
  ground: number;
  /** Sun position in the frame (Q10), sunU −1 = not in view. */
  sunU: number;
  sunV: number;
  /** @SUN_LIGHT when the photo was taken (night + headlight: lit foreground only). */
  light: number;
}

export const HORIZON_COLUMNS = 16;
/** Horizon row (Q10 from the top): a little more ground than sky. */
export const HORIZON_V = 448;
const SKY = hex(0xd9b38c);
const NIGHT_SKY = hex(0x0b0d16);
const OBSTACLE_COLOR: Record<number, number> = { [T.CLIFF_WALL]: 0xd08a52, [T.IRON_ORE]: 0x9a4a36, [T.SILICON_ORE]: 0x6fb8d8 };

function horizonScene(view: HorizonView): Scene {
  const H = HORIZON_V;
  const day = Math.floor((Math.min(100, view.light) * 256) / 100);
  const bright = 90 + ((166 * day) >> 8); // sky, ridges and far ground
  const headlight = view.light < 20;
  const col = (u: number, arr: number[]): [number, number, number] => {
    const x = Math.max(0, Math.min(15 * ONE, u * 16 - 512));
    const c0 = x >> 10;
    const c1 = Math.min(15, c0 + 1);
    return [arr[c0], arr[c1], x & 1023];
  };
  return (u, v, s) => {
    // sky with the sun
    const sky = (): RGB => {
      let c = mix(NIGHT_SKY, scale(SKY, 110 + ((v * 70) / H | 0)), day);
      if (day < 64 && (hash3(s, u >> 4, v >> 4, 51) & 255) < 3) c = [200, 200, 210]; // stars
      if (view.sunU >= 0) {
        const r = dist(u - view.sunU, v - view.sunV);
        if (r < 36) return [255, 250, 236];
        c = mix(c, [255, 240, 210], Math.max(0, 180 - ((r * 180) / 220 | 0)));
      }
      return c;
    };
    if (v < H) {
      // ridges: the far range (always there, hazy) and the real obstacles in view
      const [h0, h1, t] = col(u, view.h);
      const hNear = h0 + (((h1 - h0) * t) >> 10);
      const jag = ((vnoise(s, u, 0, 24, 52) - 128) * hNear) >> 9;
      const nearTop = hNear > 0 ? H - (((hNear + jag) * H) >> 8) : H;
      const farTop = H - ((14 + ((vnoise(s, u, 0, 5, 53) * 22) >> 8)) * H >> 8);
      if (v >= nearTop) {
        const [d0, d1] = col(u, view.d);
        const [k0, k1] = col(u, view.t);
        const near = t < 512 ? (d0 || d1) : (d1 || d0);
        const tile = t < 512 ? (k0 || k1) : (k1 || k0);
        const band = hash3(s, (v * 12) >> 10, tile, 54) & 31; // strata
        const depth = ((v - nearTop) * 60) / Math.max(1, H - nearTop) | 0; // shadowed toward the foot
        const shade = 175 + band - depth + ((vnoise(s, u, v, 12, 55) - 128) >> 3);
        const rock = scale(hex(OBSTACLE_COLOR[tile] ?? 0xd08a52), (shade * bright) >> 8);
        return mix(scale(rock, 200), scale(SKY, (150 * bright) >> 8), Math.min(140, near * 8)); // haze with distance
      }
      if (v >= farTop) return mix(scale(hex(0xb07850), (150 * bright) >> 8), sky(), 110);
      return sky();
    }
    // ground in perspective: z grows toward the horizon
    const z = ((64 * ONE) / (v - H + 16)) | 0;
    const gx = ((u - 512) * z) >> 9;
    let k = 205 + ((14 * wave(z * 3 + (gx >> 3))) >> 8) + ((vnoise(s, gx & 0xffff, z, 2, 56) - 128) >> 3);
    let c: RGB;
    if (view.ground === T.ROUGH_GRAVEL) {
      const spot = hash3(s, gx >> 5, z >> 5, 57) & 255;
      c = scale(hex(0x9a8f82), spot < 50 ? 150 : 210 + (spot >> 3));
    } else c = SAND;
    if (view.ground === T.ACID_VENT) {
      // a few glowing vent patches on the ground ahead
      const cx = gx >> 8;
      const cz = z >> 8;
      const hv = hash3(s, cx, cz, 58);
      if ((hv & 255) < 60) {
        const px = (cx << 8) + ((hv >>> 8) & 255);
        const pz = (cz << 8) + ((hv >>> 16) & 255);
        const r = dist(gx - px, (z - pz) * 2);
        if (r < 70) c = mix(c, hex(0xc8ff5a), 256 - r * 3);
      }
    }
    k = (k * (210 + ((v - H) >> 4))) >> 8; // nearer = brighter
    const lamp = headlight ? Math.max(0, 300 - ((Math.abs(u - 512) * 300) / Math.max(1, v - H) | 0) - ((ONE - v) >> 1)) : 0;
    c = scale(c, (k * Math.max(bright, Math.min(256, lamp))) >> 8);
    return mix(c, sky(), Math.max(0, 200 - (v - H) * 6)); // far ground fades into the haze
  };
}

// ---------------------------------------------------------------- the camera

export interface PhotoShot {
  type: number;
  subject: number;
  /** Subject tile (same rock ⇒ same scene). */
  sx: number;
  sy: number;
  lit: boolean;
  tick: number;
  seq: number;
  /** Landscape photo (no subject within reach). */
  horizon?: HorizonView;
}

const luma = (c: RGB): number => (77 * c[0] + 151 * c[1] + 28 * c[2]) >> 8;

/** Box-filtered frame with sensor noise (dark: dim + strong noise), then auto-exposed. */
function capture(seed: number, p: PhotoShot, w: number, h: number): RGB[] {
  const scene = p.horizon ? horizonScene(p.horizon) : (SCENES[p.subject] ?? sand);
  const s = hash3(seed, p.sx, p.sy, p.subject);
  const N = 2;
  const px: RGB[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const c = scene((((x * N + i) * 2 + 1) * ONE) / (2 * w * N) | 0, (((y * N + j) * 2 + 1) * ONE) / (2 * h * N) | 0, s);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      const n = hash3(seed ^ p.tick, x, y, p.seq * 8 + p.type);
      if (p.lit) {
        const k = (n % 7) - 3; // a little sensor noise per exposure
        px.push([clamp8(r / 4 + k), clamp8(g / 4 + k), clamp8(b / 4 + k)]);
      } else {
        const k = (n % 90) - 45; // dark frame: little signal, lots of noise
        px.push([clamp8(((r / 4) * 3) / 10 + k), clamp8(((g / 4) * 3) / 10 + k), clamp8(((b / 4) * 3) / 10 + k)]);
      }
    }
  // Auto-exposure: stretch darkest..brightest luma to the full range, keep hue.
  // The brightest 3 % (the sun, glints) clip instead of darkening the whole frame.
  const l = px.map(luma);
  const hist = new Array<number>(256).fill(0);
  let lo = 255;
  for (const v of l) {
    hist[v]++;
    if (v < lo) lo = v;
  }
  let hi = 255;
  for (let above = 0; hi > 0 && (above += hist[hi]) <= (l.length * 3) / 100; ) hi--;
  const range = Math.max(31, hi - lo); // limited gain: a flat scene stays flat-ish
  return px.map((c, i) => {
    const li = Math.max(1, l[i]);
    const num = (l[i] - lo) * 255;
    const den = range * li;
    return [clamp8((c[0] * num) / den), clamp8((c[1] * num) / den), clamp8((c[2] * num) / den)];
  });
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** 16-colour palette tuned for the planet (camera mode 3). */
export const PALETTE16: readonly RGB[] = [
  0x000000, 0x2a1d16, 0x4a3324, 0x6e4c33, 0x93694a, 0xb88d66, 0xd9b38c, 0xf2e2c8,
  0x8a2f22, 0xe0643c, 0xffc94a, 0x8fbf3a, 0x2f6f7a, 0x6fd0f0, 0x5a5f8a, 0xffffff,
].map(hex);

function pack(values: number[], bpp: number): number[] {
  const out = new Array<number>((values.length * bpp) / 8).fill(0);
  values.forEach((v, p) => {
    const bit = p * bpp;
    out[bit >> 3] |= v << (8 - bpp - (bit & 7));
  });
  return out;
}

function unpack(b: readonly number[], count: number, bpp: number): number[] {
  const mask = (1 << bpp) - 1;
  const out: number[] = [];
  for (let p = 0; p < count; p++) {
    const bit = p * bpp;
    out.push(((b[bit >> 3] ?? 0) >> (8 - bpp - (bit & 7))) & mask);
  }
  return out;
}

/** Photo payload bytes (pixels packed MSB-first, row by row). */
export function photoPayload(seed: number, p: PhotoShot): number[] {
  const f = PHOTO_FORMATS[p.type];
  if (!f) return [];
  const px = capture(seed, p, f.w, f.h);
  const max = (1 << f.bpp) - 1;
  switch (f.kind) {
    case 'grey':
      return pack(px.map((c) => Math.min(max, Math.floor((luma(c) * max * 2 + 255) / 510))), f.bpp);
    case 'dither':
      return pack(
        px.map((c, i) => {
          const t = 2 * BAYER4[(((i / f.w) | 0) & 3) * 4 + ((i % f.w) & 3)] + 1;
          return Math.min(max, Math.floor((luma(c) * max * 32 + t * 255) / (255 * 32)));
        }),
        f.bpp,
      );
    case 'palette':
      return pack(
        px.map((c) => {
          let best = 0;
          let bd = Infinity;
          PALETTE16.forEach((q, i) => {
            const d = 2 * (c[0] - q[0]) ** 2 + 4 * (c[1] - q[1]) ** 2 + 3 * (c[2] - q[2]) ** 2;
            if (d < bd) {
              bd = d;
              best = i;
            }
          });
          return best;
        }),
        4,
      );
    case 'rgb332':
      return px.map((c) => ((((c[0] * 7 + 127) / 255) | 0) << 5) | ((((c[1] * 7 + 127) / 255) | 0) << 2) | (((c[2] * 3 + 127) / 255) | 0));
  }
}

/**
 * Decode received photo bytes into RGB 0..255 per pixel (w×h×3). `bytes` may be partial:
 * pixels from `pixelsReceived` on have not arrived yet (callers hatch them).
 */
export function decodePhoto(type: number, bytes: readonly number[]): { w: number; h: number; rgb: Uint8ClampedArray; pixelsReceived: number } | null {
  const f = PHOTO_FORMATS[type];
  if (!f) return null;
  const n = f.w * f.h;
  const v = unpack(bytes, n, f.bpp);
  const rgb = new Uint8ClampedArray(n * 3);
  const max = (1 << f.bpp) - 1;
  for (let i = 0; i < n; i++) {
    let c: readonly number[];
    if (f.kind === 'palette') c = PALETTE16[v[i]];
    else if (f.kind === 'rgb332') c = [((v[i] >> 5) * 255) / 7, (((v[i] >> 2) & 7) * 255) / 7, ((v[i] & 3) * 255) / 3];
    else {
      const g = (v[i] * 255) / max;
      c = [g, g, g];
    }
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  return { w: f.w, h: f.h, rgb, pixelsReceived: Math.min(n, Math.floor((bytes.length * 8) / f.bpp)) };
}
