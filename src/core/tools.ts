import type { SimulationEngine } from './SimulationEngine';
import { DIR_VEC, Layer, Status, SystemId } from './types';
import type { Unit } from './Unit';
import { productFrameBytes, ProductType } from './downlink';
import { T } from './WorldRegistry';

export type ToolId = 'DRILL' | 'GRABBER' | 'SPECTROMETER' | 'SEISMIC' | 'USE_ITEM';

/**
 * Declarative tool table. `ACT TOOL_n arg` looks up the tool mounted in hardpoint n;
 * `USE slot` runs the internal USE_ITEM tool. The VM never changes for new tools.
 *
 * Lifecycle: `check` runs when the instruction executes (fails fast, no time spent);
 * if it returns OK the energy is paid, the CPU blocks for `ticks`, then `complete`
 * applies the effect (and re-validates, since the world may have changed).
 */
export interface ToolDef {
  id: ToolId;
  name: string;
  arg: 'dir' | 'slot';
  ticks: number;
  energy: number;
  description: string;
  check(e: SimulationEngine, u: Unit, arg: number, arg2?: number): Status;
  complete(e: SimulationEngine, u: Unit, arg: number, arg2?: number): Status;
  /** World tile the tool acts on (for FX), if any. */
  target?(u: Unit, arg: number): [number, number] | null;
}

const validDir = (d: number) => d >= 0 && d <= 3;
const validSlot = (u: Unit, s: number) => s >= 0 && s < u.cargo.length;
const adjacent = (u: Unit, dir: number): [number, number] => [u.x + DIR_VEC[dir][0], u.y + DIR_VEC[dir][1]];
const freeSlot = (u: Unit) => u.cargo.indexOf(0);

export const TOOLS: Record<ToolId, ToolDef> = {
  DRILL: {
    id: 'DRILL',
    name: 'Mining drill',
    arg: 'dir',
    ticks: 8,
    energy: 600,
    description: 'Breaks the ore vein next to the rover in <dir> and stores the ore in cargo.',
    target: (u, d) => (validDir(d) ? adjacent(u, d) : null),
    check(e, u, dir) {
      if (!validDir(dir)) return Status.ERR_INVALID;
      const [x, y] = adjacent(u, dir);
      if (e.registry.get(e.world.getTile(x, y, Layer.OBSTACLE))?.tool !== 'DRILL') return Status.ERR_INVALID;
      return freeSlot(u) < 0 ? Status.ERR_FULL : Status.OK;
    },
    complete(e, u, dir) {
      const st = this.check(e, u, dir);
      if (st !== Status.OK) return st;
      const [x, y] = adjacent(u, dir);
      const ore = e.world.getTile(x, y, Layer.OBSTACLE);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      u.cargo[freeSlot(u)] = ore;
      e.stats.oreMined++;
      return Status.OK;
    },
  },
  GRABBER: {
    id: 'GRABBER',
    name: 'Manipulator grabber',
    arg: 'dir',
    ticks: 2,
    energy: 100,
    description: 'Picks up the surface item next to the rover in <dir> into cargo.',
    target: (u, d) => (validDir(d) ? adjacent(u, d) : null),
    check(e, u, dir) {
      if (!validDir(dir)) return Status.ERR_INVALID;
      const [x, y] = adjacent(u, dir);
      const item = e.world.getTile(x, y, Layer.ITEM);
      if (e.registry.get(item)?.tool !== 'GRABBER') return Status.ERR_INVALID;
      if (item === T.SUPPLY_CRATE) return Status.OK; // installs directly, needs no cargo slot
      return freeSlot(u) < 0 ? Status.ERR_FULL : Status.OK;
    },
    complete(e, u, dir) {
      const st = this.check(e, u, dir);
      if (st !== Status.OK) return st;
      const [x, y] = adjacent(u, dir);
      const item = e.world.getTile(x, y, Layer.ITEM);
      e.world.setTile(x, y, Layer.ITEM, 0);
      if (item === T.SUPPLY_CRATE) {
        e.openSupplyCrate(u, x, y);
        return Status.OK;
      }
      u.cargo[freeSlot(u)] = item;
      e.stats.itemsCollected++;
      return Status.OK;
    },
  },
  SPECTROMETER: {
    id: 'SPECTROMETER',
    name: 'Lab spectrometer',
    arg: 'slot',
    ticks: 30,
    energy: 300,
    description: 'Analyzes the item in cargo <slot>, freeing it and recording a 16-byte spectrum (18 B in the recorder; ERR_FULL keeps the item).',
    check(e, u, slot) {
      if (!validSlot(u, slot)) return Status.ERR_INVALID;
      if (!e.registry.get(u.cargo[slot])?.science) return Status.ERR_INVALID;
      return u.link.recFree(u.chassis.recorderBytes) < productFrameBytes(ProductType.SPECTRUM) ? Status.ERR_FULL : Status.OK;
    },
    complete(e, u, slot) {
      const st = this.check(e, u, slot);
      if (st !== Status.OK) return st;
      const subject = u.cargo[slot];
      e.recordProduct(u, { type: ProductType.SPECTRUM, subject, x: u.x, y: u.y, credits: e.registry.get(subject)!.science! });
      u.cargo[slot] = 0;
      e.stats.itemsAnalyzed++;
      return Status.OK;
    },
  },
  SEISMIC: {
    id: 'SEISMIC',
    name: 'Seismic scanner',
    arg: 'dir',
    ticks: 4,
    energy: 150,
    description: 'Finds the nearest ore vein up to 12 tiles away in <dir>, through walls: @SEISMIC_TYPE / @SEISMIC_DIST (0 = none).',
    check: (_e, _u, dir) => (validDir(dir) ? Status.OK : Status.ERR_INVALID),
    complete(e, u, dir) {
      u.seismicType = 0;
      u.seismicDist = 0;
      const [dx, dy] = DIR_VEC[dir];
      for (let d = 1; d <= 12; d++) {
        const id = e.world.getTile(u.x + dx * d, u.y + dy * d, Layer.OBSTACLE);
        if (e.registry.get(id)?.tool === 'DRILL') {
          u.seismicType = id;
          u.seismicDist = d;
          break;
        }
      }
      return Status.OK;
    },
  },
  USE_ITEM: {
    id: 'USE_ITEM',
    name: 'Field repair',
    arg: 'slot',
    ticks: 10,
    energy: 200,
    description:
      'Repairs [system] (default SYS_HULL) by consuming the material in cargo <slot>: REPAIR_KIT +30 hull / +40 solar / +40 dish, IRON_ORE +10 hull / +15 dish, SILICON_ORE +20 solar.',
    check(e, u, slot, system = SystemId.SYS_HULL) {
      if (!validSlot(u, slot) || system < 0 || system > 2) return Status.ERR_INVALID;
      return e.registry.get(u.cargo[slot])?.repairs?.[system] ? Status.OK : Status.ERR_INVALID;
    },
    complete(e, u, slot, system = SystemId.SYS_HULL) {
      const st = this.check(e, u, slot, system);
      if (st !== Status.OK) return st;
      const amount = e.registry.get(u.cargo[slot])!.repairs![system]!;
      if (system === SystemId.SYS_HULL) u.hull = Math.min(100, u.hull + amount);
      else if (system === SystemId.SYS_SOLAR) u.solarHealth = Math.min(100, u.solarHealth + amount);
      else u.antennaHealth = Math.min(100, u.antennaHealth + amount);
      u.cargo[slot] = 0; // the material is used up
      e.stats.repairs++;
      return Status.OK;
    },
  },
};
