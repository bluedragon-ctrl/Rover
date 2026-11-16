import type { ToolId } from './tools';

/** All tunable gameplay numbers. See docs/SPEC.md §2–§3. */
export const BALANCE = {
  defaultTickHz: 10,
  watchdogTicks: 50, // FAULT → hard reboot after this many ticks (the fault reset)
  /** Longest `WDT` timeout firmware can arm (SPEC §3.9.5). */
  wdtMaxTicks: 30_000,

  batteryCapacity: 100_000,
  idleDrainPerTick: 1,
  scanTicks: 1,
  scanEnergy: 10,
  coldBootPercent: 5,

  // Sky (docs/SPEC.md §2)
  dayTicks: 2400,
  sunStartPhase: 25, // degrees after sunrise at tick 0: start in the morning
  sunMaxElev: 70,
  orbitTicks: 1800,
  orbitStartAzimuth: 200,

  // Power
  solarMaxPerTick: 60,
  solarDeployTicks: 20,
  actuatorSlewDegPerTick: 3,
  actuatorEnergyPerTick: 1,
  headlightPerTick: 8,

  // Thermal (docs/SPEC.md §3.3.4): the rover follows the ambient slowly; heaters hold a floor
  ambientNightC: -80, // ambient at SUNLIT 0 (night, total eclipse)
  ambientDayC: 20, // ambient at SUNLIT 100; linear in between
  thermalTicksPerDeg: 4, // the rover's temperature moves 1 °C toward the ambient every N ticks
  heaterSetpointC: -40, // survival heaters (thermostat) keep the rover at or above this
  heaterPerTick: 6, // energy per tick while the heaters run

  // Dust on the solar array (docs/SPEC.md §3.3.4)
  dustTicks: 800, // +1 % dust per this many ticks the array is not fully stowed
  dustShedPercent: 50, // folding the array (a completed stow) shakes off this share of the dust (rounded up)

  // Operator view (what the player sees / maps; SCAN is radar: chassis.sensorRange, any light)
  dayViewRange: 6, // daylight: disc around the rover
  nightSensorRange: 1, // night: ring around the rover (work lights)
  headlightSensorRange: 5, // headlight cone length (tiles ahead)
  headlightNearLength: 2, // first tiles of the cone ...
  headlightNearSpread: 1, // ... are 3 wide (|lateral| <= 1)
  headlightFarSpread: 2, // the rest is 5 wide
  turnEnergy: 5, // HDG write: turn in place

  // Comms
  uploadBase: 500,
  uploadPerByte: 6, // M14 (was 12): code doubled with Flash, the upload costs about the same
  /** M10: base cost of a program-only upload (no reboot, SPEC §3.9.3). */
  programUploadBase: 200,
  uploadSignalFloor: 10,
  /** Uplinked console command (Dump, Dump stacks, Continue): like a small upload (§3.8.4). */
  dumpEnergy: 150,
  /** Dump replies that may wait for the downlink at once. */
  dumpQueueMax: 4,
  // Downlink (docs/SPEC.md §3.8.1): byte-based, shared by the log FIFO and the science recorder
  linkBytesPerTick: 4, // at SIGNAL 100, proportional to signal (Mk-I; chassis.linkBytesPerTick)
  linkMinSignal: 20, // nothing is sent below this
  linkEnergyPerTick: 2, // per tick in which at least one byte is sent

  // Camera (docs/SPEC.md §3.8.5): the camera block (the ROM's SNAP)
  snapTicks: 10,
  snapEnergy: 200,
  eraseTicks: 2, // F.ERAS (§3.8.7): zero image memory on request, like a flash erase
  eraseEnergy: 10,
  snapReach: 2, // subject: first obstacle / item / rover within this many tiles, else a landscape
  horizonRange: 16, // landscape: obstacles up to this far shape the skyline
  snapMinSunLight: 20, // SUNLIT needed for a lit photo (or the headlight aimed at the subject)
  photoCredits: 1, // lit photo
  photoFirstBonus: 5, // first lit photo of a subject type
  editFirstBonus: 5, // M12: first lit edited photo in each camera mode (photo type 1-5)
  anomalyOneIn: 40, // cliff walls and samples: 1 in N is an anomaly (seeded per tile)
  anomalyFlagCredits: 20, // correct flag of a new anomaly tile in the gallery
  anomalyWrongFlag: 5, // wrong flag: credits taken (never below 0)

  // Storyteller (docs/SPEC.md §3.5)
  eventEarliestTick: 1500, // grace period for new worlds
  eclipseRampTicks: 20, // per-event chances, lengths, damage: src/core/events.ts

  // Upgrades / supply drops (docs/SPEC.md §3.7)
  supplyDropTicks: 80, // purchase -> landing
  supplyDropMinDist: 3,
  supplyDropMaxDist: 6,

  chunkBubbleRadius: 1, // 3x3 chunks around each rover
  chunkEvictAfterTicks: 600,
  landingZoneRadius: 2, // 5x5
} as const;

/**
 * The rover's computer (docs/BLUE11_CPU.md §2, §6): memory map and sizes. The cycle budget is
 * the chassis' `cyclesPerTick`.
 */
export const BLUE11 = {
  /** Core installed on a Mk-I (memory boards: 4 / 8 KB later). */
  coreBytes: 2048,
  /** Firmware image origin (after the vectors) and the program base (fixed per chassis, decision 13). */
  firmwareBase: 0o200,
  programBase: 0o2000,
  /** Image memory window, ROM and the I/O page. */
  imageBase: 0o100000,
  romBase: 0o160000,
  ioBase: 0o170000,
  /** Real-time output FIFO of the TX device (BLUE11_IO.md §3.5a). */
  txFifoBytes: 64,
  /** Safe mode (BLUE11_CPU.md §10, from M14 §6.3): this many fault / watchdog reboots within... */
  safeModeBoots: 3,
  /** ...this many ticks make the boot ROM run its built-in safe firmware. */
  safeModeTicks: 500,
} as const;

export interface ChassisDef {
  name: string;
  /** CPU cycles (bus accesses) per tick (docs/BLUE11_CPU.md §4, §14.5). */
  cyclesPerTick: number;
  /** Log FIFO size in bytes (downlink, §3.8.3). */
  logFifoBytes: number;
  /** Science recorder size in bytes (§3.8.5). */
  recorderBytes: number;
  /** Downlink bytes per tick at full signal (§3.8.1). */
  linkBytesPerTick: number;
  /** Camera modes the camera takes (= photo product types, §3.8.5). */
  cameraModes: number[];
  sensorRange: number;
  cargoSlots: number;
  /** Tool mounted in each hardpoint TOOL_0..TOOL_3 (null = empty). */
  tools: Array<ToolId | null>;
  /** Energy units at 100 % (BAT reports a percentage of this). */
  batteryCapacity: number;
  /** Solar output multiplier in percent. */
  solarPercent: number;
  /** Squall hull damage is applied every (hullEvery × hullArmor) ticks. */
  hullArmor: number;
}

export const CHASSIS_MK1: ChassisDef = {
  name: 'Rover Mk-I',
  cyclesPerTick: 64, // owner, 2026-11-15, after the slice 4 measurement (BLUE11_CPU.md §14.5)
  logFifoBytes: 32,
  recorderBytes: 2048, // photos at double resolution are four times bigger (BLUE11_CPU.md §6.3)
  linkBytesPerTick: 4,
  cameraModes: [1, 2],
  sensorRange: 6,
  cargoSlots: 4,
  tools: ['DRILL', 'GRABBER', 'SPECTROMETER', null],
  batteryCapacity: 100_000,
  solarPercent: 100,
  hullArmor: 1,
};

/** Per-unit mutable copy (upgrades modify it in place). */
export function cloneChassis(c: ChassisDef): ChassisDef {
  return { ...c, tools: [...c.tools], cameraModes: [...c.cameraModes] };
}
