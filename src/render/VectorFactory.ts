import * as THREE from 'three';
import type { TileShape } from '../core/WorldRegistry';
import { ColorCells, mergeStatic } from './RigMerge';

/** Falling supply capsule with parachute, centred at the origin (y up). */
export function buildCapsuleMesh(): THREE.LineSegments {
  const b = new LineBatch().color(0xffd23a, 1);
  b.box(-0.25, 0, -0.25, 0.5, 0.4, 0.5);
  const canopy: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    canopy.push([Math.cos(a) * 0.9, 1.8, Math.sin(a) * 0.9]);
  }
  b.color(0xffffff, 0.9).loop(canopy);
  for (let i = 0; i < 8; i += 2) b.seg(canopy[i][0], canopy[i][1], canopy[i][2], 0, 0.4, 0);
  b.seg(-0.9, 1.8, 0, 0, 2.2, 0).seg(0.9, 1.8, 0, 0, 2.2, 0);
  return new THREE.LineSegments(b.buildBasic(), new THREE.LineBasicMaterial({ vertexColors: true }));
}

const lines = (b: LineBatch, opts: THREE.LineBasicMaterialParameters = {}) =>
  new THREE.LineSegments(b.buildBasic(), new THREE.LineBasicMaterial({ vertexColors: true, ...opts }));

export const LIGHT_HEX = [0x333333, 0xff3030, 0x30ff60, 0x3080ff, 0xffb020];
/** Colour of an indicator lamp (`@IND1..3`); OFF is a dark lens. */
export const indicatorHex = (v: number): number => (v > 0 ? LIGHT_HEX[v] ?? 0xffffff : 0x1a2230);

// ============================================================================================
// M8 vector assets (v2): what the game renders. New shapes go through preview.html first.
// ============================================================================================

type V3 = readonly [number, number, number];

/**
 * Per-vertex visibility flag of terrain geometry (TileLighting, `col.w`):
 * VISIBLE always drawn; HIDDEN unmapped terrain, drawn only under a radar wave;
 * GONE never drawn (a survey cross whose tile has since been mapped).
 */
export const Vis = { VISIBLE: 0, HIDDEN: 1, GONE: 2 } as const;
export type Vis = (typeof Vis)[keyof typeof Vis];
/** `Vis` stored in a normalised Uint16 (`flag * 0.5`, so the shader reads `col.w * 2`). */
export const VIS_U16: Record<Vis, number> = { 0: 0, 1: 32768, 2: 65535 };

const U16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v * 65535)));

/**
 * Growable typed vertex store shared by LineBatch and FillBatch. Compact terrain format
 * (24 bytes per vertex instead of 36):
 * - `position` Float32 ×3
 * - `col` Uint16 ×4 normalised: linear rgb + visibility flag (`Vis`)
 * - `tile` Int16 ×2: tile centre (x, z) × 2, so half-tile centres stay exact
 */
class VertexStore {
  pos = new Float32Array(3 * 1024);
  col = new Uint16Array(4 * 1024);
  tile = new Int16Array(2 * 1024);
  /** Vertices written so far. */
  n = 0;
  r = 65535;
  g = 65535;
  b = 65535;
  h = 0;
  tx = 0;
  tz = 0;

  setColor(hex: number, k: number): void {
    this.r = U16((((hex >> 16) & 255) / 255) * k);
    this.g = U16((((hex >> 8) & 255) / 255) * k);
    this.b = U16(((hex & 255) / 255) * k);
  }

  private grow(): void {
    const cap = this.pos.length / 3;
    const p = new Float32Array(cap * 6);
    p.set(this.pos);
    this.pos = p;
    const c = new Uint16Array(cap * 8);
    c.set(this.col);
    this.col = c;
    const t = new Int16Array(cap * 4);
    t.set(this.tile);
    this.tile = t;
  }

  v(x: number, y: number, z: number): void {
    if (this.n * 3 >= this.pos.length) this.grow();
    const n = this.n++;
    const p = n * 3, c = n * 4, t = n * 2;
    this.pos[p] = x;
    this.pos[p + 1] = y;
    this.pos[p + 2] = z;
    this.col[c] = this.r;
    this.col[c + 1] = this.g;
    this.col[c + 2] = this.b;
    this.col[c + 3] = this.h;
    this.tile[t] = this.tx;
    this.tile[t + 1] = this.tz;
  }

  /** Terrain geometry for TileLighting. */
  build(): THREE.BufferGeometry {
    const n = this.n;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('col', new THREE.BufferAttribute(this.col.slice(0, n * 4), 4, true));
    g.setAttribute('tile', new THREE.BufferAttribute(this.tile.slice(0, n * 2), 2));
    return g;
  }

  /** Plain geometry (position + Float32 `color`) for stock materials with vertexColors. */
  buildBasic(): THREE.BufferGeometry {
    const n = this.n;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[i * 3 + k] = this.col[i * 4 + k] / 65535;
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  }
}

/** Accumulates colored line segments into flat arrays for one merged BufferGeometry. */
export class LineBatch {
  protected s = new VertexStore();

  /** Vertices written so far (per-tile ranges for ChunkPool). */
  get count(): number {
    return this.s.n;
  }

  /** Following segments belong to the tile centred at (x, z) (lighting is per tile). */
  at(x: number, z: number): this {
    this.s.tx = Math.round(x * 2);
    this.s.tz = Math.round(z * 2);
    return this;
  }

  color(hex: number, intensity = 1): this {
    this.s.setColor(hex, intensity);
    return this;
  }

  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): this {
    this.s.v(x1, y1, z1);
    this.s.v(x2, y2, z2);
    return this;
  }

  /** Following geometry is unmapped terrain: invisible except under a radar wave. */
  hide(on: boolean): this {
    this.s.h = VIS_U16[on ? Vis.HIDDEN : Vis.VISIBLE];
    return this;
  }

  /** Closed polyline. */
  loop(pts: ReadonlyArray<readonly [number, number, number]>): this {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      this.seg(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    return this;
  }

  /** Axis-aligned wire box. (x,z) is the min corner on the ground. */
  box(x: number, y: number, z: number, w: number, h: number, d: number): this {
    const X = x + w, Y = y + h, Z = z + d;
    this.loop([[x, y, z], [X, y, z], [X, y, Z], [x, y, Z]]);
    this.loop([[x, Y, z], [X, Y, z], [X, Y, Z], [x, Y, Z]]);
    this.seg(x, y, z, x, Y, z).seg(X, y, z, X, Y, z).seg(X, y, Z, X, Y, Z).seg(x, y, Z, x, Y, Z);
    return this;
  }

  /** Wire octahedron centred at (cx, cy, cz). */
  octa(cx: number, cy: number, cz: number, rx: number, ry: number): this {
    const ring: [number, number, number][] = [[cx + rx, cy, cz], [cx, cy, cz + rx], [cx - rx, cy, cz], [cx, cy, cz - rx]];
    this.loop(ring);
    for (const p of ring) this.seg(cx, cy + ry, cz, p[0], p[1], p[2]).seg(cx, cy - ry, cz, p[0], p[1], p[2]);
    return this;
  }

  /** Terrain format (TileLighting). */
  build(): THREE.BufferGeometry {
    return this.s.build();
  }

  /** Position + colour, for LineBasicMaterial({ vertexColors: true }). */
  buildBasic(): THREE.BufferGeometry {
    return this.s.buildBasic();
  }
}

/** Dark opaque fill triangles under the line work (hidden-line look), with per-tile lighting. */
export class FillBatch {
  private s = new VertexStore();

  constructor() {
    this.s.r = this.s.g = this.s.b = 0;
  }

  get count(): number {
    return this.s.n;
  }

  /** `intensity` is perceptual; squared because the output pass converts linear → sRGB. */
  color(hex: number, intensity = 0.12): this {
    this.s.setColor(hex, intensity * intensity * 2.2);
    return this;
  }

  at(x: number, z: number): this {
    this.s.tx = Math.round(x * 2);
    this.s.tz = Math.round(z * 2);
    return this;
  }

  tri(a: V3, b: V3, c: V3): this {
    const s = this.s;
    s.v(a[0], a[1], a[2]);
    s.v(b[0], b[1], b[2]);
    s.v(c[0], c[1], c[2]);
    return this;
  }

  /** See LineBatch.hide. */
  hide(on: boolean): this {
    this.s.h = VIS_U16[on ? Vis.HIDDEN : Vis.VISIBLE];
    return this;
  }
  quad(a: V3, b: V3, c: V3, d: V3): this {
    return this.tri(a, b, c).tri(a, c, d);
  }

  /** Convex polygon fan. */
  poly(pts: ReadonlyArray<V3>): this {
    for (let i = 1; i + 1 < pts.length; i++) this.tri(pts[0], pts[i], pts[i + 1]);
    return this;
  }

  /** Prism side walls between two rings of equal length (bottom, top). */
  band(lo: ReadonlyArray<V3>, hi: ReadonlyArray<V3>): this {
    for (let i = 0; i < lo.length; i++) {
      const j = (i + 1) % lo.length;
      this.quad(lo[i], lo[j], hi[j], hi[i]);
    }
    return this;
  }

  octa(cx: number, cy: number, cz: number, rx: number, ry: number): this {
    const top: V3 = [cx, cy + ry, cz];
    const bot: V3 = [cx, cy - ry, cz];
    const ring: V3[] = [[cx + rx, cy, cz], [cx, cy, cz + rx], [cx - rx, cy, cz], [cx, cy, cz - rx]];
    for (let i = 0; i < 4; i++) {
      const a = ring[i], b = ring[(i + 1) % 4];
      this.tri(top, a, b).tri(bot, b, a);
    }
    return this;
  }

  box(x: number, y: number, z: number, w: number, h: number, d: number): this {
    const X = x + w, Y = y + h, Z = z + d;
    const lo: V3[] = [[x, y, z], [X, y, z], [X, y, Z], [x, y, Z]];
    const hi: V3[] = [[x, Y, z], [X, Y, z], [X, Y, Z], [x, Y, Z]];
    return this.band(lo, hi).poly(hi);
  }

  build(): THREE.BufferGeometry {
    return this.s.build();
  }
}

/** Deterministic 0..1 from a variant byte and a salt (render-only jitter). */
const jit = (variant: number, salt: number) => (((variant * 73 + salt * 151) ^ (variant >> 2)) & 255) / 255;

/** Hexagonal crystal prism with a pointed tip, from `root` along unit `dir`. */
function prism(b: LineBatch, f: FillBatch, color: number, root: THREE.Vector3, dir: THREE.Vector3, r: number, len: number): void {
  const u = new THREE.Vector3(1, 0, 0).cross(dir);
  if (u.lengthSq() < 1e-4) u.set(0, 0, 1).cross(dir);
  u.normalize();
  const v = new THREE.Vector3().crossVectors(dir, u);
  const lo: V3[] = [];
  const hi: V3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const o = u.clone().multiplyScalar(Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r);
    const p = root.clone().add(o);
    lo.push([p.x, p.y, p.z]);
    const q = p.addScaledVector(dir, len);
    hi.push([q.x, q.y, q.z]);
  }
  const t = root.clone().addScaledVector(dir, len + r * 1.6);
  const tip: V3 = [t.x, t.y, t.z];
  f.color(color, 0.3).band(lo, hi);
  for (let i = 0; i < 6; i++) f.tri(hi[i], hi[(i + 1) % 6], tip);
  b.color(color, 1).loop(hi);
  for (let i = 0; i < 6; i++) b.seg(...lo[i], ...hi[i]).seg(...hi[i], ...tip);
}

/** Unexplored tile: a faint survey cross on the corner, no fill. */
export function drawFogTile(b: LineBatch, lx: number, ly: number): void {
  b.at(lx + 0.5, -ly - 0.5).color(0x2a3a52, 0.5).seg(lx - 0.08, 0, -ly, lx + 0.08, 0, -ly).seg(lx, 0, -ly - 0.08, lx, 0, -ly + 0.08);
}

/**
 * v2 tile: lines into `b`, dark fills into `f`. Chunk-local coordinates:
 * tile (lx, ly) covers x∈[lx, lx+1], z∈[-ly-1, -ly].
 *
 * `detail` false (far zoom LOD) leaves out the small stuff that is sub-pixel from far away:
 * corner ticks, sand ripples, pebbles, rock strata, vent smoke.
 */
export function drawTileVec(b: LineBatch, f: FillBatch, shape: TileShape, color: number, lx: number, ly: number, variant: number, detail = true): void {
  const x0 = lx;
  const z0 = -ly - 1;
  const cx = lx + 0.5;
  const cz = -ly - 0.5;
  b.at(cx, cz);
  f.at(cx, cz);
  const ground = (hex: number, fill = 0.09) => {
    b.color(hex, 0.42).seg(x0, 0, z0 + 1, x0 + 1, 0, z0 + 1).seg(x0, 0, z0, x0, 0, z0 + 1);
    // Tiny corner tick so lit cells read as cells even without neighbours.
    if (detail) b.color(hex, 0.6).seg(x0 + 1, 0, z0 + 1, x0 + 0.9, 0, z0 + 1).seg(x0 + 1, 0, z0 + 1, x0 + 1, 0, z0 + 0.9);
    f.color(hex, fill).quad([x0, 0, z0], [x0 + 1, 0, z0], [x0 + 1, 0, z0 + 1], [x0, 0, z0 + 1]);
  };
  switch (shape) {
    case 'floor':
      ground(color);
      // Occasional ripple line in the sand.
      if (detail && (variant & 3) === 0) {
        const o = jit(variant, 1) * 0.5 + 0.25;
        b.color(color, 0.3).seg(x0 + 0.2, 0, z0 + o, x0 + 0.5, 0, z0 + o - 0.06).seg(x0 + 0.5, 0, z0 + o - 0.06, x0 + 0.8, 0, z0 + o);
      }
      break;
    case 'rough': {
      ground(color, 0.1);
      // Three flat stones lying on the ground: low, dim, same hue as the ground.
      for (let k = 0; k < (detail ? 3 : 0); k++) {
        const px = x0 + 0.18 + jit(variant, k * 2 + 3) * 0.64;
        const pz = z0 + 0.18 + jit(variant, k * 2 + 4) * 0.64;
        const r = 0.05 + jit(variant, k + 9) * 0.05;
        const h = r * 0.35;
        const base: V3[] = [];
        const top: V3[] = [];
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + jit(variant, k + i) * 0.8;
          const rr = r * (0.75 + jit(variant, k * 5 + i) * 0.4);
          base.push([px + Math.cos(a) * rr, 0, pz + Math.sin(a) * rr * 0.8]);
          top.push([px + Math.cos(a) * rr * 0.55, h, pz + Math.sin(a) * rr * 0.45]);
        }
        f.color(color, 0.14).band(base, top).poly(top);
        b.color(color, 0.5).loop(top);
        b.color(color, 0.32).loop(base);
      }
      break;
    }
    case 'vent': {
      // Small volcano: rough cone of crust, glowing crater rim, a lava trail and a fume wisp.
      ground(0x7a5a3a);
      const crust = 0x6a4a32;
      const N = 9;
      const h = 0.26 + jit(variant, 1) * 0.08;
      const base: V3[] = [];
      const mid: V3[] = [];
      const rim: V3[] = [];
      const pit: V3[] = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const rb = 0.42 + jit(variant, i) * 0.06;
        const c = Math.cos(a), s = Math.sin(a);
        base.push([cx + c * rb, 0, cz + s * rb]);
        mid.push([cx + c * rb * 0.6, h * 0.55, cz + s * rb * 0.6]);
        rim.push([cx + c * 0.15, h, cz + s * 0.15]);
        pit.push([cx + c * 0.09, h - 0.07, cz + s * 0.09]);
      }
      f.color(crust, 0.2).band(base, mid).band(mid, rim);
      f.color(color, 0.4).band(pit, rim).poly(pit);
      b.color(crust, 0.8).loop(base);
      b.color(crust, 0.5).loop(mid);
      for (let i = 0; i < N; i += 2) b.color(crust, 0.65).seg(...base[i], ...mid[i]).seg(...mid[i], ...rim[i]);
      b.color(color, 1).loop(rim);
      b.color(color, 0.75).loop(pit);
      // Lava trail down one flank (side picked per tile).
      const k = variant % N;
      const kk = (k + 1) % N;
      const lm: V3 = [(mid[k][0] + mid[kk][0]) / 2, mid[k][1], (mid[k][2] + mid[kk][2]) / 2];
      const lb: V3 = [(base[k][0] + base[kk][0]) / 2, 0.005, (base[k][2] + base[kk][2]) / 2];
      b.color(color, 0.85).seg(...rim[k], ...lm).seg(...lm, ...lb);
      // Fume wisp above the crater.
      if (detail) b.color(color, 0.35).seg(cx, h, cz, cx + 0.04, h + 0.18, cz - 0.03).seg(cx + 0.04, h + 0.18, cz - 0.03, cx - 0.02, h + 0.34, cz - 0.06);
      break;
    }
    case 'wall': {
      // Irregular rock block: 6-sided footprint, inset top, strata lines on the sides.
      const h = 0.62 + (variant % 5) * 0.09;
      const lo: V3[] = [];
      const hi: V3[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        const r = 0.5 + jit(variant, i) * 0.12;
        const ox = Math.max(-0.48, Math.min(0.48, Math.cos(a) * r));
        const oz = Math.max(-0.48, Math.min(0.48, Math.sin(a) * r));
        lo.push([cx + ox, 0, cz + oz]);
        const t = 0.72 + jit(variant, i + 6) * 0.12;
        hi.push([cx + ox * t, h * (0.9 + jit(variant, i + 12) * 0.12), cz + oz * t]);
      }
      f.color(color, 0.1).band(lo, hi).poly(hi);
      b.color(color, 0.95).loop(lo).loop(hi);
      for (let i = 0; i < 6; i++) b.seg(lo[i][0], lo[i][1], lo[i][2], hi[i][0], hi[i][1], hi[i][2]);
      // Strata: rings between bottom and top.
      for (const s of detail ? [0.33, 0.62] : []) {
        const ring = lo.map((p, i): V3 => [p[0] + (hi[i][0] - p[0]) * s, hi[i][1] * s, p[2] + (hi[i][2] - p[2]) * s]);
        b.color(color, 0.4).loop(ring);
      }
      b.color(color, 0.55).seg(hi[0][0], hi[0][1], hi[0][2], hi[3][0], hi[3][1], hi[3][2]);
      break;
    }
    case 'crystal': {
      // Partially buried crystal cluster: hexagonal prisms jutting out of a sand drift at
      // angles; their roots start below the surface, so the ground hides them.
      ground(0x7a5a3a);
      const drift: V3[] = [];
      const driftTop: V3[] = [];
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const r = 0.36 + jit(variant, i) * 0.07;
        drift.push([cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r]);
        driftTop.push([cx + Math.cos(a) * r * 0.55, 0.05, cz + Math.sin(a) * r * 0.55]);
      }
      f.color(0x7a5a3a, 0.16).band(drift, driftTop).poly(driftTop);
      b.color(0x7a5a3a, 0.55).loop(drift);
      b.color(0x7a5a3a, 0.4).loop(driftTop);
      const spin = jit(variant, 3) * Math.PI * 2;
      // [offset angle, offset radius, tilt, length, radius]
      const shards: [number, number, number, number, number][] = [
        [0, 0.02, 0.18, 0.5, 0.085],
        [1.9, 0.17, 0.62, 0.3, 0.06],
        [3.8, 0.16, 0.7, 0.24, 0.05],
        [5.3, 0.2, 0.8, 0.22, 0.045],
      ];
      for (const [oa, or, tilt, len, r] of shards) {
        const a = oa + spin;
        const ox = Math.cos(a), oz = Math.sin(a);
        // Leans away from the cluster centre.
        const dir = new THREE.Vector3(ox * Math.sin(tilt), Math.cos(tilt), oz * Math.sin(tilt));
        const root = new THREE.Vector3(cx + ox * or, -0.12, cz + oz * or);
        prism(b, f, color, root, dir, r, len + 0.12);
      }
      break;
    }
    case 'mound': {
      // Rough ore mound: a lumpy main heap and a smaller one, with glinting ore nodules.
      ground(0x7a5a3a);
      const crust = 0x8a4a3a;
      const heap = (hx: number, hz: number, rb: number, h: number, salt: number) => {
        const N = 8;
        const rings: V3[][] = [[], [], []];
        const lv = [0, 0.5, 0.85];
        const rr = [1, 0.72, 0.38];
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2 + jit(variant, salt) * 0.6;
          for (let k = 0; k < 3; k++) {
            const r = rb * rr[k] * (0.8 + jit(variant, salt + i * 3 + k) * 0.35);
            rings[k].push([hx + Math.cos(a) * r, h * lv[k] * (k ? 0.85 + jit(variant, salt + i + 20) * 0.3 : 1), hz + Math.sin(a) * r]);
          }
        }
        const peak: V3 = [hx + (jit(variant, salt + 40) - 0.5) * rb * 0.3, h, hz + (jit(variant, salt + 41) - 0.5) * rb * 0.3];
        f.color(crust, 0.14).band(rings[0], rings[1]).band(rings[1], rings[2]);
        for (let i = 0; i < N; i++) f.tri(rings[2][i], rings[2][(i + 1) % N], peak);
        b.color(crust, 0.85).loop(rings[0]);
        b.color(crust, 0.55).loop(rings[1]).loop(rings[2]);
        for (let i = 0; i < N; i += 2) b.color(crust, 0.6).seg(...rings[0][i], ...rings[1][i]).seg(...rings[1][i], ...rings[2][i]).seg(...rings[2][i], ...peak);
        return rings;
      };
      const main = heap(cx - 0.04, cz + 0.02, 0.4, 0.34 + jit(variant, 2) * 0.08, 5);
      const small = heap(cx + 0.27, cz - 0.24, 0.17, 0.16, 60);
      // Ore nodules sitting on the flanks.
      for (const p of [main[1][1], main[1][4], main[2][6], small[1][2]]) {
        f.color(color, 0.4).octa(p[0], p[1] + 0.02, p[2], 0.045, 0.04);
        b.color(color, 1).octa(p[0], p[1] + 0.02, p[2], 0.045, 0.04);
      }
      // A bright vein streak down the main heap.
      b.color(color, 0.9).seg(...main[2][3], ...main[1][3]).seg(...main[1][3], ...main[0][2]);
      break;
    }
    case 'crate': {
      f.color(0xffffff, 0.12).box(cx - 0.2, 0, cz - 0.2, 0.4, 0.3, 0.4);
      b.color(color, 0.95).box(cx - 0.2, 0, cz - 0.2, 0.4, 0.3, 0.4);
      b.color(0xff4040, 1).seg(cx - 0.11, 0.305, cz, cx + 0.11, 0.305, cz).seg(cx, 0.305, cz - 0.11, cx, 0.305, cz + 0.11);
      break;
    }
    case 'sample': {
      f.color(color, 0.3).octa(cx, 0.16, cz, 0.13, 0.16);
      b.color(color, 1).octa(cx, 0.16, cz, 0.13, 0.16);
      const ring: V3[] = [];
      for (let i = 0; i < 12; i++) ring.push([cx + Math.cos((i / 12) * Math.PI * 2) * 0.26, 0.005, cz + Math.sin((i / 12) * Math.PI * 2) * 0.26]);
      b.color(color, 0.45).loop(ring);
      break;
    }
    case 'supply': {
      f.color(color, 0.14).box(cx - 0.25, 0, cz - 0.25, 0.5, 0.35, 0.5);
      b.color(color, 1).box(cx - 0.25, 0, cz - 0.25, 0.5, 0.35, 0.5);
      b.color(color, 0.6).seg(cx - 0.25, 0.35, cz - 0.25, cx + 0.25, 0, cz + 0.25).seg(cx + 0.25, 0.35, cz - 0.25, cx - 0.25, 0, cz + 0.25);
      b.color(0xffffff, 0.8).seg(cx, 0.35, cz, cx, 0.9, cz);
      b.color(0xff5a4a, 1).octa(cx, 0.95, cz, 0.06, 0.06);
      // Collapsed parachute lying next to the crate.
      const chute: V3[] = [[cx + 0.3, 0.01, cz + 0.45], [cx + 0.7, 0.01, cz + 0.2], [cx + 0.62, 0.01, cz + 0.62]];
      b.color(0xffffff, 0.35).loop(chute);
      f.color(0xffffff, 0.06).tri(chute[0], chute[1], chute[2]);
      break;
    }
    case 'rover':
      break;
  }
}

// ----------------------------------------------------------------------------- symbolic (preview)

/** Neighbour mask bits for `drawTileSym` ridges: same-shape neighbour to the N, E, S, W. */
export const RIDGE = { N: 1, E: 2, S: 4, W: 8 } as const;

/**
 * Symbolic tile style (preview only, `?style=symbolic`): the map as an orbital scan read
 * through a legend, not scenery. Low 3D symbols that say what matters for driving:
 * passable / slow / hazard / obstacle / drillable / pickup.
 * - wall: pyramid; `ridge` (RIDGE bits) joins neighbouring walls into a mountain range
 * - rough: 3 flat hatch strokes (scree on a topographic map)
 * - mound / crystal: deposit sunk into the ground (dark pit) with its marker half buried
 *   (diamond / hex crystal); nothing floats
 * - vent: hazard rings around a glowing pit
 * Faces of pyramids are shaded by direction so they read in the top-down view too.
 */
export function drawTileSym(b: LineBatch, f: FillBatch, shape: TileShape, color: number, lx: number, ly: number, variant: number, ridge = 0): void {
  const x0 = lx;
  const z0 = -ly - 1;
  const cx = lx + 0.5;
  const cz = -ly - 0.5;
  b.at(cx, cz);
  f.at(cx, cz);
  const ground = (hex: number, fill = 0.09) => {
    b.color(hex, 0.42).seg(x0, 0, z0 + 1, x0 + 1, 0, z0 + 1).seg(x0, 0, z0, x0, 0, z0 + 1);
    b.color(hex, 0.6).seg(x0 + 1, 0, z0 + 1, x0 + 0.9, 0, z0 + 1).seg(x0 + 1, 0, z0 + 1, x0 + 1, 0, z0 + 0.9);
    f.color(hex, fill).quad([x0, 0, z0], [x0 + 1, 0, z0], [x0 + 1, 0, z0 + 1], [x0, 0, z0 + 1]);
  };
  /** Face fill by side (N, E, S, W): a fixed "sun" from the south-east. */
  const SHADE = [0.55, 1.15, 1, 0.7];
  /**
   * Square pyramid. `inset` from the tile edge, `h` peak height, `ridges` sides joined to a
   * saddle on the shared edge. Returns the peak.
   */
  const pyramid = (edge: number, edgeK: number, fill: number, inset: number, h: number, ridges = 0): V3 => {
    const a = x0 + inset, A = x0 + 1 - inset, c = z0 + inset, C = z0 + 1 - inset;
    const corners: V3[] = [[a, 0, c], [A, 0, c], [A, 0, C], [a, 0, C]];
    const peak: V3 = [cx + (jit(variant, 1) - 0.5) * 0.16 * (1 - 2 * inset), h, cz + (jit(variant, 2) - 0.5) * 0.16 * (1 - 2 * inset)];
    const HS = 0.38;
    const saddle: V3[] = [[cx, HS, z0], [x0 + 1, HS, cz], [cx, HS, z0 + 1], [x0, HS, cz]];
    for (let i = 0; i < 4; i++) {
      const p = corners[i], q = corners[(i + 1) % 4];
      f.color(edge, fill * SHADE[i]);
      if (ridges & (1 << i)) {
        f.tri(p, saddle[i], peak).tri(saddle[i], q, peak);
        b.color(edge, edgeK).seg(...peak, ...saddle[i]);
      } else {
        f.tri(p, q, peak);
        b.color(edge, edgeK * 0.7).seg(...p, ...q);
      }
      // Slope edge down to the corner, unless the corner is inside a range (ridges on both
      // sides): those valley lines turned a massif into an egg crate.
      const inner = ridges & (1 << i) && ridges & (1 << ((i + 3) % 4));
      if (!inner) b.color(edge, edgeK).seg(...p, ...peak);
    }
    return peak;
  };
  /**
   * Opening of a sunken deposit: near-black fill (darker than any ground, so it reads as a
   * hole), lit rim in the ore colour, a dim inner rim shifted to the far wall for depth.
   * Lies a hair above the terrain, hiding what is below ground (buried parts of markers).
   */
  const pit = (hex: number) => {
    const rim: V3[] = [];
    const wall: V3[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const r = 0.36 + (jit(variant, i) - 0.5) * 0.06;
      rim.push([cx + Math.cos(a) * r, 0.004, cz + Math.sin(a) * r]);
      wall.push([cx + Math.cos(a) * r * 0.72, 0.005, cz - 0.05 + Math.sin(a) * r * 0.72]);
    }
    f.color(hex, 0.03).poly(rim);
    b.color(hex, 0.75).loop(rim);
    b.color(hex, 0.3).loop(wall);
  };
  switch (shape) {
    case 'floor':
      ground(color);
      break;
    case 'rough': {
      ground(color, 0.1);
      // Three short parallel strokes lying flat, like scree hatching on a map.
      b.color(color, 0.55);
      for (let k = 0; k < 3; k++) {
        const px = x0 + 0.22 + jit(variant, k * 2 + 3) * 0.56;
        const pz = z0 + 0.22 + jit(variant, k * 2 + 4) * 0.56;
        b.seg(px - 0.07, 0.002, pz + 0.07, px + 0.07, 0.002, pz - 0.07);
      }
      break;
    }
    case 'vent': {
      // Hazard: outer warning ring, inner rim, glowing pit.
      ground(0x7a5a3a);
      const ring = (r: number, n: number, y: number): V3[] => {
        const out: V3[] = [];
        for (let i = 0; i < n; i++) out.push([cx + Math.cos((i / n) * Math.PI * 2) * r, y, cz + Math.sin((i / n) * Math.PI * 2) * r]);
        return out;
      };
      const outer = ring(0.4, 12, 0.003);
      const inner = ring(0.22, 8, 0.006);
      const pit = ring(0.11, 6, 0.008);
      b.color(color, 0.5).loop(outer);
      b.color(color, 0.9).loop(inner);
      f.color(color, 0.25).poly(inner);
      f.color(color, 0.6).poly(pit);
      break;
    }
    case 'wall':
      pyramid(color, 0.95, 0.12, 0.03, 0.45 + (variant % 5) * 0.08, ridge);
      break;
    case 'mound': {
      // Deposit sunk into the ground: dark pit, ore diamond half buried in it.
      pit(color);
      f.color(color, 0.45).octa(cx, 0, cz, 0.15, 0.17);
      b.color(color, 1).octa(cx, 0, cz, 0.15, 0.17);
      break;
    }
    case 'crystal': {
      // Deposit sunk into the ground: dark pit, a hexagonal crystal breaking the surface.
      pit(color);
      prism(b, f, color, new THREE.Vector3(cx, -0.15, cz), new THREE.Vector3(0, 1, 0), 0.08, 0.27);
      break;
    }
    default:
      // Pickups are already simple symbols.
      drawTileVec(b, f, shape, color, lx, ly, variant);
  }
}

// ----------------------------------------------------------------------------- rover v2

/**
 * Filled dark body + bright edges. Returns the group and its edge material (for tinting).
 * Pass `sharedEdge` to use one material for several parts (tinted together, merged into
 * one draw call by mergeStatic).
 */
function vectorPart(geo: THREE.BufferGeometry, edge: number, fill = 0x09131f, edgeOpacity = 1, side: THREE.Side = THREE.FrontSide, sharedEdge?: THREE.LineBasicMaterial): { obj: THREE.Group; edgeMat: THREE.LineBasicMaterial; fillMat: THREE.MeshBasicMaterial } {
  const obj = new THREE.Group();
  const fillMat = new THREE.MeshBasicMaterial({ color: fill, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  obj.add(new THREE.Mesh(geo, fillMat));
  const edgeMat = sharedEdge ?? new THREE.LineBasicMaterial({ color: edge, transparent: edgeOpacity < 1, opacity: edgeOpacity });
  obj.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), edgeMat));
  return { obj, edgeMat, fillMat };
}

function wireOnly(geo: THREE.BufferGeometry, color: number, opacity = 1): { obj: THREE.LineSegments; mat: THREE.LineBasicMaterial } {
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  return { obj: new THREE.LineSegments(new THREE.WireframeGeometry(geo), mat), mat };
}

/** One solar panel segment spanning x∈[0, w] from its hinge, with a 2×4 cell grid. */
function solarSegment(w: number, length: number, color: number, edgeMat: THREE.LineBasicMaterial): THREE.Group {
  const seg = new THREE.Group();
  const box = new THREE.BoxGeometry(w - 0.02, 0.03, length);
  box.translate(w / 2, 0, 0);
  const PANEL = 0x061626;
  const frame = vectorPart(box, color, PANEL, 1, THREE.FrontSide, edgeMat);
  seg.add(frame.obj);
  const pts: number[] = [];
  for (const side of [0.017, -0.017]) {
    pts.push(w / 2, side, -length / 2, w / 2, side, length / 2);
    for (let r = 1; r < 4; r++) {
      const z = -length / 2 + (length / 4) * r;
      pts.push(0.01, side, z, w - 0.01, side, z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  // Cell grid: 60% over the dark panel, pre-blended (linear) so it can be opaque and merge
  // with the hinge pin into one draw call.
  const grid = new THREE.Color(color).multiplyScalar(0.6).add(new THREE.Color(PANEL).multiplyScalar(0.4));
  seg.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: grid })));
  // Hinge pin along the inner edge.
  const pin = new THREE.BufferGeometry();
  pin.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -length / 2 - 0.03, 0, 0, length / 2 + 0.03], 3));
  seg.add(new THREE.LineSegments(pin, new THREE.LineBasicMaterial({ color: ROVER_AMBER })));
  return seg;
}

/** Segments per solar wing (accordion fold). */
export const SOLAR_SEGMENTS = 3;

/**
 * Seven-segment patterns for hex digits 0–F, bits a..g = 0..6 (a top, b upper right,
 * c lower right, d bottom, e lower left, f upper left, g middle). b and d are lower case.
 */
export const SEVEN_SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];
/** @POST display colours: lit LED segment, unlit (ghost) segment. */
export const POST_LIT = 0xff4a1c;
export const POST_DARK = 0x2a0e08;

export const ROVER_AMBER = 0xf59e0b;
export const ROVER_CYAN = 0x38bdf8;

/** Indices into `RoverRigMesh.lamps`. */
export const LAMP = { IND: 0, BEACON: 3, HEAD: 4, POST: 5 } as const;

/** Parts of the v2 rover the animator drives. Faces -Z (north) at rotation 0, 1 tile ≈ 1 unit. */
export interface RoverRigMesh {
  /** Root: position + heading. Unscaled (tile units). */
  group: THREE.Group;
  /** Scaled model; scale up when zoomed far out so the rover stays readable. */
  model: THREE.Group;
  wheels: THREE.Group[];
  cpuCore: THREE.Object3D;
  cpuMat: THREE.LineBasicMaterial;
  /** Turntable carrying both wings; rotate to the panel bearing. */
  solarMount: THREE.Group;
  /** One per side, on the hinge rail; tilt (rotation.x) toward the sun. Left side is mirrored. */
  solarSides: THREE.Group[];
  /** Per side, SOLAR_SEGMENTS hinge joints (rotation.z), from the rail outward. */
  solarJoints: THREE.Group[][];
  solarMats: THREE.LineBasicMaterial[];
  dish: THREE.Group;
  dishMats: THREE.LineBasicMaterial[];
  /**
   * All small coloured parts in one mesh, indexed by `LAMP`: indicator lenses (@IND1..3,
   * left to right), status LED, headlight bar, then (if built) the 14 @POST segments,
   * digit-major (high digit first), a..g.
   */
  lamps: ColorCells;
  /** True when the @POST display was built. */
  hasPost: boolean;
  /** Ground beam (tile units, not scaled with the model). */
  beam: THREE.Group;
  beamMats: THREE.Material[];
  drillBit: THREE.Group;
  drillGlow: THREE.LineBasicMaterial;
  drillRing: THREE.LineLoop;
  sparks: THREE.LineSegments;
  /** Sensor-range ring (unit radius, scale to range). Not parented to the rotating group. */
  sensorRing: THREE.LineLoop;
}

/** Detailed v2 rover: amber wedge hull, cyan cabin, three-segment folding solar wings, dish, LED, drill. */
export function buildRoverRig(opts: { post?: boolean } = {}): RoverRigMesh {
  const group = new THREE.Group();
  const model = new THREE.Group();
  const S = 0.55; // reference model is ~1.8 units long; fit it into one tile
  const body = new THREE.Group();
  body.scale.setScalar(S);
  model.add(body);
  group.add(model);

  const lower = vectorPart(new THREE.BoxGeometry(1.05, 0.42, 1.45), ROVER_AMBER);
  lower.obj.position.y = 0.48;
  body.add(lower.obj);
  const cabin = vectorPart(new THREE.BoxGeometry(0.84, 0.34, 0.95), ROVER_CYAN);
  cabin.obj.position.set(0, 0.82, 0.08);
  body.add(cabin.obj);
  const noseGeo = new THREE.CylinderGeometry(0.42, 0.52, 0.48, 4);
  noseGeo.rotateY(Math.PI / 4);
  const nose = vectorPart(noseGeo, ROVER_AMBER);
  nose.obj.position.set(0, 0.76, -0.45);
  body.add(nose.obj);

  // Spinning vMCU core visible through the cabin (colour = CPU state).
  const core = wireOnly(new THREE.CylinderGeometry(0.22, 0.22, 0.36, 8, 1), ROVER_CYAN, 0.9);
  core.obj.position.set(0, 0.84, 0.08);
  body.add(core.obj);

  // Wheels: a hub group per wheel so it can spin about X.
  const wheels: THREE.Group[] = [];
  for (const [wx, wz] of [[-0.66, -0.48], [0.66, -0.48], [-0.66, 0.48], [0.66, 0.48]]) {
    const hub = new THREE.Group();
    hub.position.set(wx, 0.28, wz);
    const wg = new THREE.CylinderGeometry(0.28, 0.28, 0.22, 10);
    wg.rotateZ(Math.PI / 2);
    const w = vectorPart(wg, ROVER_CYAN, 0x071019);
    hub.add(w.obj);
    // Spokes so the rotation is visible.
    const sp: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      const side = wx < 0 ? -0.115 : 0.115;
      sp.push(side, Math.cos(a) * 0.26, Math.sin(a) * 0.26, side, -Math.cos(a) * 0.26, -Math.sin(a) * 0.26);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    hub.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: ROVER_CYAN })));
    body.add(hub);
    wheels.push(hub);
  }

  // Solar wings: three-segment accordion panels hinged on side rails above the wheels.
  // Stowed they hang folded against the flank; deployed they open flat outward.
  const solarMount = new THREE.Group();
  solarMount.position.set(0, 0.72, 0.06);
  body.add(solarMount);
  // One edge material for all segments: tinted together by damage, merged per joint.
  const solarEdge = new THREE.LineBasicMaterial({ color: 0x5a7dff });
  const solarSides: THREE.Group[] = [];
  const solarJoints: THREE.Group[][] = [];
  const SEG_W = 0.42, SEG_L = 1.1, RAIL_X = 0.82;
  for (const side of [-1, 1]) {
    const sideGroup = new THREE.Group();
    sideGroup.position.set(side * RAIL_X, 0, 0);
    sideGroup.scale.x = side; // build the right wing, mirror for the left
    // Rail + support arm back to the hull.
    const rail = vectorPart(new THREE.BoxGeometry(0.05, 0.05, SEG_L + 0.08), ROVER_AMBER);
    sideGroup.add(rail.obj);
    const arm = vectorPart(new THREE.BoxGeometry(RAIL_X - 0.5, 0.04, 0.12).translate(-(RAIL_X - 0.5) / 2, -0.02, 0), ROVER_AMBER);
    sideGroup.add(arm.obj);
    const joints: THREE.Group[] = [];
    let parent: THREE.Object3D = sideGroup;
    for (let i = 0; i < SOLAR_SEGMENTS; i++) {
      const joint = new THREE.Group();
      if (i > 0) joint.position.x = SEG_W;
      joint.add(solarSegment(SEG_W, SEG_L, 0x5a7dff, solarEdge));
      parent.add(joint);
      parent = joint;
      joints.push(joint);
    }
    solarMount.add(sideGroup);
    solarSides.push(sideGroup);
    solarJoints.push(joints);
  }

  // Dorsal dish on a turntable.
  const dish = new THREE.Group();
  dish.position.set(0, 1.0, 0.3);
  // Mast, dish and feed share one edge material (tinted by dish damage, one draw call).
  const dishEdge = new THREE.LineBasicMaterial({ color: 0x3affc8 });
  const mast = vectorPart(new THREE.CylinderGeometry(0.04, 0.07, 0.26, 6), ROVER_CYAN, undefined, 1, THREE.FrontSide, dishEdge);
  mast.obj.position.y = 0.13;
  dish.add(mast.obj);
  // Solid parabolic dish (opaque, ribbed), facing local -Z and up.
  const profile = [0, 0.1, 0.2, 0.28, 0.35].map((r) => new THREE.Vector2(r, r * r * 0.9));
  const dishGeo = new THREE.LatheGeometry(profile, 12);
  dishGeo.rotateX(-Math.PI / 3);
  const cone = vectorPart(dishGeo, 0x3affc8, 0x08201c, 1, THREE.DoubleSide, dishEdge);
  cone.obj.position.set(0, 0.3, 0.02);
  dish.add(cone.obj);
  const feed = vectorPart(new THREE.OctahedronGeometry(0.05, 0), 0x3affc8, undefined, 1, THREE.FrontSide, dishEdge);
  feed.obj.position.set(0, 0.44, -0.22);
  dish.add(feed.obj);
  body.add(dish);

  // Coloured parts, collected in LAMP order and merged into one ColorCells mesh below.
  const lampParts: THREE.Mesh[] = [];

  // Headlight bar on the nose.
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.06), new THREE.MeshBasicMaterial({ color: 0x1e293b }));
  lamp.position.set(0, 0.56, -0.74);
  body.add(lamp);

  // Status LED crystal.
  const led = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), new THREE.MeshBasicMaterial({ color: LIGHT_HEX[2] }));
  led.position.set(-0.28, 1.08, -0.2);
  body.add(led);

  // Indicator lamp bar on the cabin roof, in front of the dish: three lenses in housings.
  const bar = vectorPart(new THREE.BoxGeometry(0.5, 0.04, 0.14), 0x64748b);
  bar.obj.position.set(0.1, 1.01, -0.22);
  body.add(bar.obj);
  for (let i = 0; i < 3; i++) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.07, 8), new THREE.MeshBasicMaterial({ color: indicatorHex(0) }));
    lens.position.set(-0.05 + i * 0.15, 1.065, -0.22);
    body.add(lens);
    const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 8)), new THREE.LineBasicMaterial({ color: 0x64748b }));
    rim.position.set(-0.05 + i * 0.15, 1.04, -0.22);
    body.add(rim);
    lampParts.push(lens);
  }
  lampParts.push(led, lamp);

  // @POST display: two seven-segment digits on a bezel at the back of the cabin, tilted up
  // so it reads from the usual orbit camera behind and above the rover.
  if (opts.post) {
    const panel = new THREE.Group();
    panel.position.set(0, 0.82, 0.575);
    panel.rotation.x = -0.45;
    body.add(panel);
    const bezel = vectorPart(new THREE.BoxGeometry(0.38, 0.26, 0.03), 0x64748b, 0x05080d);
    panel.add(bezel.obj);
    const W = 0.1, H = 0.18, T = 0.024;
    const segs: [number, number, boolean][] = [
      [0, H / 2, true], [W / 2, H / 4, false], [W / 2, -H / 4, false], [0, -H / 2, true],
      [-W / 2, -H / 4, false], [-W / 2, H / 4, false], [0, 0, true],
    ];
    for (const dx of [-0.075, 0.075]) {
      for (const [sx, sy, horiz] of segs) {
        const seg = new THREE.Mesh(new THREE.PlaneGeometry(horiz ? W - T : T, horiz ? T : H / 2 - T), new THREE.MeshBasicMaterial({ color: POST_DARK }));
        // Slight italic slant, like a real LED display.
        seg.position.set(dx + sx + sy * 0.12, sy, 0.017);
        seg.rotation.z = -0.12 * (horiz ? 0 : 1);
        panel.add(seg);
        lampParts.push(seg);
      }
    }
  }

  // Ventral drill.
  const drillBit = new THREE.Group();
  drillBit.position.set(0, 0.3, -0.1);
  const bitGeo = new THREE.ConeGeometry(0.12, 0.3, 6, 1);
  bitGeo.rotateX(Math.PI);
  const bit = vectorPart(bitGeo, 0xff8a3a, 0x1a0c04);
  drillBit.add(bit.obj);
  body.add(drillBit);
  const drillGlow = new THREE.LineBasicMaterial({ color: 0xff8a3a, transparent: true, opacity: 0 });
  const ringPts: THREE.Vector3[] = [];
  for (let i = 0; i < 20; i++) ringPts.push(new THREE.Vector3(Math.cos((i / 20) * Math.PI * 2) * 0.22, 0.01, Math.sin((i / 20) * Math.PI * 2) * 0.22));
  const drillRing = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts), drillGlow);
  drillRing.position.set(0, 0, -0.055);
  model.add(drillRing);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24 * 6), 3));
  const sparks = new THREE.LineSegments(sparkGeo, new THREE.LineBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.9 }));
  sparks.frustumCulled = false;
  sparks.visible = false;
  model.add(sparks);

  // Ground headlight beam: translucent wedge + outline, 5 tiles long.
  const beam = new THREE.Group();
  const bw = new THREE.BufferGeometry();
  const L = 5.2;
  bw.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.02, -0.4, -2.4, 0.02, -L, 2.4, 0.02, -L], 3));
  const beamFill = new THREE.MeshBasicMaterial({ color: 0xe0f2fe, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide });
  beam.add(new THREE.Mesh(bw, beamFill));
  const hl = new LineBatch().color(0xfff2b0, 0.8);
  hl.seg(-0.12, 0.3, -0.42, -2.4, 0.02, -L).seg(0.12, 0.3, -0.42, 2.4, 0.02, -L);
  const beamLines = lines(hl, { transparent: true, opacity: 0.35 });
  beam.add(beamLines);
  beam.visible = false;
  group.add(beam);

  const rp: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) rp.push(new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), 0.01, Math.sin((i / 64) * Math.PI * 2)));
  const sensorRing = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(rp),
    new THREE.LineDashedMaterial({ color: 0x3affc8, transparent: true, opacity: 0.25, dashSize: 0.3, gapSize: 0.25 }),
  );
  sensorRing.computeLineDistances();

  // Draw-call reduction: lamps into one recolourable mesh, then every rigid node's static
  // parts into one fill + one line mesh (88 -> ~40 draw calls per rover).
  const lamps = new ColorCells(body, lampParts);
  mergeStatic(body, new Set<THREE.Object3D>([...wheels, solarMount, dish, drillBit, core.obj]));
  for (const hub of wheels) mergeStatic(hub, new Set());
  for (let i = 0; i < solarSides.length; i++) {
    const joints = solarJoints[i];
    mergeStatic(solarSides[i], new Set([joints[0]]));
    joints.forEach((j, k) => mergeStatic(j, new Set(joints.slice(k + 1, k + 2)), new Set([solarEdge])));
  }
  mergeStatic(dish, new Set(), new Set([dishEdge]));
  mergeStatic(drillBit, new Set());

  return {
    group,
    model,
    wheels,
    cpuCore: core.obj,
    cpuMat: core.mat,
    solarMount,
    solarSides,
    solarJoints,
    solarMats: [solarEdge],
    dish,
    dishMats: [dishEdge],
    lamps,
    hasPost: !!opts.post,
    beam,
    beamMats: [beamFill, beamLines.material as THREE.Material],
    drillBit,
    drillGlow,
    drillRing,
    sparks,
    sensorRing,
  };
}
