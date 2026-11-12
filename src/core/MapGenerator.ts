import { BALANCE } from './balance';
import { CHUNK, type WorldChunk } from './ChunkedWorld';
import { fbm, hash01 } from './rng';
import { T } from './WorldRegistry';

export interface GeneratedTile {
  terrain: number;
  obstacle: number;
  item: number;
}

/** Deterministic, order-independent world generation: a pure function of (seed, x, y). */
export class MapGenerator {
  constructor(readonly seed: number) {}

  tileAt(x: number, y: number): GeneratedTile {
    const s = this.seed;
    const lz = BALANCE.landingZoneRadius;
    if (Math.abs(x) <= lz && Math.abs(y) <= lz) return { terrain: T.FLAT_SAND, obstacle: 0, item: 0 };

    // Terrain
    const rough = fbm(s, x, y, 24, 1);
    let terrain: number = rough > 0.62 ? T.ROUGH_GRAVEL : T.FLAT_SAND;
    if (hash01(s, x, y, 2) < 0.006 && rough < 0.5) terrain = T.ACID_VENT;

    // Obstacles: ridge-like cliff bands plus ore clusters
    let obstacle = 0;
    const ridge = Math.abs(fbm(s, x, y, 32, 3) - 0.5);
    if (ridge < 0.025) obstacle = T.CLIFF_WALL;
    else {
      const oreField = fbm(s, x, y, 10, 4);
      if (oreField > 0.74 && hash01(s, x, y, 5) < 0.55) obstacle = hash01(s, x, y, 6) < 0.6 ? T.IRON_ORE : T.SILICON_ORE;
    }
    if (terrain === T.ACID_VENT) obstacle = 0;

    // Surface items
    let item = 0;
    if (obstacle === 0) {
      const r = hash01(s, x, y, 7);
      if (r < 0.004) item = T.SAMPLE;
      else if (r < 0.0055) item = T.REPAIR_KIT;
    }
    return { terrain, obstacle, item };
  }

  fillChunk(c: WorldChunk): void {
    const ox = c.cx * CHUNK;
    const oy = c.cy * CHUNK;
    for (let ly = 0; ly < CHUNK; ly++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const t = this.tileAt(ox + lx, oy + ly);
        const i = ly * CHUNK + lx;
        c.layers[0][i] = t.terrain;
        c.layers[1][i] = t.obstacle;
        c.layers[2][i] = t.item;
      }
    }
  }
}
