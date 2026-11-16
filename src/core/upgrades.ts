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
  /** Upgrades that must already be installed. */
  requires?: string[];
  /** Modify the rover's own chassis (and any state that depends on it). */
  apply(c: ChassisDef, u: Unit): void;
}

const growCargo = (u: Unit, n: number) => {
  while (u.cargo.length < n) u.cargo.push(0);
};

const addMode = (c: ChassisDef, mode: number) => {
  if (!c.cameraModes.includes(mode)) c.cameraModes.push(mode);
  c.cameraModes.sort((a, b) => a - b);
};

export const UPGRADES: UpgradeDef[] = [
  // CPU budget in cycles (bus accesses) per tick.
  { id: 'CPU_96', title: 'CPU overclock I', description: 'CPU cycles per tick 64 → 96.', cost: 50, apply: (c) => (c.cyclesPerTick = 96) },
  { id: 'CPU_128', title: 'CPU overclock II', description: 'CPU cycles per tick 96 → 128.', cost: 100, requires: ['CPU_96'], apply: (c) => (c.cyclesPerTick = 128) },
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
  { id: 'LIDAR_8', title: 'Long-range radar', description: 'Radar range 6 → 8 tiles, day and night.', cost: 40, apply: (c) => (c.sensorRange = 8) },
  { id: 'ARMOR', title: 'Hull plating', description: 'Squalls wear the hull half as fast.', cost: 60, apply: (c) => (c.hullArmor = 2) },
  {
    id: 'SEISMIC',
    title: 'Seismic scanner (TOOL_3)',
    description: 'Hardpoint 3 (ROM ACT with F.T3): finds the nearest ore vein up to 12 tiles away, through walls. Results in SEITYP / SEIDST.',
    cost: 80,
    apply: (c) => (c.tools[3] = 'SEISMIC'),
  },
  // Downlink and science (docs/SPEC.md §3.8.6)
  { id: 'REC_4K', title: 'Recorder 4 KB', description: 'Science recorder 2 → 4 KB.', cost: 40, apply: (c) => (c.recorderBytes = Math.max(c.recorderBytes, 4096)) },
  { id: 'REC_8K', title: 'Recorder 8 KB', description: 'Science recorder 4 → 8 KB.', cost: 80, requires: ['REC_4K'], apply: (c) => (c.recorderBytes = 8192) },
  { id: 'LINK_6', title: 'High-gain amplifier', description: 'Downlink 4 → 6 bytes per tick at full signal (same energy per tick).', cost: 60, apply: (c) => (c.linkBytesPerTick = 6) },
  { id: 'CAM_COLOUR', title: 'Colour filter wheel', description: 'Camera mode 3 (F.M3): 64×64 photo, 16-colour planet palette (2 KB).', cost: 60, apply: (c) => addMode(c, 3) },
  { id: 'CAM_HIRES', title: 'Hi-res sensor', description: 'Camera mode 4 (F.M4): 128×128 grey photo, dithered (4 KB).', cost: 80, requires: ['REC_4K'], apply: (c) => addMode(c, 4) },
  { id: 'CAM_RGB', title: 'Colour sensor', description: 'Camera mode 5 (F.M5): 64×64 photo, 8 bpp RGB332 (4 KB).', cost: 100, requires: ['CAM_COLOUR', 'REC_4K'], apply: (c) => addMode(c, 5) },
];

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
