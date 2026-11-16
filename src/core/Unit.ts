import { BALANCE, cloneChassis, type ChassisDef } from './balance';
import { CpuState, ProgState } from './types';
import type { ToolId } from './tools';
import { Downlink, type ProductDesc } from './downlink';
import { freshParser, type ParserState } from './messages';
import { PHOTO_FORMATS_2X, photoBytes, type PhotoFormats } from './photos';
import type { RoverMachine } from './machine/RoverMachine';

/** Image memory size (SPEC §3.8.7): the largest photo the installed camera modes take. */
export const imageBytes = (c: Pick<ChassisDef, 'cameraModes'>, formats: PhotoFormats = PHOTO_FORMATS_2X): number =>
  c.cameraModes.reduce((n, m) => Math.max(n, photoBytes(m, formats)), 0);

/**
 * The computer's power and run state as the world sees it (power off, destroyed, a fault
 * waiting for the fault reset, halted at a breakpoint). The machine (`Unit.machine`) holds
 * the registers and memory.
 */
export class CpuStatus {
  state: CpuState = CpuState.RUNNING;
  faultReason = '';
  /** Ticks until the fault reset reboots a FAULTed CPU. */
  watchdog = 0;

  /** A hard reboot: the CPU runs again unless it has no power or no rover. */
  reboot(): void {
    this.faultReason = '';
    this.watchdog = 0;
    if (this.state !== CpuState.DESTROYED && this.state !== CpuState.POWER_OFF) this.state = CpuState.RUNNING;
  }

  halt(): void {
    this.state = CpuState.HALTED;
  }

  resume(): void {
    if (this.state === CpuState.HALTED) this.state = CpuState.RUNNING;
  }

  fault(reason: string, watchdogTicks: number): void {
    this.state = CpuState.FAULT;
    this.faultReason = reason;
    this.watchdog = watchdogTicks;
  }
}

/**
 * What the camera saw at the last SNAP (M12): the photo fields of a product descriptor plus
 * the noise seed its bytes were generated with. The first SEND of the same type carries it.
 */
export type Capture = Pick<ProductDesc, 'type' | 'subject' | 'x' | 'y' | 'sx' | 'sy' | 'lit' | 'horizon' | 'anomaly' | 'x2'> & { noise: { tick: number; seq: number } };

/**
 * The chassis' mechanical work (drive, tools, repair, camera: they share the
 * chassis and the arm, so one at a time). `tilesLeft` counts the tile in progress;
 * `stop`: `DRVCNT` 0 asked to stop at the end of this tile.
 */
export type UnitAction =
  | { kind: 'STEP'; dir: number; tilesLeft: number; ticksLeft: number; toX: number; toY: number; stop?: boolean }
  | { kind: 'TOOL'; tool: ToolId; arg: number; arg2?: number; ticksLeft: number };

/** Devices with a progress count and a result (the I/O page's device blocks, SPEC §5.6). */
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
  /** Direction the rover faces (the drive, directional tools, `HDG`). Aims the headlight cone. */
  heading = 0;
  energy: number;
  hull = 100;
  /** Subsystem integrity 0–100. Damaged systems work proportionally worse. */
  solarHealth = 100;
  antennaHealth = 100;
  cargo: number[];
  /** The rover's three status lamps on the cabin roof (`IND1`–`IND3`, a LightColor each). Purely visual. */
  indicators: number[] = [0, 0, 0];
  /** `DISP`: two-digit hex display on the back of the cabin (0–255). Visual only, survives reboots. */
  post = 0;
  headlight = 0;
  /** Commanded solar state 0/1 (`SOLOPN`). */
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
   * power-off; only a photo (overwrites) and the erase (`F.ERAS`) clear it. Grows with camera upgrades; use
   * imageMemory() to read it at the right size.
   */
  img = new Uint8Array(0);
  /** The last SNAP's capture, until `SNDIMG` of the same type takes it home. */
  capture: Capture | null = null;
  /**
   * M15: the recorder's own view of the CPU's messages (`RECBUF`), so it knows where a photo
   * starts. A `SNDIMG` header (T.IMG chunk 0) takes the capture of its type with it, as
   * today's send did; ground pairs them in order (PDP11_IO.md §3.5a).
   */
  recParser: ParserState = freshParser();
  /** M15: why the rover last booted (`BOOTCS` bits 7–0). */
  bootReason = 0;
  /** M15: ticks of the fault and watchdog reboots in the last PDP11.safeModeTicks (`BOOTCT`). */
  faultBoots: number[] = [];
  /** M15: safe mode latched (`BOOTCS` SAFE): kept through reboots, cleared by a firmware upload. */
  safeMode = false;
  imgCaps: Array<Capture | null> = [];
  /** Mode of the last SNAP (`IMGTYP`: `SNDIMG` with R0 = 0 sends that). */
  snapMode = 1;
  /** Energy gained from solar last tick (for UI). */
  lastSolarGain = 0;
  /** Cache key of the last fog reveal (x, y, range). */
  lastRevealKey = '';
  action: UnitAction | null = null;
  motion: UnitMotion | null = null;

  // Device parameters latched by the I/O page:
  /** `DRVCNT`: tiles per drive. */
  driveN = 1;
  /** `TOLARG`: direction / slot. */
  toolArg = 0;
  /** The repair's system (its FN). */
  repairSys = 0;
  /** The camera mode (its FN). */
  camMode = 1;
  /** `SLICE` as the firmware wrote it: ticks the next program run may last (0 = no limit). */
  sliceSet = 0;
  /** Radar sweep in progress (ticks left), its direction, and the last answer. */
  radarTicks = 0;
  radarDir = 0;
  radarHit = 0;
  radarDist = 0;
  /** Image send / erase in progress. */
  imgOp: { kind: 'send' | 'erase'; ticksLeft: number } | null = null;
  /** Each device's result (`xxER`, 0 = OK). */
  results: Record<Device, number> = { drive: 0, radar: 0, tool: 0, repair: 0, cam: 0, send: 0, erase: 0 };

  /** Work left: tiles (drive) or ticks, 0 = idle (DONE). */
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
  /** The computer: the bus, both contexts and the CPU (set by the engine when the rover is created). */
  machine!: RoverMachine;
  /** Power, halts and faults of the computer. */
  readonly cpu = new CpuStatus();
  /** Program slot source ('' = no program, SPEC §3.9). */
  programSource = '';
  /** Bytes of each slot's image, from their last successful assembly. */
  firmwareBytes = 0;
  programBytes = 0;
  progState: ProgState = ProgState.PROG_NONE;
  progResult = 0;
  /** -1 when the firmware has control; during a program run the ticks left of its `SLICE`, or 0 for no limit. */
  slice = -1;

  /**
   * `WDT` (SPEC §3.9.5): ticks until the watchdog reboots the rover; 0 = not armed. CPU state:
   * a hard reboot disarms it.
   */
  wdt = 0;
  /** `PREMPT` condition mask, `BATALM` threshold and `PRMPTD` (what ended the last slice early). CPU state. */
  preemptMask = 0;
  batAlarm = 0;
  preempted = 0;
  /** Internal temperature in °C (`TEMP`, SPEC §3.3.4) and whether the survival heaters ran this tick (`HEATER`). */
  temp = 0;
  heater = 0;
  /** Dust on the solar array, 0–100 % (`SOLDST`): charging is scaled by what is left. */
  solarDust = 0;

  /** Last seismic scan result (TOOL_3 SEISMIC). */
  seismicType = 0;
  seismicDist = 0;
  /** Installed upgrade ids, in installation order. */
  upgrades: string[] = [];
  /** This rover's own stats: base chassis + upgrades. */
  readonly chassis: ChassisDef;

  /** Science recorder size in bytes. */
  get recorderBytes(): number {
    return this.chassis.recorderBytes;
  }

  /** Downlink bytes per tick at full signal. */
  get linkBytesPerTick(): number {
    return this.chassis.linkBytesPerTick;
  }

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

  /** ERASE: image memory zeroed, the capture dropped (SPEC §3.8.7). */
  clearImageMemory(): void {
    this.img.fill(0);
    this.capture = null;
  }

  constructor(readonly id: number, public name: string, base: ChassisDef) {
    const chassis = (this.chassis = cloneChassis(base));
    this.energy = chassis.batteryCapacity;
    this.cargo = new Array(chassis.cargoSlots).fill(0);
    this.img = new Uint8Array(imageBytes(chassis));
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
    return this.cpu.state !== CpuState.POWER_OFF && this.cpu.state !== CpuState.DESTROYED;
  }
}
