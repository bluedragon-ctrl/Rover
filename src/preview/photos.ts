// Proof of concept: what can a 16-byte science product look like? (preview.html?photos=1)
// Each subject is rendered as a detailed procedural scene, then packed into exactly
// 16 bytes with different encodings. Spectra are the spectrometer's 16-byte product.
// Preview only: deterministic hash noise, nothing here touches the simulation.

type RGB = [number, number, number];
interface Subject {
  name: string;
  note: string;
  /** Scene at u,v in [0,1): colour 0..1. */
  scene: (u: number, v: number) => RGB;
  /** 16-band reflectance 400–1000 nm, 0..1 (spectrometer). */
  spectrum: (band: number) => number;
}

// ---------------------------------------------------------------- deterministic noise
const hash = (x: number, y: number, s: number) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t: number) => t * t * (3 - 2 * t);
function vnoise(u: number, v: number, freq: number, seed: number): number {
  const x = u * freq, y = v * freq;
  const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
const fbm = (u: number, v: number, seed: number) => 0.5 * vnoise(u, v, 4, seed) + 0.3 * vnoise(u, v, 8, seed + 1) + 0.2 * vnoise(u, v, 16, seed + 2);
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const hex = (n: number): RGB => [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
const gauss = (x: number, mu: number, w: number) => Math.exp(-((x - mu) ** 2) / (2 * w * w));

const SAND = hex(0xb08458), DARK = hex(0x3a2c22), SKY = hex(0xd9b38c);

// ---------------------------------------------------------------- subjects
const SUBJECTS: Subject[] = [
  {
    name: 'FLAT_SAND', note: 'wind ripples',
    scene: (u, v) => scale(SAND, 0.55 + 0.3 * Math.sin((v * 3.2 + u * 0.8 + 0.15 * fbm(u, v, 3)) * Math.PI * 2) * 0.5 + 0.25 * fbm(u, v, 1)),
    spectrum: (b) => 0.18 + 0.5 * smooth(clamp((b - 2) / 8)) - 0.06 * gauss(b, 13, 1.5),
  },
  {
    name: 'ROUGH_GRAVEL', note: 'pebbles',
    scene: (u, v) => {
      const cx = Math.floor(u * 3), cy = Math.floor(v * 3);
      let best = 9, shade = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const px = (cx + dx + hash(cx + dx, cy + dy, 7)) / 3, py = (cy + dy + hash(cx + dx, cy + dy, 8)) / 3;
        const d = Math.hypot(u - px, v - py);
        if (d < best) (best = d), (shade = hash(cx + dx, cy + dy, 9));
      }
      const pebble = best < 0.16 ? 0.45 + 0.55 * shade - best * 1.5 : 0.18;
      return scale(hex(0x9a8f82), clamp(pebble + 0.1 * fbm(u, v, 4)));
    },
    spectrum: (b) => 0.3 + 0.2 * smooth(clamp((b - 3) / 9)) - 0.05 * gauss(b, 9, 1),
  },
  {
    name: 'CLIFF_WALL', note: 'layered strata',
    scene: (u, v) => {
      const layer = v * 5 + u * 0.6 + 0.2 * fbm(u, v, 5);
      const band = hash(Math.floor(layer), 0, 11);
      return scale(hex(0xd08a52), 0.3 + 0.6 * band - 0.15 * Math.abs(Math.sin(layer * Math.PI)));
    },
    spectrum: (b) => 0.15 + 0.55 * smooth(clamp((b - 1) / 7)) - 0.12 * gauss(b, 12, 1.3),
  },
  {
    name: 'IRON_ORE', note: 'bright vein in dark rock',
    scene: (u, v) => {
      const d = Math.abs(v - (0.25 + 0.55 * u) - 0.12 * (fbm(u, v, 6) - 0.5));
      return mix(scale(DARK, 0.6 + 0.6 * fbm(u, v, 12)), hex(0xff7a4a), clamp(1 - d / 0.14));
    },
    // hematite: dark blue, steep red edge, absorption near 860–900 nm
    spectrum: (b) => 0.06 + 0.5 * smooth(clamp((b - 3) / 4)) - 0.32 * gauss(b, 12, 1.4),
  },
  {
    name: 'SILICON_ORE', note: 'crystal facets',
    scene: (u, v) => {
      const facet = Math.floor((u + v * 0.5) * 3) * 7 + Math.floor((v - u * 0.4) * 3);
      const k = 0.35 + 0.65 * hash(facet, 3, 13);
      const edge = Math.min(((u + v * 0.5) * 3) % 1, ((v - u * 0.4 + 2) * 3) % 1) < 0.08 ? 1.25 : 1;
      return scale(hex(0x8fdcff), clamp(k * edge));
    },
    spectrum: (b) => 0.7 + 0.08 * Math.sin(b * 0.7) - 0.25 * gauss(b, 14.5, 0.8),
  },
  {
    name: 'ACID_VENT', note: 'hot plume, crust ring',
    scene: (u, v) => {
      const r = Math.hypot(u - 0.5, v - 0.55);
      return mix(scale(DARK, 0.5 + 0.4 * fbm(u, v, 14)), hex(0xc8ff5a), clamp(1.2 - r * 3.2) + 0.25 * gauss(r, 0.36, 0.04));
    },
    // sulfates: bright yellow-green, broad water band
    spectrum: (b) => 0.3 + 0.45 * gauss(b, 5, 2.5) - 0.2 * gauss(b, 15, 1.5),
  },
  {
    name: 'SAMPLE', note: 'pebble on sand',
    scene: (u, v) => {
      const r = Math.hypot((u - 0.5) * 1.2, v - 0.5);
      const shadow = clamp(1 - Math.hypot(u - 0.58, v - 0.6) * 3.3);
      const ground = scale(SAND, 0.65 - 0.35 * shadow + 0.15 * fbm(u, v, 21));
      return r < 0.26 ? scale(hex(0xffd23a), 0.6 + 0.6 * (0.5 - (u - v) * 0.6) + 0.1 * fbm(u, v, 22)) : ground;
    },
    spectrum: (b) => 0.2 + 0.4 * gauss(b, 7, 2.2) + 0.15 * gauss(b, 11, 1) - 0.1 * gauss(b, 4, 0.8),
  },
  {
    name: 'HORIZON', note: 'landscape, sun low',
    scene: (u, v) => {
      const horizon = 0.5 + 0.08 * Math.sin(u * 7) + 0.06 * vnoise(u, 0, 6, 31);
      if (v < horizon) {
        const sun = clamp(1.4 - Math.hypot(u - 0.72, v - 0.22) * 9);
        return mix(scale(SKY, 0.45 + 0.6 * v), [1, 0.97, 0.9], sun);
      }
      return scale(SAND, 0.22 + 0.35 * (v - horizon) + 0.15 * fbm(u, v, 32));
    },
    spectrum: () => 0,
  },
  {
    name: 'ANOMALY', note: 'ring pattern (rare, worth flagging)',
    scene: (u, v) => {
      const r = Math.hypot(u - 0.5, v - 0.5), a = Math.atan2(v - 0.5, u - 0.5);
      const rings = 0.5 + 0.5 * Math.cos((r * 9 + a / Math.PI) * Math.PI * 2);
      return r < 0.45 ? scale(hex(0xe8d8c0), 0.25 + 0.75 * rings) : scale(DARK, 0.6 + 0.4 * fbm(u, v, 41));
    },
    spectrum: (b) => 0.3 + 0.3 * Math.abs(Math.sin(b * 1.1)),
  },
];

// ---------------------------------------------------------------- 16-byte encodings
interface Encoding {
  id: string;
  label: string;
  w: number;
  h: number;
  /** Packs the scene into exactly 16 bytes. */
  encode: (s: Subject, night: boolean) => Uint8Array;
  /** Decodes 16 bytes into RGB pixels 0..255 (w*h*3). */
  decode: (b: Uint8Array) => Uint8ClampedArray;
}

/** Box-filtered sample of the scene for an output pixel; night = dark + sensor noise. */
function sample(s: Subject, w: number, h: number, x: number, y: number, night: boolean): RGB {
  const N = 8;
  let r = 0, g = 0, b = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const c = s.scene((x + (i + 0.5) / N) / w, (y + (j + 0.5) / N) / h);
    r += c[0], g += c[1], b += c[2];
  }
  let c: RGB = [r / N / N, g / N / N, b / N / N];
  if (night) {
    const n = (hash(x, y, w * 97 + s.name.length) - 0.5) * 0.35;
    c = c.map((v) => clamp(v * 0.3 + n)) as RGB;
  }
  return c.map(clamp) as RGB;
}
const luma = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

/**
 * Takes a w×h frame with auto-exposure, like a real rover camera: the darkest and
 * brightest pixels are stretched to the full range before quantizing, so 4 grey levels
 * are spent on the scene's actual contrast. At night this also amplifies sensor noise.
 */
function capture(s: Subject, w: number, h: number, night: boolean): RGB[] {
  const px: RGB[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.push(sample(s, w, h, x, y, night));
  const l = px.map(luma);
  const lo = Math.min(...l), hi = Math.max(...l);
  const gain = 1 / Math.max(0.12, hi - lo); // limited gain: a flat scene stays flat-ish
  // scale brightness, keep hue: every channel by the same factor as the pixel's luma
  return px.map((c, i) => {
    const k = ((l[i] - lo) * gain) / Math.max(1e-3, l[i]);
    return c.map((v) => clamp(v * k)) as RGB;
  });
}
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

const ENCODINGS: Encoding[] = [
  {
    id: 'g8', label: '4×4 · 8 bpp grey', w: 4, h: 4,
    encode: (s, n) => Uint8Array.from(capture(s, 4, 4, n), (c) => Math.round(luma(c) * 255)),
    decode: (b) => Uint8ClampedArray.from({ length: 48 }, (_, i) => b[Math.floor(i / 3)]),
  },
  {
    id: 'rgb332', label: '4×4 · RGB332 colour', w: 4, h: 4,
    encode: (s, n) => Uint8Array.from(capture(s, 4, 4, n), (c) => {
      return (Math.round(c[0] * 7) << 5) | (Math.round(c[1] * 7) << 2) | Math.round(c[2] * 3);
    }),
    decode: (b) => {
      const out = new Uint8ClampedArray(48);
      b.forEach((v, i) => {
        out[i * 3] = ((v >> 5) * 255) / 7;
        out[i * 3 + 1] = (((v >> 2) & 7) * 255) / 7;
        out[i * 3 + 2] = ((v & 3) * 255) / 3;
      });
      return out;
    },
  },
  {
    id: 'g2', label: '8×8 · 2 bpp (4 greys)', w: 8, h: 8,
    encode: (s, n) => {
      const out = new Uint8Array(16);
      const px = capture(s, 8, 8, n);
      for (let p = 0; p < 64; p++) {
        const level = Math.min(3, Math.floor(luma(px[p]) * 4));
        out[p >> 2] |= level << (6 - 2 * (p & 3));
      }
      return out;
    },
    decode: (b) => Uint8ClampedArray.from({ length: 192 }, (_, i) => {
      const p = Math.floor(i / 3);
      return (((b[p >> 2] >> (6 - 2 * (p & 3))) & 3) * 255) / 3;
    }),
  },
  {
    id: 'g1', label: '16×8 · 1 bpp dithered', w: 16, h: 8,
    encode: (s, n) => {
      const out = new Uint8Array(16);
      const px = capture(s, 16, 8, n);
      for (let p = 0; p < 128; p++) {
        const x = p % 16, y = p >> 4;
        if (luma(px[p]) * 16 > BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) out[p >> 3] |= 0x80 >> (p & 7);
      }
      return out;
    },
    decode: (b) => Uint8ClampedArray.from({ length: 384 }, (_, i) => {
      const p = Math.floor(i / 3);
      return (b[p >> 3] >> (7 - (p & 7))) & 1 ? 235 : 20;
    }),
  },
];

// ---------------------------------------------------------------- drawing
const CELL = 112;

/** Draws decoded pixels; bytes >= `received` are missing (partial downlink). */
function drawImage(enc: Encoding, bytes: Uint8Array, received: number, smoothUp: boolean): HTMLCanvasElement {
  const px = enc.decode(bytes);
  const src = document.createElement('canvas');
  src.width = enc.w, src.height = enc.h;
  const sctx = src.getContext('2d')!;
  const img = sctx.createImageData(enc.w, enc.h);
  const pixelsPerByte = (enc.w * enc.h) / 16;
  for (let p = 0; p < enc.w * enc.h; p++) {
    const missing = Math.floor(p / pixelsPerByte) >= received;
    for (let k = 0; k < 3; k++) img.data[p * 4 + k] = missing ? 0 : px[p * 3 + k];
    img.data[p * 4 + 3] = missing ? 0 : 255;
  }
  sctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = CELL;
  const ctx = out.getContext('2d')!;
  // missing data: hatched
  ctx.fillStyle = '#111a26';
  ctx.fillRect(0, 0, CELL, CELL);
  ctx.strokeStyle = '#2b3b52';
  for (let i = -CELL; i < CELL; i += 8) ctx.beginPath(), ctx.moveTo(i, CELL), ctx.lineTo(i + CELL, 0), ctx.stroke();
  ctx.imageSmoothingEnabled = smoothUp;
  if (smoothUp) {
    // two-step upscale: bilinear between pixel centres
    const mid = document.createElement('canvas');
    mid.width = enc.w * 4, mid.height = enc.h * 4;
    const m = mid.getContext('2d')!;
    m.imageSmoothingEnabled = true;
    m.drawImage(src, 0, 0, mid.width, mid.height);
    ctx.drawImage(mid, 0, 0, CELL, CELL);
  } else ctx.drawImage(src, 0, 0, CELL, CELL);
  return out;
}

function drawReference(s: Subject, night: boolean): HTMLCanvasElement {
  const R = 56;
  const src = document.createElement('canvas');
  src.width = src.height = R;
  const ctx = src.getContext('2d')!;
  const img = ctx.createImageData(R, R);
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    let c = s.scene((x + 0.5) / R, (y + 0.5) / R);
    if (night) c = c.map((v) => clamp(v * 0.3 + (hash(x, y, 5) - 0.5) * 0.35)) as RGB;
    img.data.set([clamp(c[0]) * 255, clamp(c[1]) * 255, clamp(c[2]) * 255, 255], (y * R + x) * 4);
  }
  ctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = CELL;
  out.getContext('2d')!.drawImage(src, 0, 0, CELL, CELL);
  return out;
}

function spectrumBytes(s: Subject): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, b) => Math.round(clamp(s.spectrum(b)) * 255));
}

function drawSpectrum(bytes: Uint8Array): HTMLCanvasElement {
  const W = 150, H = CELL;
  const c = document.createElement('canvas');
  c.width = W, c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#08111c';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#1c2a3c';
  for (let y = 0; y <= 4; y++) ctx.beginPath(), ctx.moveTo(0, 6 + (y * (H - 22)) / 4), ctx.lineTo(W, 6 + (y * (H - 22)) / 4), ctx.stroke();
  const bw = (W - 8) / 16;
  bytes.forEach((v, b) => {
    // 400..1000 nm: violet → red → infrared (drawn dim magenta)
    const nm = 400 + b * 40;
    const hue = nm < 700 ? 270 - ((nm - 400) / 300) * 270 : 330;
    ctx.fillStyle = `hsl(${hue} ${nm < 700 ? 85 : 35}% ${nm < 700 ? 58 : 45}%)`;
    const h = (v / 255) * (H - 22);
    ctx.fillRect(4 + b * bw + 1, H - 16 - h, bw - 2, h);
  });
  ctx.fillStyle = '#7d8ca3';
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText('400', 2, H - 4), ctx.fillText('700', 4 + 7.5 * bw - 6, H - 4), ctx.fillText('1000 nm', W - 40, H - 4);
  return c;
}

const hexDump = (b: Uint8Array, received = 16) =>
  Array.from(b, (v, i) => (i < received ? v.toString(16).padStart(2, '0').toUpperCase() : '··')).reduce((s, h, i) => s + (i === 8 ? '\n' : i ? ' ' : '') + h, '');

// ---------------------------------------------------------------- panel
export function mountPhotoLab(root: HTMLElement, q: URLSearchParams): void {
  const opts = { smooth: q.get('smooth') === '1', night: q.get('night') === '1', partial: q.get('partial') === '1' };
  root.hidden = false;
  const render = () => {
    const received = opts.partial ? 10 : 16;
    root.innerHTML = `
      <div class="pl-head">
        <b>SCIENCE PRODUCTS · 16 BYTES EACH</b>
        <span class="dim">camera: same scene, four encodings of 16 B · spectrometer: 16 bands × 1 B</span>
        <span class="pl-toggles"></span>
      </div>
      <div class="pl-grid"></div>`;
    const toggles = root.querySelector('.pl-toggles')!;
    for (const [k, label] of [['smooth', 'smooth upscale'], ['night', 'night, no headlight'], ['partial', 'partial downlink (10/16 B)']] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.classList.toggle('on', opts[k]);
      b.onclick = () => ((opts[k] = !opts[k]), render());
      toggles.appendChild(b);
    }
    const grid = root.querySelector('.pl-grid')!;
    const head = ['subject', 'scene (ground truth)', ...ENCODINGS.map((e) => e.label), 'spectrometer'];
    for (const h of head) grid.insertAdjacentHTML('beforeend', `<div class="pl-colhead">${h}</div>`);
    for (const s of SUBJECTS) {
      grid.insertAdjacentHTML('beforeend', `<div class="pl-name"><b>${s.name}</b><br><span class="dim">${s.note}</span></div>`);
      const ref = document.createElement('div');
      ref.className = 'pl-cell';
      ref.appendChild(drawReference(s, opts.night));
      ref.insertAdjacentHTML('beforeend', `<pre class="dim">not sent\n(what the lens sees)</pre>`);
      grid.appendChild(ref);
      for (const enc of ENCODINGS) {
        const bytes = enc.encode(s, opts.night);
        const cell = document.createElement('div');
        cell.className = 'pl-cell';
        cell.appendChild(drawImage(enc, bytes, received, opts.smooth));
        cell.insertAdjacentHTML('beforeend', `<pre>${hexDump(bytes, received)}</pre>`);
        grid.appendChild(cell);
      }
      const cell = document.createElement('div');
      cell.className = 'pl-cell';
      if (s.name === 'HORIZON') cell.innerHTML = '<div class="pl-na dim">(camera only)</div>';
      else {
        const sb = spectrumBytes(s);
        cell.appendChild(drawSpectrum(sb));
        cell.insertAdjacentHTML('beforeend', `<pre>${hexDump(sb, received)}</pre>`);
      }
      grid.appendChild(cell);
    }
  };
  render();
}
