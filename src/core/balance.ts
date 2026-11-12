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
