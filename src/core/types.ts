export enum Dir {
  NORTH = 0,
  EAST = 1,
  SOUTH = 2,
  WEST = 3,
}

/** NORTH = +Y, EAST = +X. */
export const DIR_VEC: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

export enum Status {
  OK = 0,
  ERR_INVALID = 1,
  ERR_FULL = 2,
  ERR_LOW_POWER = 3,
  ERR_BLOCKED = 4,
  ERR_NO_TOOL = 5,
  ERR_NO_SIGNAL = 6,
  ERR_HAZARD = 7,
  ERR_DEPLOYED = 8,
  /** The firmware took control back in the middle of the program's action (@PREEMPT, SPEC §3.9.2). */
  ERR_PREEMPTED = 9,
}

export enum LightColor {
  OFF = 0,
  RED = 1,
  GREEN = 2,
  BLUE = 3,
  AMBER = 4,
}

/** Repair targets for `USE slot [system]`. */
export enum SystemId {
  SYS_HULL = 0,
  SYS_SOLAR = 1,
  SYS_ANTENNA = 2,
}

export enum Alert {
  ALERT_NONE = 0,
  ALERT_ECLIPSE = 1,
  ALERT_SQUALL = 2,
}

export enum Layer {
  TERRAIN = 0,
  OBSTACLE = 1,
  ITEM = 2,
  ACTOR = 3,
}

/** @PROG_STATE (M10, SPEC §3.9.2). */
export enum ProgState {
  PROG_NONE = 0,
  PROG_READY = 1,
  PROG_RUNNING = 2,
  PROG_DONE = 3,
  PROG_FAULT = 4,
  PROG_HALTED = 5,
}

/** @PREEMPT condition bits (SPEC §3.9.2): what ends a program slice at once. */
export enum Preempt {
  PRE_ALERT = 1,
  PRE_DAMAGE = 2,
  PRE_LOW_BAT = 4,
}

export enum CpuState {
  RUNNING = 'RUNNING',
  BLOCKED = 'BLOCKED',
  /** Stopped by BRK until Continue or an upload (M9). No watchdog. */
  HALTED = 'HALTED',
  FAULT = 'FAULT',
  POWER_OFF = 'POWER_OFF',
  DESTROYED = 'DESTROYED',
}

/** Wrap to signed 32-bit. */
export const i32 = (n: number): number => n | 0;

/** Euclidean floor division helpers for chunk math. */
export const floorDiv = (a: number, b: number): number => Math.floor(a / b);
export const emod = (a: number, b: number): number => ((a % b) + b) % b;
