import { BALANCE, cloneChassis, type ChassisDef } from './balance';
import { CpuState, ProgState } from './types';
import type { ToolId } from './tools';
import { RoverVM } from './vm/RoverVM';
import { Downlink, type ProductDesc } from './downlink';
import { photoBytes } from './photos';

/** Image memory size (SPEC §3.8.7): the largest photo the installed camera modes take. */
export const imageBytes = (c: Pick<ChassisDef, 'cameraModes'>): number => c.cameraModes.reduce((n, m) => Math.max(n, photoBytes(m)), 0);

/**
 * What the camera saw at the last SNAP (M12): the photo fields of a product descriptor plus
 * the noise seed its bytes were generated with. The first SEND of the same type carries it.
 */
export type Capture = Pick<ProductDesc, 'type' | 'subject' | 'x' | 'y' | 'sx' | 'sy' | 'lit' | 'horizon' | 'anomaly'> & { noise: { tick: number; seq: number } };

/**
 * The chassis' mechanical work (M14 devices drive, tools, repair, camera: they share the
 * chassis and the arm, so one at a time). `tilesLeft` counts the tile in progress;
 * `stop`: @DRIVE_N 0 asked to stop at the end of this tile.
 */
export type UnitAction =
  | { kind: 'STEP'; dir: number; tilesLeft: number; ticksLeft: number; toX: number; toY: number; stop?: boolean }
  | { kind: 'TOOL'; tool: ToolId; arg: number; arg2?: number; ticksLeft: number };

/** M14 devices with a progress port and a result (docs/ASSEMBLER_CORE.md §4). The timer is per slot (RoverVM.timer). */
export type Device = 'drive' | 'radar' | 'tool' | 'repair' | 'cam' | 'send' | 'erase';
export const DEVICES: readonly Device[] = ['drive', 'radar', 'tool', 'repair', 'cam', 'send', 'erase'];

/** Which device a tool action belongs to. */
export const toolDevice = (t: ToolId): Device => (t === 'USE_ITEM' ? 'repair' : t === 'CAMERA' ? 'cam' : 'tool');

/** Device state that a hard reboot resets (latched arguments, results, radar and image work). */
export function resetDevices(u: Unit): void {
  u.driveN = 1;
  u.toolArg = 0;
  u.repairSys = 0;
  u.camMode = 1;
  u.sliceSet = 0;
  u.radarTicks = 0;
  u.radarDir = 0;
  u.imgOp = null;
  for (const d of DEVICES) u.results[d] = 0;
}

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
  /** Direction the rover faces (the drive, directional tools, @HEADING). Aims the headlight cone. */
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
  /**
   * M12 image memory (SPEC §3.8.7). Non-volatile, like a camera's flash: survives reboots and
   * power-off; only a photo (overwrites) and @ERASE clear it. Grows with camera upgrades; use
   * imageMemory() to read it at the right size.
   */
  img = new Uint8Array(0);
  /** The last SNAP's capture, until a SEND of the same type carries it home. */
  capture: Capture | null = null;
  /** Mode of the last SNAP: the default type of SEND. */
  snapMode = 1;
  /** An STB since the last SNAP (the next SEND is EDITED, not RAW). */
  imgEdited = false;
  /** Energy gained from solar last tick (for UI). */
  lastSolarGain = 0;
  /** Cache key of the last fog reveal (x, y, range). */
  lastRevealKey = '';
  action: UnitAction | null = null;
  motion: UnitMotion | null = null;

  // M14 devices (docs/ASSEMBLER_CORE.md §4). Latched arguments:
  /** @DRIVE_N tiles per drive (1 after a reboot). */
  driveN = 1;
  /** @TOOL_ARG direction / slot. */
  toolArg = 0;
  /** @REPAIR_SYS (SYS_HULL after a reboot). */
  repairSys = 0;
  /** @CAM_MODE (1 after a reboot). */
  camMode = 1;
  /** @SLICE as the firmware wrote it: ticks the next CALL PROGRAM may run (0 = no limit). */
  sliceSet = 0;
  /** Radar sweep in progress (ticks left), its direction, and the last answer. */
  radarTicks = 0;
  radarDir = 0;
  radarHit = 0;
  radarDist = 0;
  /** Image send / erase in progress. */
  imgOp: { kind: 'send' | 'erase'; ticksLeft: number } | null = null;
  /** Each device's result: copied into @STATUS by `WAIT @port` (0 = OK). */
  results: Record<Device, number> = { drive: 0, radar: 0, tool: 0, repair: 0, cam: 0, send: 0, erase: 0 };

  /** Progress port value: tiles (drive) or ticks left, 0 = idle. */
  deviceLeft(d: Device): number {
    const a = this.action;
    switch (d) {
      case 'drive':
        return a?.kind === 'STEP' ? a.tilesLeft : 0;
      case 'radar':
        return this.radarTicks;
      case 'send':
      case 'erase':
        return this.imgOp?.kind === d ? this.imgOp.ticksLeft : 0;
      default:
        return a?.kind === 'TOOL' && toolDevice(a.tool) === d ? a.ticksLeft : 0;
    }
  }
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
  /**
   * -1 when the firmware has control; inside CALL PROGRAM the ticks left of the slice (M14
   * @SLICE), or 0 for a call without a time limit.
   */
  slice = -1;

  /**
   * @WDT (SPEC §3.9.5): ticks until the watchdog reboots the rover; 0 = not armed. CPU state:
   * a hard reboot disarms it.
   */
  wdt = 0;
  /** @PREEMPT condition mask, @BAT_ALARM threshold and @PREEMPTED (what ended the last slice early). CPU state. */
  preemptMask = 0;
  batAlarm = 0;
  preempted = 0;
  /** Internal temperature in °C (@TEMP, SPEC §3.3.4) and whether the survival heaters ran this tick (@HEATER). */
  temp = 0;
  heater = 0;
  /** Dust on the solar array, 0–100 % (@SOLAR_DUST): charging is scaled by what is left. */
  solarDust = 0;

  /** Last seismic scan result (TOOL_3 SEISMIC). */
  seismicType = 0;
  seismicDist = 0;
  /** Installed upgrade ids, in installation order. */
  upgrades: string[] = [];
  /** This rover's own stats: base chassis + upgrades. */
  readonly chassis: ChassisDef;

  /** Image memory at its current size (grows, keeping its contents, when an upgrade adds a camera mode). */
  imageMemory(): Uint8Array {
    const n = imageBytes(this.chassis);
    if (this.img.length < n) {
      const grown = new Uint8Array(n);
      grown.set(this.img);
      this.img = grown;
    }
    return this.img;
  }

  /**
   * M14 RAM (docs/ASSEMBLER_CORE.md §7): shared by firmware and program, zero after a hard
   * reboot. Grows with RAM upgrades; read it through ramMemory().
   */
  ram = new Uint8Array(0);
  /** RAM top the firmware was assembled for (its VARs count down from here); 0 = the chassis RAM. */
  fwRamTop = 0;
  /** RAM taken by each slot's VARs, [low, high), from their last successful compile. */
  firmwareRam = { low: 0, high: 0 };
  programRam = { low: 0, high: 0 };

  ramMemory(): Uint8Array {
    if (this.ram.length < this.chassis.ramBytes) {
      const grown = new Uint8Array(this.chassis.ramBytes);
      grown.set(this.ram);
      this.ram = grown;
    }
    return this.ram;
  }

  /** ERASE: image memory zeroed, the capture dropped (SPEC §3.8.7). */
  clearImageMemory(): void {
    this.img.fill(0);
    this.capture = null;
    this.imgEdited = false;
  }

  constructor(readonly id: number, public name: string, base: ChassisDef) {
    const chassis = (this.chassis = cloneChassis(base));
    this.energy = chassis.batteryCapacity;
    this.vm = new RoverVM(chassis);
    this.prog = new RoverVM(chassis, true);
    this.cargo = new Array(chassis.cargoSlots).fill(0);
    this.img = new Uint8Array(imageBytes(chassis));
    this.ram = new Uint8Array(chassis.ramBytes);
  }

  /** The context that executes now: the program inside CALL PROGRAM, else the firmware. */
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
