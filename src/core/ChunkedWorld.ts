import { emod, floorDiv } from './types';
import type { MapGenerator } from './MapGenerator';

export const CHUNK = 16;
export const CHUNK_AREA = CHUNK * CHUNK;

export class WorldChunk {
  readonly layers: [Uint16Array, Uint16Array, Uint16Array, Uint16Array];
  /** Fog of war: 0 unexplored, 1 mapped. (What is *currently* visible is derived from rover positions.) */
  readonly fog = new Uint8Array(CHUNK_AREA);
  /** Any tile modified vs. generation. */
  dirty = false;
  /** Any fog revealed. Explored chunks are kept in memory and saved. */
  explored = false;
  lastTouched = 0;
  /** Bumped on every change; renderers compare it to rebuild meshes. */
  version = 0;

  constructor(readonly cx: number, readonly cy: number) {
    this.layers = [new Uint16Array(CHUNK_AREA), new Uint16Array(CHUNK_AREA), new Uint16Array(CHUNK_AREA), new Uint16Array(CHUNK_AREA)];
  }
}

export const chunkKey = (cx: number, cy: number): string => `${cx},${cy}`;

export function worldToChunk(x: number, y: number): { cx: number; cy: number; lx: number; ly: number } {
  return { cx: floorDiv(x, CHUNK), cy: floorDiv(y, CHUNK), lx: emod(x, CHUNK), ly: emod(y, CHUNK) };
}

/** Infinite sparse tile storage. Layer 3 (actors) is not stored here; see SimulationEngine. */
export class ChunkedWorld {
  private chunks = new Map<string, WorldChunk>();
  /** Total tiles mapped by fog-of-war reveals (for goals/stats). */
  mappedTiles = 0;
  /** Current tick, used for eviction bookkeeping. */
  now = 0;
  onTileChanged?: (x: number, y: number, layer: number, id: number) => void;

  constructor(readonly generator: MapGenerator) {}

  getChunk(cx: number, cy: number): WorldChunk {
    const key = chunkKey(cx, cy);
    let c = this.chunks.get(key);
    if (!c) {
      c = new WorldChunk(cx, cy);
      this.generator.fillChunk(c);
      this.chunks.set(key, c);
    }
    c.lastTouched = this.now;
    return c;
  }

  hasChunk(cx: number, cy: number): boolean {
    return this.chunks.has(chunkKey(cx, cy));
  }

  loadedChunks(): IterableIterator<WorldChunk> {
    return this.chunks.values();
  }

  get loadedCount(): number {
    return this.chunks.size;
  }

  getTile(x: number, y: number, layer: number): number {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    return this.getChunk(cx, cy).layers[layer][ly * CHUNK + lx];
  }

  setTile(x: number, y: number, layer: number, id: number): void {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const c = this.getChunk(cx, cy);
    const i = ly * CHUNK + lx;
    if (c.layers[layer][i] === id) return;
    c.layers[layer][i] = id;
    c.dirty = true;
    c.version++;
    this.onTileChanged?.(x, y, layer, id);
  }

  isMapped(x: number, y: number): boolean {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    return this.getChunk(cx, cy).fog[ly * CHUNK + lx] !== 0;
  }

  /** Mark one tile as mapped. */
  revealTile(x: number, y: number): void {
    const { cx, cy, lx, ly } = worldToChunk(x, y);
    const c = this.getChunk(cx, cy);
    const i = ly * CHUNK + lx;
    if (c.fog[i] === 0) {
      c.fog[i] = 1;
      c.explored = true;
      this.mappedTiles++;
      c.version++;
    }
  }

  /** Mark all tiles within `radius` (Euclidean, r*r + r: slightly rounder discs) of (x, y) as mapped. */
  revealCircle(x: number, y: number, radius: number): void {
    const r2 = radius * radius + radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= r2) this.revealTile(x + dx, y + dy);
    }
  }

  /** Mark (x + dx, y + dy) for every offset as mapped (e.g. a headlight cone). */
  revealTiles(x: number, y: number, offsets: ReadonlyArray<readonly [number, number]>): void {
    for (const [dx, dy] of offsets) this.revealTile(x + dx, y + dy);
  }

  /** Keep chunks around (x, y) loaded. */
  touchRadius(x: number, y: number, radius: number): void {
    const { cx, cy } = worldToChunk(x, y);
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) this.getChunk(cx + dx, cy + dy);
  }

  /** Drop clean, unexplored chunks untouched for `maxAge` ticks. They regenerate identically on demand. */
  evictStale(maxAge: number): number {
    let n = 0;
    for (const [key, c] of this.chunks) {
      if (!c.dirty && !c.explored && this.now - c.lastTouched > maxAge) {
        this.chunks.delete(key);
        n++;
      }
    }
    return n;
  }
}
