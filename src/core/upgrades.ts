import type { ChassisDef } from './balance';
import type { Unit } from './Unit';

/**
 * Upgrade catalogue. Bought with science credits, delivered by a supply crate that
 * lands near the rover; installed the moment the grabber picks the crate up.
 */
export interface UpgradeDef {
  id: string;
  title: string;
  description: string;
  cost: number;
  /** Upgrade that must already be installed. */
  requires?: string;
  /** Modify the rover's own chassis (and any state that depends on it). */
  apply(c: ChassisDef, u: Unit): void;
}

const growCargo = (u: Unit, n: number) => {
  while (u.cargo.length < n) u.cargo.push(0);
};

export const UPGRADES: UpgradeDef[] = [
  { id: 'FLASH_48', title: 'Flash 48', description: 'Program memory 32 → 48 lines.', cost: 40, apply: (c) => (c.flashLines = 48) },
  { id: 'FLASH_64', title: 'Flash 64', description: 'Program memory 48 → 64 lines.', cost: 90, requires: 'FLASH_48', apply: (c) => (c.flashLines = 64) },
  {
    id: 'REGS_6',
    title: 'Register file r0–r5',
    description: 'Registers 4 → 6.',
    cost: 40,
    apply: (c, u) => {
      c.registers = 6;
      u.vm.resizeRegisters(6);
    },
  },
  {
    id: 'REGS_8',
    title: 'Register file r0–r7',
    description: 'Registers 6 → 8.',
    cost: 80,
    requires: 'REGS_6',
    apply: (c, u) => {
      c.registers = 8;
      u.vm.resizeRegisters(8);
    },
  },
  { id: 'CPU_6', title: 'CPU overclock I', description: 'Compute cycles per tick 4 → 6.', cost: 50, apply: (c) => (c.cyclesPerTick = 6) },
  { id: 'CPU_8', title: 'CPU overclock II', description: 'Compute cycles per tick 6 → 8.', cost: 100, requires: 'CPU_6', apply: (c) => (c.cyclesPerTick = 8) },
  {
    id: 'CARGO_6',
    title: 'Cargo racks',
    description: 'Cargo slots 4 → 6.',
    cost: 35,
    apply: (c, u) => {
      c.cargoSlots = 6;
      growCargo(u, 6);
    },
  },
  { id: 'BATTERY_150', title: 'Battery pack', description: 'Battery capacity +50 % (@BAT is still 0–100 %).', cost: 60, apply: (c) => (c.batteryCapacity = 150_000) },
  { id: 'SOLAR_PLUS', title: 'High-efficiency cells', description: 'Solar output +25 %.', cost: 50, apply: (c) => (c.solarPercent = 125) },
  { id: 'LIDAR_8', title: 'Long-range LIDAR', description: 'Daytime SCAN range 6 → 8 tiles.', cost: 40, apply: (c) => (c.sensorRange = 8) },
  { id: 'ARMOR', title: 'Hull plating', description: 'Squalls wear the hull half as fast.', cost: 60, apply: (c) => (c.hullArmor = 2) },
  {
    id: 'SEISMIC',
    title: 'Seismic scanner (TOOL_3)',
    description: 'ACT TOOL_3 dir: finds the nearest ore vein up to 12 tiles away, through walls. Results in @SEISMIC_TYPE / @SEISMIC_DIST.',
    cost: 80,
    apply: (c) => (c.tools[3] = 'SEISMIC'),
  },
];

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
