import { BALANCE, cloneChassis, type ChassisDef } from './balance';
import { CpuState, LightColor } from './types';
import type { ToolId } from './tools';
import { RoverVM } from './vm/RoverVM';

export type UnitAction =
  | { kind: 'WAIT'; ticksLeft: number }
  | { kind: 'STEP'; dir: number; tilesLeft: number; ticksLeft: number; toX: number; toY: number }
  | { kind: 'TOOL'; tool: ToolId; arg: number; arg2?: number; ticksLeft: number };

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
  energy: number;
  hull = 100;
  /** Subsystem integrity 0–100. Damaged systems work proportionally worse. */
  solarHealth = 100;
  antennaHealth = 100;
  cargo: number[];
  lightColor: number = LightColor.GREEN;
  lightBlink = 0;
  /** Three programmable indicator lamps on the cabin roof (LightColor each). Purely visual. */
  indicators: number[] = [0, 0, 0];
  headlight = 0;
  /** Commanded solar state 0/1 (@SOLAR_OPEN). */
  solarOpen = 0;
  /** Deployment progress, 0 (stowed) .. BALANCE.solarDeployTicks (fully open). */
  solarDeploy = 0;
  /** Current/target panel bearing; motors slew toward the target. */
  solarAngle = 0;
  solarTarget = 0;
  antennaAngle = 0;
  antennaTarget = 0;
  packetsSent = 0;
  /** Analyzed science waiting to be transmitted. */
  scienceReady = 0;
  lastTx: { tick: number; value: number; ok: boolean } | null = null;
  /** Energy gained from solar last tick (for UI). */
  lastSolarGain = 0;
  /** Cache key of the last fog reveal (x, y, range). */
  lastRevealKey = '';
  action: UnitAction | null = null;
  motion: UnitMotion | null = null;
  /** Cycles left in the current tick (lets the debugger single-step mid-tick). */
  cyclesLeft = 0;
  sourceCode = '';
  readonly vm: RoverVM;

  /** Last seismic scan result (TOOL_3 SEISMIC). */
  seismicType = 0;
  seismicDist = 0;
  /** Installed upgrade ids, in installation order. */
  upgrades: string[] = [];
  /** This rover's own stats: base chassis + upgrades. */
  readonly chassis: ChassisDef;

  constructor(readonly id: number, public name: string, base: ChassisDef) {
    const chassis = (this.chassis = cloneChassis(base));
    this.energy = chassis.batteryCapacity;
    this.vm = new RoverVM(chassis);
    this.cargo = new Array(chassis.cargoSlots).fill(0);
  }

  get batteryPercent(): number {
    return Math.floor((this.energy * 100) / this.chassis.batteryCapacity);
  }

  get solarDeployed(): boolean {
    return this.solarDeploy >= BALANCE.solarDeployTicks;
  }

  get solarStowed(): boolean {
    return this.solarDeploy === 0;
  }

  get powered(): boolean {
    return this.vm.state !== CpuState.POWER_OFF && this.vm.state !== CpuState.DESTROYED;
  }
}
