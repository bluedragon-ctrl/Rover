import * as THREE from 'three';
import { CHUNK, chunkKey, type WorldChunk } from '../core/ChunkedWorld';
import type { SimulationEngine } from '../core/SimulationEngine';
import { hash3 } from '../core/rng';
import { drawTile, LineBatch } from './VectorFactory';

interface Entry {
  mesh: THREE.LineSegments;
  chunk: WorldChunk;
  version: number;
}

/**
 * Builds one merged LineSegments mesh per visible chunk and positions it relative to
 * the camera focus (floating origin) so Float32 precision never degrades far from (0,0).
 */
export class ChunkPool {
  private entries = new Map<string, Entry>();
  private material = new THREE.LineBasicMaterial({ vertexColors: true });
  /** Chunks rebuilt per frame, to avoid hitches when panning fast. */
  maxBuildsPerFrame = 6;

  constructor(private engine: SimulationEngine, private root: THREE.Object3D) {}

  update(focusX: number, focusY: number, radiusChunks: number): void {
    const fcx = Math.floor(focusX / CHUNK);
    const fcy = Math.floor(focusY / CHUNK);
    const wanted = new Set<string>();
    let builds = 0;
    // Build nearest chunks first.
    const order: [number, number][] = [];
    for (let dy = -radiusChunks; dy <= radiusChunks; dy++) for (let dx = -radiusChunks; dx <= radiusChunks; dx++) order.push([dx, dy]);
    order.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));

    for (const [dx, dy] of order) {
      const cx = fcx + dx;
      const cy = fcy + dy;
      const key = chunkKey(cx, cy);
      wanted.add(key);
      let e = this.entries.get(key);
      const stale = !e || !this.engine.world.hasChunk(cx, cy) || e.version !== e.chunk.version;
      if (stale && builds < this.maxBuildsPerFrame) {
        builds++;
        const chunk = this.engine.world.getChunk(cx, cy);
        const geom = this.buildGeometry(chunk);
        if (e) {
          e.mesh.geometry.dispose();
          e.mesh.geometry = geom;
          e.chunk = chunk;
          e.version = chunk.version;
        } else {
          const mesh = new THREE.LineSegments(geom, this.material);
          mesh.frustumCulled = false;
          this.root.add(mesh);
          e = { mesh, chunk, version: chunk.version };
          this.entries.set(key, e);
        }
      } else if (!e) continue;
      else this.engine.world.getChunk(cx, cy); // keep visible chunks loaded
      e.mesh.position.set(cx * CHUNK - focusX, 0, -(cy * CHUNK - focusY));
    }

    for (const [key, e] of this.entries) {
      if (!wanted.has(key)) {
        this.root.remove(e.mesh);
        e.mesh.geometry.dispose();
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private buildGeometry(c: WorldChunk): THREE.BufferGeometry {
    const reg = this.engine.registry;
    const b = new LineBatch();
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = ly * CHUNK + lx;
        const variant = hash3(7, c.cx * CHUNK + lx, c.cy * CHUNK + ly) & 0xff;
        for (let layer = 0; layer < 3; layer++) {
          const id = c.layers[layer][i];
          if (!id) continue;
          const def = reg.get(id);
          if (def) drawTile(b, def.shape, def.color, lx, ly, variant);
        }
      }
    }
    // Chunk border, faint, helps orientation.
    b.color(0x3a5070, 0.6).loop([
      [0, 0.002, 0],
      [CHUNK, 0.002, 0],
      [CHUNK, 0.002, -CHUNK],
      [0, 0.002, -CHUNK],
    ]);
    return b.build();
  }
}
