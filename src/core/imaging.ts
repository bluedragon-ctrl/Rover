/**
 * Science product content (docs/SPEC.md §3.8.5). Pure, integer-only functions of the world
 * seed and a product descriptor: the recorder stores descriptors, the bytes are generated
 * only when mission control decodes a product. No Math.random, no float trig.
 */
import { productFrameBytes, ProductType, scienceHeader, type ProductDesc } from './downlink';
import { photoPayload } from './photos';
import { hash3 } from './rng';
import { T } from './WorldRegistry';

/** Spectrum bands: 16 bands, 400–1000 nm in 40 nm steps. */
export const SPECTRUM_BANDS = 16;
export const bandNm = (i: number): number => 400 + 40 * i;

/** Base reflectance curves (0–255) per analyzed material. */
const CURVES: Record<number, readonly number[]> = {
  // Iron oxides: dark blue, red slope, absorption near 900 nm.
  [T.IRON_ORE]: [40, 45, 52, 62, 80, 105, 130, 150, 165, 170, 160, 135, 115, 120, 132, 140],
  // Silicon: flat and bright.
  [T.SILICON_ORE]: [200, 205, 208, 210, 212, 212, 213, 213, 214, 214, 214, 213, 213, 212, 212, 211],
  // Vent sulfates in the sample: green peak.
  [T.SAMPLE]: [90, 110, 150, 190, 200, 170, 140, 125, 118, 115, 112, 110, 108, 104, 100, 96],
};
const FLAT = new Array(SPECTRUM_BANDS).fill(128);

/**
 * 16-byte spectrum. The material's curve, scaled by a per-position brightness (88–112 %),
 * plus per-position band variation (±6) and a little sensor noise per measurement (±2).
 */
export function spectrum(seed: number, d: Pick<ProductDesc, 'subject' | 'x' | 'y' | 'tick' | 'seq'>): number[] {
  const base = CURVES[d.subject] ?? FLAT;
  const scale = 88 + (hash3(seed, d.x, d.y, 0x5bec) % 25);
  const out: number[] = [];
  for (let i = 0; i < SPECTRUM_BANDS; i++) {
    let v = Math.floor((base[i] * scale) / 100);
    v += (hash3(seed, d.x, d.y, 0x5be0 + i) % 13) - 6;
    v += (hash3(seed, d.tick, d.seq, 0x5e50 + i) % 5) - 2;
    out.push(v < 0 ? 0 : v > 255 ? 255 : v);
  }
  return out;
}

/** Product payload bytes. */
export function productPayload(seed: number, d: ProductDesc): number[] {
  switch (d.type) {
    case ProductType.SPECTRUM:
      return spectrum(seed, d);
    case ProductType.PHOTO_GREY:
    case ProductType.PHOTO_DITHER:
    case ProductType.PHOTO_PALETTE:
    case ProductType.PHOTO_HIRES:
    case ProductType.PHOTO_RGB:
      return photoPayload(seed, { type: d.type, subject: d.subject, sx: d.sx ?? d.x, sy: d.sy ?? d.y, lit: d.lit ?? false, tick: d.tick, seq: d.seq, horizon: d.horizon });
    default:
      return [];
  }
}

/** The complete science frame as sent: header, sequence byte, payload. */
export function productFrame(seed: number, d: ProductDesc): number[] {
  const f = [scienceHeader(d.type), d.seq & 255, ...productPayload(seed, d)];
  return f.slice(0, productFrameBytes(d.type));
}
