/** All tunable gameplay numbers. See docs/SPEC.md §2–§3. */
export const BALANCE = {
  defaultTickHz: 10,
  watchdogTicks: 50,

  batteryCapacity: 100_000,
  idleDrainPerTick: 1,
  scanTicks: 1,
  scanEnergy: 10,
  coldBootPercent: 5,

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
};
