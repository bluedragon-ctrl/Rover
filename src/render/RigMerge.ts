import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Draw-call reduction for hierarchical vector models (the rover rig): parts that never move
 * relative to each other are baked into one line mesh and one fill mesh per rigid node,
 * with their material colours moved into vertex colours. Purely a renderer optimisation;
 * the shapes themselves are still defined in VectorFactory.
 */

/** Position-only, non-indexed copy of `geo` transformed by `m`. */
function bake(geo: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.getAttribute('position').clone());
  g.applyMatrix4(m);
  return g;
}

function withColor(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** Transform of `obj` relative to `root` (both must have up-to-date world matrices). */
function relMatrix(root: THREE.Object3D, obj: THREE.Object3D): THREE.Matrix4 {
  return new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(obj.matrixWorld);
}

/** Descendants of `root` that are not under (or equal to) a boundary node. */
function collect(root: THREE.Object3D, boundaries: ReadonlySet<THREE.Object3D>, out: THREE.Object3D[] = []): THREE.Object3D[] {
  for (const c of root.children) {
    if (boundaries.has(c)) continue;
    out.push(c);
    collect(c, boundaries, out);
  }
  return out;
}

/**
 * Merge the static meshes under `root` (stopping at `boundaries`, the nodes that animate).
 * - Objects whose material is in `shared` (animated tints) are merged per material
 *   instance, keeping that material.
 * - Other MeshBasicMaterial meshes and LineBasicMaterial segments are merged by render
 *   state (side, polygon offset, opacity), their colours moved into vertex colours.
 * LineLoops, dashed lines, Points and invisible objects are left alone.
 */
export function mergeStatic(root: THREE.Object3D, boundaries: ReadonlySet<THREE.Object3D>, shared: ReadonlySet<THREE.Material> = new Set()): void {
  root.updateMatrixWorld(true);
  type Bucket = { geos: THREE.BufferGeometry[]; make: () => THREE.Object3D; objs: THREE.Object3D[] };
  const buckets = new Map<string | THREE.Material, Bucket>();
  const add = (key: string | THREE.Material, obj: THREE.Object3D, geo: THREE.BufferGeometry, make: () => THREE.Object3D) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { geos: [], make, objs: [] }));
    b.geos.push(geo);
    b.objs.push(obj);
  };

  for (const obj of collect(root, boundaries)) {
    if (!obj.visible) continue;
    const m = relMatrix(root, obj);
    if (obj instanceof THREE.LineSegments && !(obj instanceof THREE.LineLoop)) {
      const mat = obj.material as THREE.Material;
      if (shared.has(mat)) {
        add(mat, obj, bake(obj.geometry, m), () => new THREE.LineSegments(undefined, mat));
      } else if (mat instanceof THREE.LineBasicMaterial && !(mat instanceof THREE.LineDashedMaterial) && !mat.vertexColors) {
        const key = `L|${mat.transparent ? mat.opacity : 1}`;
        const { transparent, opacity } = mat;
        add(key, obj, withColor(bake(obj.geometry, m), mat.color), () => new THREE.LineSegments(undefined, new THREE.LineBasicMaterial({ vertexColors: true, transparent, opacity })));
      }
    } else if (obj instanceof THREE.Mesh) {
      const mat = obj.material as THREE.Material;
      if (shared.has(mat)) {
        add(mat, obj, bake(obj.geometry, m), () => new THREE.Mesh(undefined, mat));
      } else if (mat instanceof THREE.MeshBasicMaterial && !mat.vertexColors && !mat.transparent && !mat.map) {
        const { side, polygonOffset, polygonOffsetFactor, polygonOffsetUnits } = mat;
        const key = `M|${side}|${polygonOffset ? `${polygonOffsetFactor},${polygonOffsetUnits}` : '-'}`;
        add(key, obj, withColor(bake(obj.geometry, m), mat.color), () => new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({ vertexColors: true, side, polygonOffset, polygonOffsetFactor, polygonOffsetUnits })));
      }
    }
  }

  for (const b of buckets.values()) {
    const geo = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos);
    if (!geo) continue;
    for (const o of b.objs) o.parent?.remove(o);
    const merged = b.make() as THREE.Mesh | THREE.LineSegments;
    merged.geometry = geo;
    root.add(merged);
  }
  pruneEmpty(root, boundaries);
}

/** Remove groups left empty by the merge (children first, so nested empties go too). */
function pruneEmpty(node: THREE.Object3D, boundaries: ReadonlySet<THREE.Object3D>): void {
  for (const c of [...node.children]) {
    if (boundaries.has(c)) continue;
    pruneEmpty(c, boundaries);
    if (c.type === 'Group' && c.children.length === 0) node.remove(c);
  }
}

/**
 * Several small, individually coloured parts (lamps, LED segments) as one mesh: colours
 * live in a vertex colour attribute, `set(i, hex)` recolours part i (uploads only on change).
 */
export class ColorCells {
  readonly mesh: THREE.Mesh;
  private col: THREE.BufferAttribute;
  private ranges: [number, number][] = [];
  private hex: number[] = [];
  private tmp = new THREE.Color();

  /** `parts` must already sit in the hierarchy under `parent`; they are replaced by one mesh. */
  constructor(parent: THREE.Object3D, parts: THREE.Mesh[]) {
    parent.updateMatrixWorld(true);
    const geos: THREE.BufferGeometry[] = [];
    let v = 0;
    for (const p of parts) {
      const g = withColor(bake(p.geometry, relMatrix(parent, p)), (p.material as THREE.MeshBasicMaterial).color);
      const n = g.getAttribute('position').count;
      this.ranges.push([v, v + n]);
      this.hex.push((p.material as THREE.MeshBasicMaterial).color.getHex());
      v += n;
      geos.push(g);
      p.parent?.remove(p);
    }
    const geo = mergeGeometries(geos)!;
    this.col = geo.getAttribute('color') as THREE.BufferAttribute;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
    parent.add(this.mesh);
  }

  get length(): number {
    return this.ranges.length;
  }

  set(i: number, hex: number): void {
    if (i >= this.ranges.length || this.hex[i] === hex) return;
    this.hex[i] = hex;
    const c = this.tmp.setHex(hex);
    const [a, b] = this.ranges[i];
    for (let v = a; v < b; v++) this.col.setXYZ(v, c.r, c.g, c.b);
    this.col.addUpdateRange(a * 3, (b - a) * 3);
    this.col.needsUpdate = true;
  }

  get(i: number): number {
    return this.hex[i];
  }
}
