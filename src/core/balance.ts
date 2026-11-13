import type { ToolId } from './tools';

/** All tunable gameplay numbers. See docs/SPEC.md §2–§3. */
export const BALANCE = {
  defaultTickHz: 10,
  watchdogTicks: 50,

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

  // Operator view (what the player sees / maps; SCAN is radar: chassis.sensorRange, any light)
  dayViewRange: 6, // daylight: disc around the rover
  nightSensorRange: 1, // night: ring around the rover (work lights)
  headlightSensorRange: 5, // headlight cone length (tiles ahead)
  headlightNearLength: 2, // first tiles of the cone ...
  headlightNearSpread: 1, // ... are 3 wide (|lateral| <= 1)
  headlightFarSpread: 2, // the rest is 5 wide
  turnEnergy: 5, // @HEADING write: turn in place

  // Comms
  uploadBase: 500,
  uploadPerByte: 12, // ~50 per average instruction
  /** M10: base cost of a program-only upload (no reboot, SPEC §3.9.3). */
  programUploadBase: 200,
  uploadSignalFloor: 10,
  /** Uplinked console command (Dump, Dump stacks, Continue): like a small upload (§3.8.4). */
  dumpEnergy: 150,
  /** Dump replies that may wait for the downlink at once. */
  dumpQueueMax: 4,
  // Downlink (docs/SPEC.md §3.8.1): byte-based, shared by the log FIFO and the science recorder
  linkBytesPerTick: 2, // at @SIGNAL_STR 100, proportional to signal (Mk-I; chassis.linkBytesPerTick)
  linkMinSignal: 20, // nothing is sent below this
  linkEnergyPerTick: 2, // per tick in which at least one byte is sent

  // Camera (docs/SPEC.md §3.8.5): SNAP dir [mode]
  snapTicks: 10,
  snapEnergy: 200,
  sendTicks: 1, // SEND (M12, §3.8.7): image memory → recorder
  sendEnergy: 10, // a small cost (= a SCAN); the transmitter pays per byte on top
  eraseTicks: 2, // ERASE (M12, §3.8.7): zero image memory on request, like a flash erase
  eraseEnergy: 10,
  snapReach: 2, // subject: first obstacle / item / rover within this many tiles, else a landscape
  horizonRange: 16, // landscape: obstacles up to this far shape the skyline
  snapMinSunLight: 20, // @SUN_LIGHT needed for a lit photo (or the headlight aimed at the subject)
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
 * Machine-code size of Rover-ASM (docs/SPEC.md §5.7). Every instruction is one opcode byte
 * plus its operands; compile-time names (labels, ALIAS, CONST) emit nothing themselves.
 */
export const ENCODING = {
  opcode: 1,
  extOpcode: 2, // extension prefix 1F + the instruction's number (AND, OR, SHL, SHR, SEND, ERASE)
  register: 1, // operand byte: addressing mode + register index
  port: 1, // operand byte: addressing mode + port number
  shortImm: 1, // 0..shortImmMax packed into the operand byte itself
  shortImmMax: 15,
  imm8: 2, // operand byte + 1 data byte: -128..127
  imm16: 3, // + 2 data bytes: -32768..32767
  imm32: 5, // + 4 data bytes: anything else (registers are 32-bit)
  label: 2, // absolute 16-bit address of a jump / call target
} as const;

export interface ChassisDef {
  name: string;
  /** Program memory in bytes (see ENCODING). */
  flashBytes: number;
  registers: number;
  dataStack: number;
  callStack: number;
  cyclesPerTick: number;
  /** Log FIFO size in bytes (downlink, §3.8.3). */
  logFifoBytes: number;
  /** Science recorder size in bytes (§3.8.5). */
  recorderBytes: number;
  /** Downlink bytes per tick at full signal (§3.8.1). */
  linkBytesPerTick: number;
  /** Camera modes `SNAP dir mode` accepts (= photo product types, §3.8.5). */
  cameraModes: number[];
  sensorRange: number;
  cargoSlots: number;
  /** Tool mounted in each hardpoint TOOL_0..TOOL_3 (null = empty). */
  tools: Array<ToolId | null>;
  /** Energy units at 100 % (@BAT reports a percentage of this). */
  batteryCapacity: number;
  /** Solar output multiplier in percent. */
  solarPercent: number;
  /** Squall hull damage is applied every (hullEvery × hullArmor) ticks. */
  hullArmor: number;
}

export const CHASSIS_MK1: ChassisDef = {
  name: 'Rover Mk-I',
  flashBytes: 256, // M10: shared by firmware and program (was 128)
  registers: 4,
  dataStack: 8,
  callStack: 8,
  cyclesPerTick: 4,
  logFifoBytes: 32,
  recorderBytes: 1024,
  linkBytesPerTick: 2,
  cameraModes: [1, 2],
  sensorRange: 6,
  cargoSlots: 4,
  tools: ['DRILL', 'GRABBER', 'SPECTROMETER', null],
  batteryCapacity: 100_000,
  solarPercent: 100,
  hullArmor: 1,
};

/** Per-unit mutable copy (upgrades modify it in place, so the VM's reference stays valid). */
export function cloneChassis(c: ChassisDef): ChassisDef {
  return { ...c, tools: [...c.tools], cameraModes: [...c.cameraModes] };
}
