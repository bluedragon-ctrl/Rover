import * as THREE from 'three';
import type { TileShape } from '../core/WorldRegistry';

/** Accumulates colored line segments into flat arrays for one merged BufferGeometry. */
export class LineBatch {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  private r = 1;
  private g = 1;
  private b = 1;

  color(hex: number, intensity = 1): this {
    this.r = (((hex >> 16) & 255) / 255) * intensity;
    this.g = (((hex >> 8) & 255) / 255) * intensity;
    this.b = ((hex & 255) / 255) * intensity;
    return this;
  }

  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): this {
    this.pos.push(x1, y1, z1, x2, y2, z2);
    this.col.push(this.r, this.g, this.b, this.r, this.g, this.b);
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
    case 'rover':
      break;
  }
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
