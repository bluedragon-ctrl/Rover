import { BALANCE, type ChassisDef } from './balance';
import { CpuState, LightColor } from './types';
import { RoverVM } from './vm/RoverVM';

export type UnitAction =
  | { kind: 'WAIT'; ticksLeft: number }
  | { kind: 'STEP'; dir: number; tilesLeft: number; ticksLeft: number; toX: number; toY: number };

export interface UnitMotion {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startTick: number;
  endTick: number;
}

export class Unit {
  x = 0;
  y = 0;
  /** Last direction moved or scanned; drives the renderer's heading. */
  heading = 0;
  energy: number = BALANCE.batteryCapacity;
  hull = 100;
  cargo: number[];
  lightColor: number = LightColor.GREEN;
  lightBlink = 0;
  headlight = 0;
  action: UnitAction | null = null;
  motion: UnitMotion | null = null;
  /** Cycles left in the current tick (lets the debugger single-step mid-tick). */
  cyclesLeft = 0;
  sourceCode = '';
  readonly vm: RoverVM;

  constructor(readonly id: number, public name: string, readonly chassis: ChassisDef) {
    this.vm = new RoverVM(chassis);
    this.cargo = new Array(chassis.cargoSlots).fill(0);
  }

  get batteryPercent(): number {
    return Math.floor((this.energy * 100) / BALANCE.batteryCapacity);
  }

  get powered(): boolean {
    return this.vm.state !== CpuState.POWER_OFF && this.vm.state !== CpuState.DESTROYED;
  }
}
