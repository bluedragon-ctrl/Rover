import * as THREE from 'three';
import type { TileShape } from '../core/WorldRegistry';

/** Accumulates colored line segments into flat arrays for one merged BufferGeometry. */
export class LineBatch {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  /** Per-vertex tile centre (x, z) for TileLighting. */
  readonly tile: number[] = [];
  private r = 1;
  private g = 1;
  private b = 1;
  private tx = 0;
  private tz = 0;

  /** Following segments belong to the tile centred at (x, z) (lighting is per tile). */
  at(x: number, z: number): this {
    this.tx = x;
    this.tz = z;
    return this;
  }

  color(hex: number, intensity = 1): this {
    this.r = (((hex >> 16) & 255) / 255) * intensity;
    this.g = (((hex >> 8) & 255) / 255) * intensity;
    this.b = ((hex & 255) / 255) * intensity;
    return this;
  }

  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): this {
    this.pos.push(x1, y1, z1, x2, y2, z2);
    this.col.push(this.r, this.g, this.b, this.r, this.g, this.b);
    this.tile.push(this.tx, this.tz, this.tx, this.tz);
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
    const top: [number, number, number] = [cx, cy + ry, cz];
    const bot: [number, number, number] = [cx, cy - ry, cz];
    const ring: [number, number, number][] = [[cx + rx, cy, cz], [cx, cy, cz + rx], [cx - rx, cy, cz], [cx, cy, cz - rx]];
    this.loop(ring);
    for (const p of ring) this.seg(top[0], top[1], top[2], p[0], p[1], p[2]).seg(bot[0], bot[1], bot[2], p[0], p[1], p[2]);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('tile', new THREE.Float32BufferAttribute(this.tile, 2));
    return g;
  }
}

/**
 * Draw one tile in chunk-local space. Tile (lx, ly) covers x∈[lx, lx+1], z∈[-ly-1, -ly].
 * World north (+Y) maps to Three.js -Z.
 */
export function drawTile(b: LineBatch, shape: TileShape, color: number, lx: number, ly: number, variant: number): void {
  const x0 = lx;
  const z0 = -ly - 1; // south edge is z = -ly, north edge z = -ly-1
  const cx = lx + 0.5;
  const cz = -ly - 0.5;
  switch (shape) {
    case 'floor':
      b.color(color, 0.42).seg(x0, 0, z0 + 1, x0 + 1, 0, z0 + 1).seg(x0, 0, z0, x0, 0, z0 + 1);
      break;
    case 'rough': {
      b.color(color, 0.42).seg(x0, 0, z0 + 1, x0 + 1, 0, z0 + 1).seg(x0, 0, z0, x0, 0, z0 + 1);
      // A couple of tiny pebbles, position varies per tile.
      const ox = ((variant & 7) - 3.5) * 0.06;
      const oz = (((variant >> 3) & 7) - 3.5) * 0.06;
      b.color(color, 0.55)
        .seg(cx + ox - 0.06, 0, cz + oz, cx + ox + 0.06, 0.05, cz + oz)
        .seg(cx - ox - 0.04, 0, cz - oz + 0.1, cx - ox + 0.04, 0.04, cz - oz + 0.1);
      break;
    }
    case 'vent': {
      b.color(0x7a5a3a, 0.42).seg(x0, 0, z0 + 1, x0 + 1, 0, z0 + 1).seg(x0, 0, z0, x0, 0, z0 + 1);
      const ring: [number, number, number][] = [];
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ring.push([cx + Math.cos(a) * 0.32, 0.01, cz + Math.sin(a) * 0.32]);
      }
      b.color(color, 1).loop(ring);
      b.color(color, 0.7).seg(cx, 0, cz, cx + 0.05, 0.35, cz - 0.05).seg(cx + 0.1, 0, cz + 0.1, cx + 0.05, 0.25, cz + 0.12);
      break;
    }
    case 'wall': {
      const h = 0.7 + (variant % 5) * 0.08;
      b.color(color, 0.95).box(x0 + 0.04, 0, z0 + 0.04, 0.92, h, 0.92);
      b.color(color, 0.5).seg(x0 + 0.04, h, z0 + 0.04, x0 + 0.96, h, z0 + 0.96);
      break;
    }
    case 'crystal':
      b.color(color, 1).octa(cx, 0.4, cz, 0.3, 0.38);
      b.color(color, 0.6).octa(cx + 0.22, 0.18, cz + 0.18, 0.1, 0.17);
      break;
    case 'crate':
      b.color(color, 0.95).box(cx - 0.18, 0, cz - 0.18, 0.36, 0.28, 0.36);
      b.color(0xff4040, 1).seg(cx - 0.1, 0.29, cz, cx + 0.1, 0.29, cz).seg(cx, 0.29, cz - 0.1, cx, 0.29, cz + 0.1);
      break;
    case 'sample':
      b.color(color, 1).octa(cx, 0.15, cz, 0.13, 0.15);
      break;
    case 'supply': {
      // Crate with a collapsed parachute and a beacon mast.
      b.color(color, 1).box(cx - 0.25, 0, cz - 0.25, 0.5, 0.35, 0.5);
      b.color(color, 0.6).seg(cx - 0.25, 0.35, cz - 0.25, cx + 0.25, 0, cz + 0.25).seg(cx + 0.25, 0.35, cz - 0.25, cx - 0.25, 0, cz + 0.25);
      b.color(0xffffff, 0.8).seg(cx, 0.35, cz, cx, 0.9, cz);
      b.color(0xff5a4a, 1).octa(cx, 0.95, cz, 0.06, 0.06);
      b.color(0xffffff, 0.35).loop([[cx + 0.3, 0.01, cz + 0.45], [cx + 0.7, 0.01, cz + 0.2], [cx + 0.55, 0.01, cz + 0.6]]);
      break;
    }
    case 'rover':
      break;
  }
}

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
  return new THREE.LineSegments(b.build(), new THREE.LineBasicMaterial({ vertexColors: true }));
}

export const LIGHT_HEX = [0x333333, 0xff3030, 0x30ff60, 0x3080ff, 0xffb020];

export interface RoverMesh {
  group: THREE.Group;
  beacon: THREE.LineBasicMaterial;
  headlight: THREE.LineSegments;
  /** Turntable carrying the solar array; rotate to the panel bearing, scale with deployment. */
  solar: THREE.Group;
  /** Dish turntable; rotate to the antenna bearing. */
  dish: THREE.Group;
  /** Tinted by subsystem health. */
  solarMat: THREE.LineBasicMaterial;
  dishMat: THREE.LineBasicMaterial;
  /** Sensor-range ring (unit radius, scale to range). Not parented to the rotating group. */
  sensorRing: THREE.LineLoop;
}

const lines = (b: LineBatch, opts: THREE.LineBasicMaterialParameters = {}) =>
  new THREE.LineSegments(b.build(), new THREE.LineBasicMaterial({ vertexColors: true, ...opts }));

/** Wireframe rover. Faces -Z (north) at rotation 0. */
export function buildRoverMesh(): RoverMesh {
  const group = new THREE.Group();
  const b = new LineBatch();
  const c = 0x3affc8;
  // chassis
  b.color(c, 1).box(-0.28, 0.12, -0.34, 0.56, 0.18, 0.68);
  // wheels
  b.color(c, 0.7);
  for (const [wx, wz] of [[-0.38, -0.3], [0.28, -0.3], [-0.38, 0.14], [0.28, 0.14]]) b.box(wx, 0, wz, 0.1, 0.18, 0.16);
  // mast
  b.color(c, 0.85).seg(0.12, 0.3, 0.2, 0.12, 0.55, 0.2);
  // camera head (front)
  b.color(c, 0.9).box(-0.08, 0.3, -0.3, 0.16, 0.1, 0.1);
  // stowed panel outline on the deck
  b.color(0x4466ff, 0.6).loop([[-0.24, 0.31, -0.15], [0.24, 0.31, -0.15], [0.24, 0.31, 0.1], [-0.24, 0.31, 0.1]]);
  group.add(lines(b));

  // Solar array: a wide panel tilted toward its bearing (local -Z), with cell grid.
  const solar = new THREE.Group();
  solar.position.set(0, 0.34, -0.02);
  const sp = new LineBatch().color(0x5a7dff, 1);
  const W = 0.75, D = 0.42, tilt = 0.18;
  const y = (z: number) => tilt * (z / D); // back edge higher than front
  sp.loop([[-W, y(-D), -D], [W, y(-D), -D], [W, y(D), D], [-W, y(D), D]]);
  sp.color(0x5a7dff, 0.55);
  for (let i = -2; i <= 2; i++) if (i) sp.seg((i * W) / 3, y(-D), -D, (i * W) / 3, y(D), D);
  sp.seg(-W, 0, 0, W, 0, 0);
  sp.color(0x5a7dff, 0.8).seg(0, 0, 0, 0, -0.04, 0);
  const solarMat = new THREE.LineBasicMaterial({ color: 0x5a7dff });
  const solarLines = new THREE.LineSegments(sp.build(), solarMat);
  solarLines.geometry.deleteAttribute('color');
  solar.add(solarLines);
  group.add(solar);

  // Dish on the mast.
  const dish = new THREE.Group();
  dish.position.set(0.12, 0.58, 0.2);
  const db = new LineBatch().color(c, 0.95);
  const ring: [number, number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ring.push([Math.cos(a) * 0.14, 0.06 + Math.sin(a) * 0.14, -0.06]);
  }
  db.loop(ring);
  for (let i = 0; i < 10; i += 2.5) {
    const p = ring[Math.floor(i)];
    db.seg(0, 0.06, 0.04, p[0], p[1], p[2]);
  }
  db.color(c, 0.6).seg(0, 0.06, -0.06, 0, 0.06, -0.2);
  const dishMat = new THREE.LineBasicMaterial({ color: c });
  const dishLines = new THREE.LineSegments(db.build(), dishMat);
  dishLines.geometry.deleteAttribute('color');
  dish.add(dishLines);
  group.add(dish);

  const beaconB = new LineBatch().color(0xffffff).octa(-0.15, 0.48, 0.22, 0.06, 0.08);
  const beacon = new THREE.LineBasicMaterial({ color: LIGHT_HEX[2] });
  const beaconMesh = new THREE.LineSegments(beaconB.build(), beacon);
  beaconMesh.geometry.deleteAttribute('color');
  group.add(beaconMesh);

  const hl = new LineBatch().color(0xfff2b0, 0.8);
  hl.seg(-0.05, 0.35, -0.4, -1.6, 0.0, -5.0).seg(0.05, 0.35, -0.4, 1.6, 0.0, -5.0).seg(-1.6, 0, -5, 1.6, 0, -5);
  const headlight = lines(hl, { transparent: true, opacity: 0.55 });
  headlight.visible = false;
  group.add(headlight);

  const ringPts: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    ringPts.push(new THREE.Vector3(Math.cos(a), 0.01, Math.sin(a)));
  }
  const sensorRing = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(ringPts),
    new THREE.LineDashedMaterial({ color: 0x3affc8, transparent: true, opacity: 0.25, dashSize: 0.3, gapSize: 0.25 }),
  );
  sensorRing.computeLineDistances();
  return { group, beacon, headlight, solar, dish, sensorRing, solarMat, dishMat };
}

// ============================================================================================
// M8 vector assets (v2). Previewed in preview.html before they replace the shapes above.
// ============================================================================================

type V3 = readonly [number, number, number];

/** Dark opaque fill triangles under the line work (hidden-line look), with per-tile lighting. */
export class FillBatch {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly tile: number[] = [];
  private r = 0;
  private g = 0;
  private b = 0;
  private tx = 0;
  private tz = 0;

  /** `intensity` is perceptual; squared because the output pass converts linear → sRGB. */
  color(hex: number, intensity = 0.12): this {
    const k = intensity * intensity * 2.2;
    this.r = (((hex >> 16) & 255) / 255) * k;
    this.g = (((hex >> 8) & 255) / 255) * k;
    this.b = ((hex & 255) / 255) * k;
    return this;
  }

  at(x: number, z: number): this {
    this.tx = x;
    this.tz = z;
    return this;
  }

  tri(a: V3, b: V3, c: V3): this {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) {
      this.col.push(this.r, this.g, this.b);
      this.tile.push(this.tx, this.tz);
    }
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
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('tile', new THREE.Float32BufferAttribute(this.tile, 2));
    return g;
  }
}

/** Deterministic 0..1 from a variant byte and a salt (render-only jitter). */
const jit = (variant: number, salt: number) => (((variant * 73 + salt * 151) ^ (variant >> 2)) & 255) / 255;

/** Unexplored tile: a faint survey cross on the corner, no fill. */
export function drawFogTile(b: LineBatch, lx: number, ly: number): void {
  b.at(lx + 0.5, -ly - 0.5).color(0x2a3a52, 0.5).seg(lx - 0.08, 0, -ly, lx + 0.08, 0, -ly).seg(lx, 0, -ly - 0.08, lx, 0, -ly + 0.08);
}

/**
 * v2 tile: lines into `b`, dark fills into `f`. Same coordinates as `drawTile`:
 * tile (lx, ly) covers x∈[lx, lx+1], z∈[-ly-1, -ly].
 */
export function drawTileVec(b: LineBatch, f: FillBatch, shape: TileShape, color: number, lx: number, ly: number, variant: number): void {
  const x0 = lx;
  const z0 = -ly - 1;
  const cx = lx + 0.5;
  const cz = -ly - 0.5;
  b.at(cx, cz);
  f.at(cx, cz);
  const ground = (hex: number, fill = 0.09) => {
    b.color(hex, 0.42).seg(x0, 0, z0 + 1, x0 + 1, 0, z0 + 1).seg(x0, 0, z0, x0, 0, z0 + 1);
    // Tiny corner tick so lit cells read as cells even without neighbours.
    b.color(hex, 0.6).seg(x0 + 1, 0, z0 + 1, x0 + 0.9, 0, z0 + 1).seg(x0 + 1, 0, z0 + 1, x0 + 1, 0, z0 + 0.9);
    f.color(hex, fill).quad([x0, 0, z0], [x0 + 1, 0, z0], [x0 + 1, 0, z0 + 1], [x0, 0, z0 + 1]);
  };
  switch (shape) {
    case 'floor':
      ground(color);
      // Occasional ripple line in the sand.
      if ((variant & 3) === 0) {
        const o = jit(variant, 1) * 0.5 + 0.25;
        b.color(color, 0.3).seg(x0 + 0.2, 0, z0 + o, x0 + 0.5, 0, z0 + o - 0.06).seg(x0 + 0.5, 0, z0 + o - 0.06, x0 + 0.8, 0, z0 + o);
      }
      break;
    case 'rough': {
      ground(color, 0.1);
      // Three flat stones lying on the ground: low, dim, same hue as the ground.
      for (let k = 0; k < 3; k++) {
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
      b.color(color, 0.35).seg(cx, h, cz, cx + 0.04, h + 0.18, cz - 0.03).seg(cx + 0.04, h + 0.18, cz - 0.03, cx - 0.02, h + 0.34, cz - 0.06);
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
      for (const s of [0.33, 0.62]) {
        const ring = lo.map((p, i): V3 => [p[0] + (hi[i][0] - p[0]) * s, hi[i][1] * s, p[2] + (hi[i][2] - p[2]) * s]);
        b.color(color, 0.4).loop(ring);
      }
      b.color(color, 0.55).seg(hi[0][0], hi[0][1], hi[0][2], hi[3][0], hi[3][1], hi[3][2]);
      break;
    }
    case 'crystal': {
      ground(0x7a5a3a);
      const shards: [number, number, number, number, number][] = [
        [cx, 0.4, cz, 0.24, 0.4],
        [cx + 0.24, 0.2, cz + 0.16, 0.1, 0.2],
        [cx - 0.2, 0.17, cz + 0.2, 0.09, 0.17],
        [cx + 0.05, 0.13, cz - 0.27, 0.07, 0.13],
      ];
      for (const [x, y, z, rx, ry] of shards) {
        f.color(color, 0.28).octa(x, y, z, rx, ry);
        b.color(color, 1).octa(x, y, z, rx, ry);
      }
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

// ----------------------------------------------------------------------------- rover v2

/** Filled dark body + bright edges. Returns the group and its edge material (for tinting). */
function vectorPart(geo: THREE.BufferGeometry, edge: number, fill = 0x09131f, edgeOpacity = 1, side: THREE.Side = THREE.FrontSide): { obj: THREE.Group; edgeMat: THREE.LineBasicMaterial; fillMat: THREE.MeshBasicMaterial } {
  const obj = new THREE.Group();
  const fillMat = new THREE.MeshBasicMaterial({ color: fill, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  obj.add(new THREE.Mesh(geo, fillMat));
  const edgeMat = new THREE.LineBasicMaterial({ color: edge, transparent: edgeOpacity < 1, opacity: edgeOpacity });
  obj.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), edgeMat));
  return { obj, edgeMat, fillMat };
}

function wireOnly(geo: THREE.BufferGeometry, color: number, opacity = 1): { obj: THREE.LineSegments; mat: THREE.LineBasicMaterial } {
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  return { obj: new THREE.LineSegments(new THREE.WireframeGeometry(geo), mat), mat };
}

/** One solar panel segment spanning x∈[0, w] from its hinge, with a 2×4 cell grid. */
function solarSegment(w: number, length: number, color: number): { seg: THREE.Group; mat: THREE.LineBasicMaterial } {
  const seg = new THREE.Group();
  const box = new THREE.BoxGeometry(w - 0.02, 0.03, length);
  box.translate(w / 2, 0, 0);
  const frame = vectorPart(box, color, 0x061626);
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
  seg.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })));
  // Hinge pin along the inner edge.
  const pin = new THREE.BufferGeometry();
  pin.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -length / 2 - 0.03, 0, 0, length / 2 + 0.03], 3));
  seg.add(new THREE.LineSegments(pin, new THREE.LineBasicMaterial({ color: ROVER_AMBER })));
  return { seg, mat: frame.edgeMat };
}

/** Segments per solar wing (accordion fold). */
export const SOLAR_SEGMENTS = 3;

export const ROVER_AMBER = 0xf59e0b;
export const ROVER_CYAN = 0x38bdf8;

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
  beacon: THREE.MeshBasicMaterial;
  headLamp: THREE.MeshBasicMaterial;
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
export function buildRoverRig(): RoverRigMesh {
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
  const solarMats: THREE.LineBasicMaterial[] = [];
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
      const s = solarSegment(SEG_W, SEG_L, 0x5a7dff);
      joint.add(s.seg);
      parent.add(joint);
      parent = joint;
      joints.push(joint);
      solarMats.push(s.mat);
    }
    solarMount.add(sideGroup);
    solarSides.push(sideGroup);
    solarJoints.push(joints);
  }

  // Dorsal dish on a turntable.
  const dish = new THREE.Group();
  dish.position.set(0, 1.0, 0.3);
  const mast = vectorPart(new THREE.CylinderGeometry(0.04, 0.07, 0.26, 6), ROVER_CYAN);
  mast.obj.position.y = 0.13;
  dish.add(mast.obj);
  // Solid parabolic dish (opaque, ribbed), facing local -Z and up.
  const profile = [0, 0.1, 0.2, 0.28, 0.35].map((r) => new THREE.Vector2(r, r * r * 0.9));
  const dishGeo = new THREE.LatheGeometry(profile, 12);
  dishGeo.rotateX(-Math.PI / 3);
  const cone = vectorPart(dishGeo, 0x3affc8, 0x08201c, 1, THREE.DoubleSide);
  cone.obj.position.set(0, 0.3, 0.02);
  dish.add(cone.obj);
  const feed = vectorPart(new THREE.OctahedronGeometry(0.05, 0), 0x3affc8);
  feed.obj.position.set(0, 0.44, -0.22);
  dish.add(feed.obj);
  body.add(dish);

  // Headlight bar on the nose.
  const headLamp = new THREE.MeshBasicMaterial({ color: 0x1e293b });
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.06), headLamp);
  lamp.position.set(0, 0.56, -0.74);
  body.add(lamp);

  // Status LED crystal.
  const beacon = new THREE.MeshBasicMaterial({ color: LIGHT_HEX[2] });
  const led = new THREE.Mesh(new THREE.OctahedronGeometry(0.07, 0), beacon);
  led.position.set(-0.28, 1.08, -0.2);
  body.add(led);

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

  return {
    group,
    model,
    wheels,
    cpuCore: core.obj,
    cpuMat: core.mat,
    solarMount,
    solarSides,
    solarJoints,
    solarMats,
    dish,
    dishMats: [cone.edgeMat, mast.edgeMat],
    beacon,
    headLamp,
    beam,
    beamMats: [beamFill, beamLines.material as THREE.Material],
    drillBit,
    drillGlow,
    drillRing,
    sparks,
    sensorRing,
  };
}
