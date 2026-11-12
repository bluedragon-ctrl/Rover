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
  nightSensorRange: 1, // always-sensed ring around the rover at night
  headlightSensorRange: 5, // headlight cone length (tiles ahead)
  headlightNearLength: 2, // first tiles of the cone ...
  headlightNearSpread: 1, // ... are 3 wide (|lateral| <= 1)
  headlightFarSpread: 2, // the rest is 5 wide
  turnEnergy: 5, // @HEADING write: turn in place

  // Comms
  txEnergy: 30,
  txMinSignal: 50,
  uploadBase: 500,
  uploadPerLine: 50,
  uploadSignalFloor: 10,

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
  flashLines: 32,
  registers: 4,
  dataStack: 8,
  callStack: 8,
  cyclesPerTick: 4,
  sensorRange: 6,
  cargoSlots: 4,
  tools: ['DRILL', 'GRABBER', 'SPECTROMETER', null],
  batteryCapacity: 100_000,
  solarPercent: 100,
  hullArmor: 1,
};

/** Per-unit mutable copy (upgrades modify it in place, so the VM's reference stays valid). */
export function cloneChassis(c: ChassisDef): ChassisDef {
  return { ...c, tools: [...c.tools] };
}
