import * as THREE from 'three';
import { CHUNK, CHUNK_AREA, chunkKey, type WorldChunk } from '../core/ChunkedWorld';
import type { SimulationEngine } from '../core/SimulationEngine';
import { hash3 } from '../core/rng';
import { drawFogTile, drawTileVec, FillBatch, LineBatch, Vis, VIS_U16 } from './VectorFactory';
import type { TileLighting } from './TileLighting';

/** Vertex ranges per tile in a chunk's line and fill geometry (for in-place fog updates). */
export interface TileRanges {
  /** Line vertices of tile i: [lineStart[i], lineStart[i + 1]); the survey cross comes first. */
  lineStart: Uint32Array;
  /** End of tile i's survey cross (== lineStart[i] when it has none). */
  crossEnd: Uint32Array;
  /** Fill vertices of tile i: [fillStart[i], fillStart[i + 1]). */
  fillStart: Uint32Array;
}

export interface ChunkGeometry {
  lines: THREE.BufferGeometry;
  fills: THREE.BufferGeometry;
  ranges: TileRanges;
}

interface Entry {
  group: THREE.Group;
  lines: THREE.LineSegments;
  fills: THREE.Mesh;
  chunk: WorldChunk;
  version: number;
  ranges: TileRanges;
  /** Fog and drawn layers (0..2) as built; diffed when the chunk version changes. */
  fog: Uint8Array;
  layers: Uint16Array[];
  /** Force a full rebuild (reveal-all toggled). */
  rebuild: boolean;
}

/**
 * One merged line mesh + one fill mesh per visible chunk (v2 assets, TileLighting),
 * positioned relative to the camera focus (floating origin) so Float32 precision never
 * degrades far from (0,0).
 *
 * Unmapped tiles show a survey cross; their real geometry is built too, but flagged
 * hidden, so only a radar wave (SCAN) briefly outlines it. Nothing is mapped by that.
 *
 * When a chunk changes only by fog (a rover mapping tiles as it drives) or by layers that
 * are not drawn (actors), the geometry is not rebuilt: the newly mapped tiles' visibility
 * flags are patched in place (their real geometry shown, the survey cross dropped).
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
  /** Chunks updated in place (fog only) during the last update(). */
  lastPatches = 0;

  constructor(private engine: SimulationEngine, private root: THREE.Object3D, private lighting: TileLighting) {}

  update(focusX: number, focusY: number, radiusChunks: number): void {
    const fcx = Math.floor(focusX / CHUNK);
    const fcy = Math.floor(focusY / CHUNK);
    const wanted = new Set<string>();
    let builds = 0;
    let buildMs = 0;
    let patches = 0;
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
      const loaded = this.engine.world.hasChunk(cx, cy);
      let stale = !e || !loaded || e.version !== e.chunk.version;
      if (e && stale && loaded && !e.rebuild && this.engine.world.getChunk(cx, cy) === e.chunk && this.patch(e)) {
        patches++;
        stale = false;
      }
      if (stale && builds < this.maxBuildsPerFrame && (builds === 0 || buildMs < this.buildBudgetMs)) {
        builds++;
        const chunk = this.engine.world.getChunk(cx, cy);
        const t0 = performance.now();
        const { lines, fills, ranges } = this.buildGeometry(chunk);
        buildMs += performance.now() - t0;
        if (e) {
          this.count(e, -1);
          e.lines.geometry.dispose();
          e.fills.geometry.dispose();
          e.lines.geometry = lines;
          e.fills.geometry = fills;
          e.chunk = chunk;
          e.ranges = ranges;
        } else {
          const group = new THREE.Group();
          const l = new THREE.LineSegments(lines, this.lighting.lineMaterial);
          const f = new THREE.Mesh(fills, this.lighting.fillMaterial);
          l.frustumCulled = f.frustumCulled = false;
          group.add(f, l);
          this.root.add(group);
          e = { group, lines: l, fills: f, chunk, version: 0, ranges, fog: new Uint8Array(CHUNK_AREA), layers: [], rebuild: false };
          this.entries.set(key, e);
        }
        this.snapshot(e);
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
    this.lastPatches = patches;
  }

  /** Remember what the entry's geometry was built from. */
  private snapshot(e: Entry): void {
    const c = e.chunk;
    e.version = c.version;
    e.rebuild = false;
    e.fog.set(c.fog);
    e.layers = [0, 1, 2].map((l) => c.layers[l].slice());
  }

  /**
   * Bring an entry up to date without rebuilding, if only fog was added (tiles mapped) or
   * undrawn layers changed. Returns false when a rebuild is needed.
   */
  private patch(e: Entry): boolean {
    const c = e.chunk;
    for (let l = 0; l < 3; l++) {
      const a = c.layers[l], b = e.layers[l];
      for (let i = 0; i < CHUNK_AREA; i++) if (a[i] !== b[i]) return false;
    }
    const mapped: number[] = [];
    if (!this.revealAll) {
      for (let i = 0; i < CHUNK_AREA; i++) {
        if (c.fog[i] === e.fog[i]) continue;
        if (c.fog[i] === 0) return false; // un-mapping: rebuild
        mapped.push(i);
      }
    }
    if (mapped.length) {
      const r = e.ranges;
      const lc = e.lines.geometry.getAttribute('col') as THREE.BufferAttribute;
      const fc = e.fills.geometry.getAttribute('col') as THREE.BufferAttribute;
      const la = lc.array as Uint16Array, fa = fc.array as Uint16Array;
      let l0 = Infinity, l1 = -1, f0 = Infinity, f1 = -1;
      for (const i of mapped) {
        for (let v = r.lineStart[i]; v < r.crossEnd[i]; v++) la[v * 4 + 3] = VIS_U16[Vis.GONE];
        for (let v = r.crossEnd[i]; v < r.lineStart[i + 1]; v++) la[v * 4 + 3] = VIS_U16[Vis.VISIBLE];
        for (let v = r.fillStart[i]; v < r.fillStart[i + 1]; v++) fa[v * 4 + 3] = VIS_U16[Vis.VISIBLE];
        l0 = Math.min(l0, r.lineStart[i]);
        l1 = Math.max(l1, r.lineStart[i + 1]);
        f0 = Math.min(f0, r.fillStart[i]);
        f1 = Math.max(f1, r.fillStart[i + 1]);
      }
      markRange(lc, l0, l1);
      markRange(fc, f0, f1);
    }
    e.version = c.version;
    e.fog.set(c.fog);
    return true;
  }

  private count(e: Entry, sign: 1 | -1): void {
    this.lineVertices += sign * e.lines.geometry.getAttribute('position').count;
    this.fillTriangles += (sign * e.fills.geometry.getAttribute('position').count) / 3;
  }

  setRevealAll(v: boolean): void {
    if (v === this.revealAll) return;
    this.revealAll = v;
    for (const e of this.entries.values()) {
      e.version = -1;
      e.rebuild = true;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Line + fill geometry for one chunk (public for the geometry budget test). */
  buildGeometry(c: WorldChunk): ChunkGeometry {
    const reg = this.engine.registry;
    const b = new LineBatch();
    const f = new FillBatch();
    const ranges: TileRanges = {
      lineStart: new Uint32Array(CHUNK_AREA + 1),
      crossEnd: new Uint32Array(CHUNK_AREA),
      fillStart: new Uint32Array(CHUNK_AREA + 1),
    };
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = ly * CHUNK + lx;
        const hidden = !this.revealAll && c.fog[i] === 0;
        ranges.lineStart[i] = b.count;
        ranges.fillStart[i] = f.count;
        if (hidden) drawFogTile(b, lx, ly);
        ranges.crossEnd[i] = b.count;
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
    ranges.lineStart[CHUNK_AREA] = b.count;
    ranges.fillStart[CHUNK_AREA] = f.count;
    return { lines: b.build(), fills: f.build(), ranges };
  }
}

/** Upload only vertices [v0, v1) of a 4-component attribute. */
function markRange(a: THREE.BufferAttribute, v0: number, v1: number): void {
  if (v1 <= v0) return;
  a.addUpdateRange(v0 * a.itemSize, (v1 - v0) * a.itemSize);
  a.needsUpdate = true;
}
