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
}

export enum LightColor {
  OFF = 0,
  RED = 1,
  GREEN = 2,
  BLUE = 3,
  AMBER = 4,
}

export enum Layer {
  TERRAIN = 0,
  OBSTACLE = 1,
  ITEM = 2,
  ACTOR = 3,
}

export enum CpuState {
  RUNNING = 'RUNNING',
  BLOCKED = 'BLOCKED',
  FAULT = 'FAULT',
  POWER_OFF = 'POWER_OFF',
  DESTROYED = 'DESTROYED',
}

/** Wrap to signed 32-bit. */
export const i32 = (n: number): number => n | 0;

/** Euclidean floor division helpers for chunk math. */
export const floorDiv = (a: number, b: number): number => Math.floor(a / b);
export const emod = (a: number, b: number): number => ((a % b) + b) % b;
