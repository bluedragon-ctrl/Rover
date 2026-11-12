import * as THREE from 'three';
import { DIR_VEC } from '../core/types';

interface Fx {
  obj: THREE.LineSegments;
  wx: number;
  wy: number;
  born: number;
  life: number;
}

/** Transient effects (scan rays) in world coordinates, re-anchored to the floating origin each frame. */
export class FxOverlay {
  private fx: Fx[] = [];
  constructor(private root: THREE.Object3D) {}

  scan(x: number, y: number, dir: number, dist: number, color: number, now: number): void {
    const [dx, dy] = DIR_VEC[dir];
    const g = new THREE.BufferGeometry();
    const len = dist;
    const pts = [0, 0.3, 0, dx * len, 0.3, -dy * len];
    // perpendicular tick marks at each tile
    for (let i = 1; i <= len; i++) {
      const px = dx * i, pz = -dy * i;
      const ox = dy * 0.12, oz = dx * 0.12;
      pts.push(px - ox, 0.3, pz - oz, px + ox, 0.3, pz + oz);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
    const obj = new THREE.LineSegments(g, mat);
    obj.frustumCulled = false;
    this.root.add(obj);
    this.fx.push({ obj, wx: x + 0.5, wy: y + 0.5, born: now, life: 450 });
  }

  /** Uplink: expanding ring plus a beam toward the orbiter bearing. */
  uplink(x: number, y: number, ok: boolean, bearing: number, now: number): void {
    const pts: number[] = [];
    const n = 32;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      pts.push(Math.cos(a0), 0.6, Math.sin(a0), Math.cos(a1), 0.6, Math.sin(a1));
    }
    if (ok) {
      const r = (bearing * Math.PI) / 180;
      pts.push(0, 0.6, 0, Math.sin(r) * 1.5, 3, -Math.cos(r) * 1.5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const obj = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: ok ? 0x5ad0ff : 0xff4d4d, transparent: true }));
    obj.frustumCulled = false;
    obj.userData.grow = true;
    this.root.add(obj);
    this.fx.push({ obj, wx: x + 0.5, wy: y + 0.5, born: now, life: 900 });
  }

  update(focusX: number, focusY: number, now: number): void {
    this.fx = this.fx.filter((f) => {
      const t = (now - f.born) / f.life;
      if (t >= 1) {
        this.root.remove(f.obj);
        f.obj.geometry.dispose();
        (f.obj.material as THREE.Material).dispose();
        return false;
      }
      (f.obj.material as THREE.LineBasicMaterial).opacity = 1 - t;
      if (f.obj.userData.grow) f.obj.scale.setScalar(0.3 + t * 1.6);
      f.obj.position.set(f.wx - focusX, 0, -(f.wy - focusY));
      return true;
    });
  }
}
