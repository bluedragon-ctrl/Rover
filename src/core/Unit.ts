import { BALANCE, cloneChassis, type ChassisDef } from './balance';
import { CpuState, ProgState } from './types';
import type { ToolId } from './tools';
import { RoverVM } from './vm/RoverVM';
import { Downlink } from './downlink';

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
  /** Direction the rover faces (STEP, directional tools, @HEADING). Aims the headlight cone. */
  heading = 0;
  energy: number;
  hull = 100;
  /** Subsystem integrity 0–100. Damaged systems work proportionally worse. */
  solarHealth = 100;
  antennaHealth = 100;
  cargo: number[];
  /** The rover's three status lamps on the cabin roof (@IND1..3, a LightColor each). Purely visual. */
  indicators: number[] = [0, 0, 0];
  /** @POST: two-digit hex display on the back of the cabin (0–255). Visual only, survives reboots. */
  post = 0;
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
  /** Byte downlink: log FIFO, science recorder, transmitter (M9). */
  link = new Downlink();
  /** Energy gained from solar last tick (for UI). */
  lastSolarGain = 0;
  /** Cache key of the last fog reveal (x, y, range). */
  lastRevealKey = '';
  action: UnitAction | null = null;
  motion: UnitMotion | null = null;
  /** Cycles left in the current tick (lets the debugger single-step mid-tick). */
  cyclesLeft = 0;
  /** Firmware source (the firmware slot). */
  sourceCode = '';
  /** Firmware context. Its state is the CPU's state (power, faults, halts). */
  readonly vm: RoverVM;
  /** M10: program slot source ('' = no program) and its own context (SPEC §3.9). */
  programSource = '';
  readonly prog: RoverVM;
  /** Flash bytes of each slot, from their last successful compile. */
  firmwareBytes = 0;
  programBytes = 0;
  progState: ProgState = ProgState.PROG_NONE;
  progResult = 0;
  /** Ticks left in the program's current RUN slice; -1 when the firmware has control. */
  slice = -1;

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
    this.prog = new RoverVM(chassis);
    this.cargo = new Array(chassis.cargoSlots).fill(0);
  }

  /** The context that executes now: the program inside a RUN slice, else the firmware. */
  get cpu(): RoverVM {
    return this.slice >= 0 ? this.prog : this.vm;
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
