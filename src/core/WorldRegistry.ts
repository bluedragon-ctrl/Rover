import { Layer } from './types';

export type TileShape = 'floor' | 'rough' | 'vent' | 'wall' | 'crystal' | 'crate' | 'sample' | 'rover';

export interface TileDef {
  id: number;
  /** Becomes a Rover-ASM constant. */
  constName: string;
  name: string;
  layer: Layer;
  /** Hex RGB for the vector renderer. */
  color: number;
  shape: TileShape;
  /** Terrain only: ticks to enter this tile. */
  moveTicks?: number;
  /** Terrain only: energy to enter this tile. */
  moveEnergy?: number;
  /** Terrain only: hull damage on entering. */
  hazardDamage?: number;
  /** 0 none, 1 mild, 2 severe. Reported by @GROUND_HAZARD. */
  hazardLevel?: number;
  /** Obstacle/actor layers: blocks STEP. */
  blocksMove?: boolean;
  /** Which tool collects this tile into cargo. */
  tool?: 'DRILL' | 'GRABBER';
  /** Science packets produced when analyzed by the spectrometer. */
  science?: number;
  /** Effect of `USE` on this item from cargo. */
  /**
   * Repair material: `USE slot system` consumes this item from cargo and restores
   * `repairs[system]` integrity (SYS_HULL=0, SYS_SOLAR=1, SYS_ANTENNA=2).
   */
  repairs?: Partial<Record<number, number>>;
}

/**
 * Declarative tile catalogue. IDs are unique across all layers so a SCAN result
 * unambiguously names a tile. ID 0 is NONE.
 */
export class WorldRegistry {
  private byId = new Map<number, TileDef>();
  private byConst = new Map<string, TileDef>();

  register(def: TileDef): TileDef {
    if (def.id === 0) throw new Error('Tile id 0 is reserved for NONE');
    if (this.byId.has(def.id)) throw new Error(`Duplicate tile id ${def.id}`);
    const key = def.constName.toUpperCase();
    if (this.byConst.has(key)) throw new Error(`Duplicate tile constName ${def.constName}`);
    this.byId.set(def.id, def);
    this.byConst.set(key, def);
    return def;
  }

  get(id: number): TileDef | undefined {
    return this.byId.get(id);
  }

  byName(constName: string): TileDef {
    const def = this.byConst.get(constName.toUpperCase());
    if (!def) throw new Error(`Unknown tile ${constName}`);
    return def;
  }

  all(): TileDef[] {
    return [...this.byId.values()];
  }

  /** Constants injected into the compiler. */
  constants(): Record<string, number> {
    const out: Record<string, number> = { NONE: 0 };
    for (const d of this.byId.values()) out[d.constName.toUpperCase()] = d.id;
    return out;
  }
}

export const T = {
  FLAT_SAND: 1,
  ROUGH_GRAVEL: 2,
  ACID_VENT: 3,
  CLIFF_WALL: 10,
  IRON_ORE: 11,
  SILICON_ORE: 12,
  REPAIR_KIT: 20,
  SAMPLE: 21,
  ROVER: 30,
} as const;

export function createDefaultRegistry(): WorldRegistry {
  const r = new WorldRegistry();
  r.register({ id: T.FLAT_SAND, constName: 'FLAT_SAND', name: 'Flat sand', layer: Layer.TERRAIN, color: 0x7a5a3a, shape: 'floor', moveTicks: 3, moveEnergy: 40, hazardLevel: 0 });
  r.register({ id: T.ROUGH_GRAVEL, constName: 'ROUGH_GRAVEL', name: 'Rough gravel', layer: Layer.TERRAIN, color: 0x8a7f72, shape: 'rough', moveTicks: 6, moveEnergy: 120, hazardLevel: 1 });
  r.register({ id: T.ACID_VENT, constName: 'ACID_VENT', name: 'Acid vent', layer: Layer.TERRAIN, color: 0x9dff3a, shape: 'vent', moveTicks: 4, moveEnergy: 60, hazardDamage: 10, hazardLevel: 2 });
  r.register({ id: T.CLIFF_WALL, constName: 'CLIFF_WALL', name: 'Cliff wall', layer: Layer.OBSTACLE, color: 0xd08a52, shape: 'wall', blocksMove: true });
  r.register({ id: T.IRON_ORE, constName: 'IRON_ORE', name: 'Iron ore vein', layer: Layer.OBSTACLE, color: 0xff5a4a, shape: 'crystal', blocksMove: true, tool: 'DRILL', science: 1, repairs: { 0: 10, 2: 15 } });
  r.register({ id: T.SILICON_ORE, constName: 'SILICON_ORE', name: 'Silicon ore vein', layer: Layer.OBSTACLE, color: 0x5ad0ff, shape: 'crystal', blocksMove: true, tool: 'DRILL', science: 1, repairs: { 1: 20 } });
  r.register({ id: T.REPAIR_KIT, constName: 'REPAIR_KIT', name: 'Repair kit', layer: Layer.ITEM, color: 0xffffff, shape: 'crate', tool: 'GRABBER', repairs: { 0: 30, 1: 40, 2: 40 } });
  r.register({ id: T.SAMPLE, constName: 'SAMPLE', name: 'Geological sample', layer: Layer.ITEM, color: 0xffd23a, shape: 'sample', tool: 'GRABBER', science: 3 });
  r.register({ id: T.ROVER, constName: 'ROVER', name: 'Rover', layer: Layer.ACTOR, color: 0x3affc8, shape: 'rover', blocksMove: true });
  return r;
}
