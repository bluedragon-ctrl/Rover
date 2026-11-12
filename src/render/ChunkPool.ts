import * as THREE from 'three';
import { CHUNK, chunkKey, type WorldChunk } from '../core/ChunkedWorld';
import type { SimulationEngine } from '../core/SimulationEngine';
import { hash3 } from '../core/rng';
import { drawFogTile, drawTileVec, FillBatch, LineBatch } from './VectorFactory';
import type { TileLighting } from './TileLighting';

interface Entry {
  group: THREE.Group;
  lines: THREE.LineSegments;
  fills: THREE.Mesh;
  chunk: WorldChunk;
  version: number;
}

/**
 * One merged line mesh + one fill mesh per visible chunk (v2 assets, TileLighting),
 * positioned relative to the camera focus (floating origin) so Float32 precision never
 * degrades far from (0,0).
 *
 * Unmapped tiles show a survey cross; their real geometry is built too, but flagged
 * hidden, so only a radar wave (SCAN) briefly outlines it. Nothing is mapped by that.
 */
export class ChunkPool {
  private entries = new Map<string, Entry>();
  /** Debug/admin: ignore fog of war. */
  private revealAll = false;
  /**
   * CPU budget for chunk rebuilds per frame (ms), to avoid hitches when panning fast.
   * At least one chunk is built per frame; a chunk takes ~4 ms (render-budget test).
   */
  buildBudgetMs = 6;
  /** Hard cap on rebuilds per frame. */
  maxBuildsPerFrame = 4;
  /** Line vertices across all chunk meshes (frame-time HUD). */
  lineVertices = 0;
  /** Fill triangles across all chunk meshes. */
  fillTriangles = 0;
  /** Chunks rebuilt during the last update() and the CPU ms they took. */
  lastBuilds = 0;
  lastBuildMs = 0;

  constructor(private engine: SimulationEngine, private root: THREE.Object3D, private lighting: TileLighting) {}

  update(focusX: number, focusY: number, radiusChunks: number): void {
    const fcx = Math.floor(focusX / CHUNK);
    const fcy = Math.floor(focusY / CHUNK);
    const wanted = new Set<string>();
    let builds = 0;
    let buildMs = 0;
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
      if (stale && builds < this.maxBuildsPerFrame && (builds === 0 || buildMs < this.buildBudgetMs)) {
        builds++;
        const chunk = this.engine.world.getChunk(cx, cy);
        const t0 = performance.now();
        const { lines, fills } = this.buildGeometry(chunk);
        buildMs += performance.now() - t0;
        if (e) {
          this.count(e, -1);
          e.lines.geometry.dispose();
          e.fills.geometry.dispose();
          e.lines.geometry = lines;
          e.fills.geometry = fills;
          e.chunk = chunk;
          e.version = chunk.version;
        } else {
          const group = new THREE.Group();
          const l = new THREE.LineSegments(lines, this.lighting.lineMaterial);
          const f = new THREE.Mesh(fills, this.lighting.fillMaterial);
          l.frustumCulled = f.frustumCulled = false;
          group.add(f, l);
          this.root.add(group);
          e = { group, lines: l, fills: f, chunk, version: chunk.version };
          this.entries.set(key, e);
        }
        this.count(e, 1);
      } else if (!e) continue;
      else this.engine.world.getChunk(cx, cy); // keep visible chunks loaded
      e.group.position.set(cx * CHUNK - focusX, 0, -(cy * CHUNK - focusY));
    }

    for (const [key, e] of this.entries) {
      if (!wanted.has(key)) {
        this.root.remove(e.group);
        this.count(e, -1);
        e.lines.geometry.dispose();
        e.fills.geometry.dispose();
        this.entries.delete(key);
      }
    }
    this.lastBuilds = builds;
    this.lastBuildMs = buildMs;
  }

  private count(e: Entry, sign: 1 | -1): void {
    this.lineVertices += sign * e.lines.geometry.getAttribute('position').count;
    this.fillTriangles += (sign * e.fills.geometry.getAttribute('position').count) / 3;
  }

  setRevealAll(v: boolean): void {
    if (v === this.revealAll) return;
    this.revealAll = v;
    for (const e of this.entries.values()) e.version = -1; // force rebuild
  }

  get size(): number {
    return this.entries.size;
  }

  /** Line + fill geometry for one chunk (public for the geometry budget test). */
  buildGeometry(c: WorldChunk): { lines: THREE.BufferGeometry; fills: THREE.BufferGeometry } {
    const reg = this.engine.registry;
    const b = new LineBatch();
    const f = new FillBatch();
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = ly * CHUNK + lx;
        const hidden = !this.revealAll && c.fog[i] === 0;
        if (hidden) drawFogTile(b, lx, ly);
        b.hide(hidden);
        f.hide(hidden);
        const variant = hash3(7, c.cx * CHUNK + lx, c.cy * CHUNK + ly) & 0xff;
        for (let layer = 0; layer < 3; layer++) {
          const id = c.layers[layer][i];
          if (!id) continue;
          const def = reg.get(id);
          if (def) drawTileVec(b, f, def.shape, def.color, lx, ly, variant);
        }
        b.hide(false);
        f.hide(false);
      }
    }
    return { lines: b.build(), fills: f.build() };
  }
}
