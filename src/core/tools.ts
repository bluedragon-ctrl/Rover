import type { SimulationEngine } from './SimulationEngine';
import { DIR_VEC, Layer, Status } from './types';
import type { Unit } from './Unit';

export type ToolId = 'DRILL' | 'GRABBER' | 'SPECTROMETER' | 'USE_ITEM';

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
  check(e: SimulationEngine, u: Unit, arg: number): Status;
  complete(e: SimulationEngine, u: Unit, arg: number): Status;
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
      if (e.registry.get(e.world.getTile(x, y, Layer.ITEM))?.tool !== 'GRABBER') return Status.ERR_INVALID;
      return freeSlot(u) < 0 ? Status.ERR_FULL : Status.OK;
    },
    complete(e, u, dir) {
      const st = this.check(e, u, dir);
      if (st !== Status.OK) return st;
      const [x, y] = adjacent(u, dir);
      const item = e.world.getTile(x, y, Layer.ITEM);
      e.world.setTile(x, y, Layer.ITEM, 0);
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
    description: 'Analyzes the item in cargo <slot>, freeing it and adding @SCIENCE_READY packets.',
    check(e, u, slot) {
      if (!validSlot(u, slot)) return Status.ERR_INVALID;
      return e.registry.get(u.cargo[slot])?.science ? Status.OK : Status.ERR_INVALID;
    },
    complete(e, u, slot) {
      const st = this.check(e, u, slot);
      if (st !== Status.OK) return st;
      u.scienceReady += e.registry.get(u.cargo[slot])!.science!;
      u.cargo[slot] = 0;
      e.stats.itemsAnalyzed++;
      return Status.OK;
    },
  },
  USE_ITEM: {
    id: 'USE_ITEM',
    name: 'Use cargo item',
    arg: 'slot',
    ticks: 5,
    energy: 0,
    description: 'Consumes the item in cargo <slot> (REPAIR_KIT: +30 hull).',
    check(e, u, slot) {
      if (!validSlot(u, slot)) return Status.ERR_INVALID;
      return e.registry.get(u.cargo[slot])?.useEffect ? Status.OK : Status.ERR_INVALID;
    },
    complete(e, u, slot) {
      const st = this.check(e, u, slot);
      if (st !== Status.OK) return st;
      const fx = e.registry.get(u.cargo[slot])!.useEffect!;
      if (fx.hull) u.hull = Math.min(100, u.hull + fx.hull);
      u.cargo[slot] = 0;
      return Status.OK;
    },
  },
};
