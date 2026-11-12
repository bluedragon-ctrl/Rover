import type { ChunkedWorld } from './ChunkedWorld';
import type { Unit } from './Unit';
import type { WorldRegistry } from './WorldRegistry';
import { BALANCE } from './balance';

export interface PortContext {
  tick: number;
  world: ChunkedWorld;
  registry: WorldRegistry;
}

export interface PortDef {
  name: string; // without '@'
  description: string;
  read?: (u: Unit, ctx: PortContext) => number;
  write?: (u: Unit, v: number, ctx: PortContext) => void;
  min?: number;
  max?: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Memory-mapped I/O. Add a port here and it is instantly usable from Rover-ASM. */
export const PORTS: PortDef[] = [
  { name: 'BAT', description: 'Battery 0–100 %', read: (u) => Math.floor((u.energy * 100) / BALANCE.batteryCapacity) },
  { name: 'HULL', description: 'Hull integrity 0–100', read: (u) => u.hull },
  { name: 'X', description: 'World X (east +)', read: (u) => u.x },
  { name: 'Y', description: 'World Y (north +)', read: (u) => u.y },
  { name: 'STATUS', description: 'Result of last hardware op (OK, ERR_*)', read: (u) => u.vm.status },
  { name: 'TICK', description: 'Ticks since world start', read: (_u, c) => c.tick },
  { name: 'GROUND', description: 'Terrain tile under rover', read: (u, c) => c.world.getTile(u.x, u.y, 0) },
  {
    name: 'GROUND_HAZARD',
    description: 'Hazard level of terrain under rover 0–2',
    read: (u, c) => c.registry.get(c.world.getTile(u.x, u.y, 0))?.hazardLevel ?? 0,
  },
  { name: 'LIGHT_COLOR', description: 'Status beacon color 0–4', min: 0, max: 4, read: (u) => u.lightColor, write: (u, v) => (u.lightColor = v) },
  { name: 'LIGHT_BLINK', description: 'Beacon blink 0/1', min: 0, max: 1, read: (u) => u.lightBlink, write: (u, v) => (u.lightBlink = v) },
  { name: 'HEADLIGHT', description: 'Headlight 0/1', min: 0, max: 1, read: (u) => u.headlight, write: (u, v) => (u.headlight = v) },
];

const byName = new Map(PORTS.map((p) => [p.name, p]));

export function getPort(name: string): PortDef | undefined {
  return byName.get(name.toUpperCase().replace(/^@/, ''));
}

export function writePortClamped(p: PortDef, u: Unit, v: number, ctx: PortContext): void {
  if (!p.write) return;
  p.write(u, clamp(v, p.min ?? -2147483648, p.max ?? 2147483647), ctx);
}
