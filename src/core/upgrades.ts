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
  // Ids kept from the line-based Flash (saves store them): FLASH_48 = 768 B, FLASH_64 = 1024 B (M14; 384 / 512 B before).
  { id: 'FLASH_48', title: 'Flash 768 B', description: 'Flash (firmware + program) 512 → 768 bytes.', cost: 40, apply: (c) => (c.flashBytes = 768) },
  { id: 'FLASH_64', title: 'Flash 1 KB', description: 'Flash (firmware + program) 768 → 1024 bytes.', cost: 90, requires: ['FLASH_48'], apply: (c) => (c.flashBytes = 1024) },
  // M14: RAM grows in place (the firmware's VARs keep the addresses it was assembled with).
  { id: 'RAM_128', title: 'RAM 128 B', description: 'RAM (shared by firmware and program) 64 → 128 bytes.', cost: 40, apply: (c, u) => { c.ramBytes = 128; u.ramMemory(); } },
  { id: 'RAM_256', title: 'RAM 256 B', description: 'RAM 128 → 256 bytes.', cost: 80, requires: ['RAM_128'], apply: (c, u) => { c.ramBytes = 256; u.ramMemory(); } },
  {
    id: 'REGS_6',
    title: 'Register file r0–r5',
    description: 'Registers 4 → 6.',
    cost: 40,
    apply: (c, u) => {
      c.registers = 6;
      u.vm.resizeRegisters(6);
      u.prog.resizeRegisters(6);
    },
  },
  {
    id: 'REGS_8',
    title: 'Register file r0–r7',
    description: 'Registers 6 → 8.',
    cost: 80,
    requires: ['REGS_6'],
    apply: (c, u) => {
      c.registers = 8;
      u.vm.resizeRegisters(8);
      u.prog.resizeRegisters(8);
    },
  },
  // Ids kept for saves: CPU_6 = 12 cycles, CPU_8 = 16 cycles (M14; 6 / 8 before).
  { id: 'CPU_6', title: 'CPU overclock I', description: 'Compute cycles per tick 8 → 12.', cost: 50, apply: (c) => (c.cyclesPerTick = 12) },
  { id: 'CPU_8', title: 'CPU overclock II', description: 'Compute cycles per tick 12 → 16.', cost: 100, requires: ['CPU_6'], apply: (c) => (c.cyclesPerTick = 16) },
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
    description: 'CALL ACT TOOL_3 dir: finds the nearest ore vein up to 12 tiles away, through walls. Results in @SEISMIC_TYPE / @SEISMIC_DIST.',
    cost: 80,
    apply: (c) => (c.tools[3] = 'SEISMIC'),
  },
  // Downlink and science (docs/SPEC.md §3.8.6)
  { id: 'REC_2K', title: 'Recorder 2 KB', description: 'Science recorder 1024 → 2048 bytes.', cost: 40, apply: (c) => (c.recorderBytes = Math.max(c.recorderBytes, 2048)) },
  { id: 'REC_4K', title: 'Recorder 4 KB', description: 'Science recorder 2048 → 4096 bytes.', cost: 80, requires: ['REC_2K'], apply: (c) => (c.recorderBytes = 4096) },
  { id: 'LINK_3', title: 'High-gain amplifier', description: 'Downlink 2 → 3 bytes per tick at full signal (same energy per tick).', cost: 60, apply: (c) => (c.linkBytesPerTick = 3) },
  { id: 'TRACE_64', title: 'Trace buffer', description: 'Log FIFO 32 → 64 bytes.', cost: 30, apply: (c) => (c.logFifoBytes = 64) },
  { id: 'CAM_COLOUR', title: 'Colour filter wheel', description: 'Camera mode 3 (CALL SNAP dir 3): 32×32 photo, 16-colour planet palette (514 B).', cost: 60, apply: (c) => addMode(c, 3) },
  { id: 'CAM_HIRES', title: 'Hi-res sensor', description: 'Camera mode 4: 64×64 grey photo, dithered (1026 B).', cost: 80, requires: ['REC_2K'], apply: (c) => addMode(c, 4) },
  { id: 'CAM_RGB', title: 'Colour sensor', description: 'Camera mode 5: 32×32 photo, 8 bpp RGB332 (1026 B).', cost: 100, requires: ['CAM_COLOUR', 'REC_2K'], apply: (c) => addMode(c, 5) },
];

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
