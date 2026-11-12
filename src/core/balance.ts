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

  // Sensors
  nightSensorRange: 1,
  headlightSensorRange: 5,

  // Comms
  txEnergy: 30,
  txMinSignal: 50,
  uploadBase: 500,
  uploadPerLine: 50,
  uploadSignalFloor: 10,

  // Storyteller (docs/SPEC.md §3.5)
  eventEarliestTick: 1500, // grace period for new worlds
  eventWarnTicks: 200,
  eclipseChancePerSol: 0.35,
  eclipseTicks: 150,
  eclipseRampTicks: 20,
  squallChancePerSol: 0.4,
  squallTicks: 100,
  squallHullEveryTicks: 10, // 1 hull damage; twice as often while driving
  squallSolarEveryTicks: 3, // squallSolarDamage every N ticks while the array is not fully stowed
  squallSolarDamage: 2,
  squallAntennaEveryTicks: 20, // the dish is always exposed

  chunkBubbleRadius: 1, // 3x3 chunks around each rover
  chunkEvictAfterTicks: 600,
  landingZoneRadius: 2, // 5x5
} as const;

export interface ChassisDef {
  name: string;
  flashLines: number;
  registers: number;
  dataStack: number;
  callStack: number;
  cyclesPerTick: number;
  sensorRange: number;
  cargoSlots: number;
  /** Tool mounted in each hardpoint TOOL_0..TOOL_3 (null = empty). */
  tools: ReadonlyArray<ToolId | null>;
}

export const CHASSIS_MK1: ChassisDef = {
  name: 'Rover Mk-I',
  flashLines: 32,
  registers: 4,
  dataStack: 8,
  callStack: 8,
  cyclesPerTick: 4,
  sensorRange: 6,
  cargoSlots: 4,
  tools: ['DRILL', 'GRABBER', 'SPECTROMETER', null],
};
