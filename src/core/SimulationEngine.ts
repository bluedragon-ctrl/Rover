import { BALANCE, CHASSIS_MK1, MEMORY_MAP, type ChassisDef } from './balance';
import { ChunkedWorld } from './ChunkedWorld';
import { EventBus } from './EventBus';
import { MapGenerator } from './MapGenerator';
import { EventDirector } from './EventDirector';
import { hash3 } from './rng';
import {
  BootReason,
  DumpKind,
  encodeCpuDump,
  encodeLog,
  encodeStackDump,
  GALLERY_KEEP,
  isPhoto,
  Level,
  productFrameBytes,
  RECEIVED_KEEP,
  SYSTEM_TAG,
  type ProductDesc,
  type ReceivedFrame,
  type ReceivedProduct,
} from './downlink';
import { UPGRADE_BY_ID } from './upgrades';
import type { SquallDamage } from './events';
import { TOOLS, type ToolDef } from './tools';
import { ambientTemp, Environment, signalStrength, solarGain, wrapDeg, angleDiff, type SunState } from './Environment';
import { getPort, writePortClamped, type PortContext } from './ports';
import { CpuState, DIR_VEC, Layer, Preempt, ProgState, Status } from './types';
import { Unit, type Capture } from './Unit';
import { productPayload, toHex } from './imaging';
import { compile, type CompileResult, type Instr, type Slot } from './vm/Compiler';
import type { VmHost } from './vm/RoverVM';
import { HORIZON_COLUMNS, HORIZON_V, isAnomaly, photoBytes, type HorizonView } from './photos';
import { coneOffsets, shapeContains, type SensorShape } from './sensors';
import { createDefaultRegistry, T, type WorldRegistry } from './WorldRegistry';

export interface EngineOptions {
  seed: number;
  registry?: WorldRegistry;
}

export interface SupplyDrop {
  id: number;
  upgrade: string;
  x: number;
  y: number;
  landTick: number;
  landed: boolean;
}

/** Commands sent over the uplink (Code tab dump box; SPEC §3.8.4). */
export type UplinkCommand = 'DUMP' | 'DUMP_STACKS' | 'CONTINUE' | 'RUN_AGAIN';
export const UPLINK_COMMAND_NAMES: Record<UplinkCommand, string> = { DUMP: 'Dump', DUMP_STACKS: 'Dump stacks', CONTINUE: 'Continue', RUN_AGAIN: 'Run again' };

/** Everything mission control can send up: console commands and code uploads. */
export type SentKind = UplinkCommand | 'PROGRAM' | 'FIRMWARE';
/** Mission control's record of one accepted uplink transmission (Comms timeline, saved). */
export interface SentRecord {
  unitId: number;
  tick: number;
  kind: SentKind;
  /** Slot the command or upload addressed. */
  slot: Slot;
  /** Uploads: bytes flashed (0 = program erased). */
  bytes?: number;
  /** Battery spent (thousandths of the battery, like `energy`). */
  cost: number;
  /** Set when the rover could not take it (no power, battery, queue full): nothing was sent. */
  rejected?: string;
}
/** Sent records mission control keeps (saved). */
export const SENT_KEEP = 100;

/**
 * What a mission-log message is about: the world and the game (`world`), a receipt for
 * something mission control sent (`sent`: the Comms timeline shows it too), or the rover's
 * own state (`rover`).
 */
export type LogCategory = 'world' | 'sent' | 'rover';

export interface UploadResult extends CompileResult {
  /** Energy charged for the upload (0 if rejected or free). */
  cost: number;
  /** Set when the program compiled but the rover could not accept it. */
  rejected?: string;
}

/**
 * Headless, deterministic simulation. No DOM, no Three.js, no wall-clock time.
 * Drive it with tick() (or a SimClock) and observe it through `events`.
 */
export class SimulationEngine {
  readonly events = new EventBus();
  readonly registry: WorldRegistry;
  readonly world: ChunkedWorld;
  readonly units: Unit[] = [];
  readonly env = new Environment();
  readonly cheats = { freeUpload: false, invulnerable: false };
  readonly director: EventDirector;
  /** World-wide counters used by goals and the UI. */
  readonly stats = {
    /** Firmware frames received by mission control: LOG frames (not system tag 15) and science products. */
    framesReceived: 0,
    /** Science products delivered completely. */
    scienceDelivered: 0,
    oreMined: 0,
    itemsCollected: 0,
    itemsAnalyzed: 0,
    maxDistance: 0,
    sunrisesPowered: 0,
    eclipsesSurvived: 0,
    repairs: 0,
    upgradesInstalled: 0,
    squallsWeathered: 0,
    /** SNAP photos recorded / lit photos delivered completely. */
    photosTaken: 0,
    photosDelivered: 0,
    /** Correct anomaly flags on new anomaly tiles. */
    anomaliesFound: 0,
    /** M12: lit edited photos delivered completely. */
    photosEdited: 0,
  };
  /** Anomaly tiles already credited ("x,y"; saved). */
  anomalyTiles: string[] = [];
  /** Subject tile types already delivered in a lit photo (first-of-a-kind bonus, saved). */
  photoSubjects: number[] = [];
  /** M12: photo types (camera modes) already delivered as a lit edited photo (first-edit bonus, saved). */
  editedTypes: number[] = [];
  /** Science credits: delivered science + goal rewards. Spent on upgrades. */
  credits = 0;
  /** Ordered upgrades: in flight (landed=false) or waiting on the ground. */
  drops: SupplyDrop[] = [];
  nextDropId = 1;
  tick = 0;
  sun: SunState;
  orbitAzimuth: number;
  nextUnitId = 1;
  /** Mission control: frames received over the downlink (newest last, last RECEIVED_KEEP). */
  received: ReceivedFrame[] = [];
  /** Mission control: science products received or being received (newest last, last GALLERY_KEEP). */
  gallery: ReceivedProduct[] = [];
  /** Mission control: what it sent over the uplink (newest last, last SENT_KEEP). */
  sent: SentRecord[] = [];
  readonly portCtx: PortContext;

  constructor(readonly opts: EngineOptions) {
    this.registry = opts.registry ?? createDefaultRegistry();
    this.world = new ChunkedWorld(new MapGenerator(opts.seed));
    this.world.onTileChanged = (x, y, layer, id) => this.events.emit('TILE_CHANGED', { x, y, layer, id });
    this.director = new EventDirector(this);
    this.sun = this.env.sun(0);
    this.orbitAzimuth = this.env.orbitAzimuth(0);
    const self = this;
    this.portCtx = {
      get tick() {
        return self.tick;
      },
      get sun() {
        return self.sun;
      },
      get orbitAzimuth() {
        return self.orbitAzimuth;
      },
      world: this.world,
      registry: this.registry,
      sensorRange: (u) => this.sensorRange(u),
      turn: (u, dir) => this.turn(u, dir),
      alert: () => this.director.alert(this.tick),
      drops: () => this.drops.filter((d) => d.landed),
      nearestDrop: (u) => this.nearestDrop(u),
      transmit: (u, v) => this.transmit(u, v),
      setProgState: (u, v) => this.setProgState(u, v),
    };
  }

  get seed(): number {
    return this.opts.seed;
  }

  spawnUnit(name: string, x = 0, y = 0, chassis: ChassisDef = CHASSIS_MK1): Unit {
    const u = new Unit(this.nextUnitId++, name, chassis);
    u.x = x;
    u.y = y;
    u.temp = ambientTemp(this.sun.light);
    this.units.push(u);
    this.world.touchRadius(x, y, BALANCE.chunkBubbleRadius);
    this.revealAround(u);
    return u;
  }

  /** Save/load: recreate a unit with a known id (no reveal, no program). */
  restoreUnit(id: number, name: string, chassis: ChassisDef): Unit {
    const u = new Unit(id, name, chassis);
    this.units.push(u);
    return u;
  }

  /** Recompute state derived from the tick (sun, orbiter, eclipse light) after a load. */
  refreshDerived(): void {
    this.director.applyEnvironment(this.tick);
    this.sun = this.env.sun(this.tick);
    this.orbitAzimuth = this.env.orbitAzimuth(this.tick);
    for (const u of this.units) this.world.touchRadius(u.x, u.y, BALANCE.chunkBubbleRadius);
  }

  getUnit(id: number): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  unitAt(x: number, y: number): Unit | undefined {
    return this.units.find((u) => u.x === x && u.y === y);
  }

  /**
   * Compile for a slot; the other slot's bytes count against the shared flash (SPEC §3.9.1)
   * and its VARs against the shared RAM (M14). The installed firmware compiles for the RAM
   * top it was flashed with, so its VARs keep their addresses after a RAM upgrade.
   */
  compileFor(unit: Unit, source: string, slot: Slot = 'firmware', opts: { fresh?: boolean } = {}): CompileResult {
    const otherBytes = slot === 'firmware' ? unit.programBytes : unit.firmwareBytes;
    const otherRam = slot === 'firmware' ? unit.programRam : unit.firmwareRam;
    const installed = slot === 'firmware' && !opts.fresh && unit.fwRamTop && source === unit.sourceCode;
    const ramTop = installed ? unit.fwRamTop : unit.chassis.ramBytes;
    return compile(source, unit.chassis, this.registry.constants(), { slot, otherBytes, otherRam, ramTop });
  }

  signalOf(u: Unit): number {
    return Math.floor((signalStrength(u.antennaAngle, this.orbitAzimuth) * u.antennaHealth) / 100);
  }

  /**
   * What the operator (player) sees around `u` right now: mapped into the fog of war and
   * lit by the renderer (shared with TileLighting; see sensors.ts). Needs light: daylight,
   * or at night the ring plus the headlight cone. The rover's own SCAN is radar and does
   * not depend on this.
   */
  viewShape(u: Unit): SensorShape {
    if (this.sun.elevation > 0) return { radius: BALANCE.dayViewRange, cone: -1 };
    return { radius: BALANCE.nightSensorRange, cone: u.headlight && u.powered ? u.heading : -1 };
  }

  /** Can the operator see the tile at offset (dx, dy) from `u` right now? */
  isVisible(u: Unit, dx: number, dy: number): boolean {
    return shapeContains(this.viewShape(u), dx, dy);
  }

  /** SCAN (radar) range in tiles: any direction, day or night (@SENSOR_RANGE). */
  sensorRange(u: Unit): number {
    return u.chassis.sensorRange;
  }

  /** Turn in place (@HEADING write). Costs a little energy; no-op if already facing `dir`. */
  private turn(u: Unit, dir: number): void {
    if (!u.powered || dir === u.heading) return;
    this.drain(u, BALANCE.turnEnergy);
    if (!u.powered) return;
    u.heading = dir;
  }

  /** Energy needed to flash a program of `bytes` at the current signal strength. */
  uploadCost(u: Unit, bytes: number): number {
    if (this.cheats.freeUpload) return 0;
    const base = BALANCE.uploadBase + BALANCE.uploadPerByte * bytes;
    return Math.ceil((base * 100) / Math.max(BALANCE.uploadSignalFloor, this.signalOf(u)));
  }

  /** Energy to upload a program of `bytes` (no reboot, smaller base: SPEC §3.9.3). */
  programUploadCost(u: Unit, bytes: number): number {
    if (this.cheats.freeUpload) return 0;
    const base = BALANCE.programUploadBase + BALANCE.uploadPerByte * bytes;
    return Math.ceil((base * 100) / Math.max(BALANCE.uploadSignalFloor, this.signalOf(u)));
  }

  /** Energy for an uplinked console command (Dump, Dump stacks, Continue, Run again). */
  commandCost(u: Unit): number {
    if (this.cheats.freeUpload) return 0;
    return Math.ceil((BALANCE.dumpEnergy * 100) / Math.max(BALANCE.uploadSignalFloor, this.signalOf(u)));
  }

  /**
   * Uplink a console command. Dumps snapshot the CPU now and queue the reply ahead of the
   * log; Continue ends a BRK halt (a running rover just ignores it). Returns why it was
   * rejected, or null. Mission control learns the CPU state only from the reply.
   */
  command(u: Unit, cmd: UplinkCommand, slot: Slot = 'firmware'): string | null {
    const isDump = cmd === 'DUMP' || cmd === 'DUMP_STACKS';
    const cost = this.commandCost(u);
    const target: Slot = cmd === 'RUN_AGAIN' ? 'program' : slot;
    let err: string | null = null;
    if (!u.powered) err = `rover is ${u.vm.state}: it cannot receive commands`;
    else if (isDump && u.link.sys.length >= BALANCE.dumpQueueMax) err = `${BALANCE.dumpQueueMax} dumps are already waiting for the downlink`;
    else if (cmd === 'RUN_AGAIN' && !this.hasProgram(u)) err = 'no program in flash';
    else if (u.energy <= cost) err = `needs ${(cost / 1000).toFixed(1)}% battery at signal ${this.signalOf(u)}`;
    if (err) {
      this.recordSent({ unitId: u.id, tick: this.tick, kind: cmd, slot: target, cost: 0, rejected: err });
      return err;
    }
    u.energy -= cost;
    const prog = slot === 'program';
    const vm = prog ? u.prog : u.vm;
    if (cmd === 'DUMP') this.queueRegisterDump(u, slot);
    else if (cmd === 'DUMP_STACKS') {
      u.link.sys.push({ bytes: encodeStackDump(vm.dataStack, vm.callStack, prog ? DumpKind.PROG_STACKS : DumpKind.STACKS), taken: this.tick });
    } else if (cmd === 'RUN_AGAIN') this.restartProgram(u);
    else if (!prog) vm.resume();
    else if (u.progState === ProgState.PROG_HALTED) {
      u.prog.resume();
      u.progState = ProgState.PROG_READY;
    }
    const costMsg = cost ? ` (${(cost / 1000).toFixed(1)}% battery at signal ${this.signalOf(u)})` : '';
    const slotMsg = isDump || cmd === 'CONTINUE' ? ` (${slot})` : '';
    this.log(u, 'info', `Uplink: ${UPLINK_COMMAND_NAMES[cmd]}${slotMsg} sent${costMsg}.`, 'sent');
    this.recordSent({ unitId: u.id, tick: this.tick, kind: cmd, slot: target, cost });
    return null;
  }

  /** Queue a register dump of one slot, taken now (uplinked DUMP, or BRK: SPEC §3.8.4). */
  private queueRegisterDump(u: Unit, slot: Slot): void {
    const prog = slot === 'program';
    const vm = prog ? u.prog : u.vm;
    const d = { ip: vm.nextIp, status: vm.status, state: prog ? u.progState : vm.state, regs: vm.regs, dsDepth: vm.dataStack.length, csDepth: vm.callStack.length };
    u.link.sys.push({ bytes: encodeCpuDump(d, prog ? DumpKind.PROG_CPU : DumpKind.CPU), taken: this.tick });
  }

  private recordSent(r: SentRecord): void {
    this.sent.push(r);
    if (this.sent.length > SENT_KEEP) this.sent.splice(0, this.sent.length - SENT_KEEP);
  }

  // ---------------------------------------------------------------- program slot (M10)

  hasProgram(u: Unit): boolean {
    return (u.prog.program?.instrs.length ?? 0) > 0;
  }

  /** End the running RUN slice: the firmware continues with the instruction after RUN next tick. */
  private endSlice(u: Unit, state: ProgState): void {
    if (u.slice < 0) return;
    u.slice = -1;
    u.progState = state;
    u.cyclesLeft = 0;
    u.vm.unblock();
  }

  /** Fresh program context (restart from the top); aborts a running slice and the program's action. */
  private restartProgram(u: Unit): void {
    if (u.slice >= 0) {
      u.action = null;
      this.endSlice(u, ProgState.PROG_READY);
    }
    u.prog.reboot();
    u.progResult = 0;
    u.progState = this.hasProgram(u) ? ProgState.PROG_READY : ProgState.PROG_NONE;
  }

  /** Firmware write to @PROG_STATE: PROG_NONE acknowledges, PROG_READY restarts (SPEC §3.9.2). */
  private setProgState(u: Unit, v: number): void {
    if (!this.hasProgram(u)) return;
    if (v === ProgState.PROG_NONE) u.progState = ProgState.PROG_NONE;
    else if (v === ProgState.PROG_READY) this.restartProgram(u);
  }

  /** Hard reboot of the whole CPU: both contexts reset, the program becomes READY again. */
  private hardReboot(u: Unit, reason: number): void {
    u.slice = -1;
    u.action = null;
    // Control registers are CPU state: the watchdog is disarmed, fault protection off.
    u.wdt = 0;
    u.preemptMask = 0;
    u.batAlarm = 0;
    u.preempted = 0;
    u.ramMemory().fill(0); // M14: RAM is zero after a hard reboot
    u.vm.reboot();
    this.restartProgram(u);
    this.booted(u, reason);
  }

  /** Save migration (M14): the rover's code was rewritten for a new language version; restart it. */
  rebootAfterUpdate(u: Unit): void {
    if (!u.powered) return;
    this.hardReboot(u, BootReason.UPDATE);
    this.log(u, 'warn', 'Software update: the game rewrote this rover\'s code for the new language and rebooted it.', 'rover');
  }

  /** Power loss or destruction: the slice is gone with the CPU (the reboot resets the program). */
  private abortSlice(u: Unit): void {
    u.slice = -1;
  }

  /**
   * Upload the program slot (SPEC §3.9.3): cheap, no reboot, the firmware keeps running.
   * An empty source erases the program.
   */
  uploadProgram(unit: Unit, source: string, opts: { factory?: boolean } = {}): UploadResult {
    const res: UploadResult = { ...this.compileFor(unit, source, 'program'), cost: 0 };
    if (!res.program) return res;
    if (!opts.factory) {
      const cost = this.programUploadCost(unit, res.flashUsed);
      if (!unit.powered) res.rejected = `Rover is ${unit.vm.state}: it cannot receive a program.`;
      else if (unit.energy <= cost)
        res.rejected = `Upload needs ${(cost / 1000).toFixed(1)}% battery at signal ${this.signalOf(unit)}; rover has ${(unit.energy / 1000).toFixed(1)}%.`;
      if (res.rejected) {
        this.recordSent({ unitId: unit.id, tick: this.tick, kind: 'PROGRAM', slot: 'program', bytes: res.flashUsed, cost: 0, rejected: res.rejected });
        return res;
      }
      unit.energy -= cost;
      res.cost = cost;
    }
    unit.programSource = source;
    unit.programBytes = res.flashUsed;
    unit.programRam = { low: res.ramLow, high: res.ramHigh };
    unit.prog.program = res.program;
    this.restartProgram(unit);
    const costMsg = res.cost ? `, cost ${(res.cost / 1000).toFixed(1)}% battery at signal ${this.signalOf(unit)}` : '';
    const flash = `${unit.firmwareBytes} + ${res.flashUsed}/${unit.chassis.flashBytes} bytes`;
    const cat: LogCategory = opts.factory ? 'world' : 'sent';
    if (this.hasProgram(unit)) this.log(unit, 'info', `Program uploaded (${flash}${costMsg}). It starts with the firmware's next RUN.`, cat);
    else this.log(unit, 'info', `Program erased (${flash}${costMsg}).`, cat);
    if (!opts.factory) this.recordSent({ unitId: unit.id, tick: this.tick, kind: 'PROGRAM', slot: 'program', bytes: res.flashUsed, cost: res.cost });
    return res;
  }

  /**
   * Compile and flash new firmware over the uplink; hard reboot on success.
   * `factory` installs firmware for free (new rovers, admin tools).
   */
  upload(unit: Unit, source: string, opts: { factory?: boolean } = {}): UploadResult {
    const res: UploadResult = { ...this.compileFor(unit, source, 'firmware', { fresh: true }), cost: 0 }; // assembled for today's RAM
    if (!res.program) return res;
    if (!opts.factory) {
      const cost = this.uploadCost(unit, res.flashUsed);
      if (!unit.powered) res.rejected = `Rover is ${unit.vm.state}: it cannot receive firmware.`;
      else if (unit.energy <= cost)
        res.rejected = `Upload needs ${(cost / 1000).toFixed(1)}% battery at signal ${this.signalOf(unit)}; rover has ${(unit.energy / 1000).toFixed(1)}%.`;
      if (res.rejected) {
        this.recordSent({ unitId: unit.id, tick: this.tick, kind: 'FIRMWARE', slot: 'firmware', bytes: res.flashUsed, cost: 0, rejected: res.rejected });
        return res;
      }
      unit.energy -= cost;
      res.cost = cost;
    }
    unit.sourceCode = source;
    unit.firmwareBytes = res.flashUsed;
    unit.firmwareRam = { low: res.ramLow, high: res.ramHigh };
    unit.fwRamTop = unit.chassis.ramBytes;
    unit.vm.program = res.program;
    this.hardReboot(unit, BootReason.UPLOAD);
    unit.cyclesLeft = 0;
    const costMsg = res.cost ? `, cost ${(res.cost / 1000).toFixed(1)}% battery at signal ${this.signalOf(unit)}` : '';
    const prog = unit.programBytes ? ` + program ${unit.programBytes}` : '';
    this.log(unit, 'info', `Firmware flashed (${res.flashUsed}${prog}/${unit.chassis.flashBytes} bytes${costMsg}). Rebooting.`, opts.factory ? 'world' : 'sent');
    if (!opts.factory) this.recordSent({ unitId: unit.id, tick: this.tick, kind: 'FIRMWARE', slot: 'firmware', bytes: res.flashUsed, cost: res.cost });
    return res;
  }

  /** Layer-aware tile read including the computed actor layer. */
  tileAt(x: number, y: number, layer: Layer): number {
    if (layer === Layer.ACTOR) return this.unitAt(x, y) ? T.ROVER : 0;
    return this.world.getTile(x, y, layer);
  }

  isBlocked(x: number, y: number): boolean {
    if (this.unitAt(x, y)) return true;
    const ob = this.world.getTile(x, y, Layer.OBSTACLE);
    return ob !== 0 && !!this.registry.get(ob)?.blocksMove;
  }

  // ---------------------------------------------------------------- ticking

  /** Advance one full tick. */
  advanceTick(): void {
    this.beginTick();
    for (const u of this.units) this.runCpu(u, Infinity);
  }

  /**
   * Debugger: execute exactly one instruction on `unit`, advancing world ticks as
   * needed (e.g. while the CPU is blocked). Returns false if the CPU cannot run.
   */
  stepInstruction(unit: Unit, maxTicks = 10_000): boolean {
    for (let guard = 0; guard < maxTicks; guard++) {
      if (unit.cpu.state === CpuState.RUNNING && unit.cyclesLeft > 0) {
        this.runCpu(unit, 1);
        return true;
      }
      // Finish this tick for everyone else, then start a new one.
      for (const u of this.units) if (u !== unit) this.runCpu(u, Infinity);
      this.beginTick();
      if (!unit.powered || unit.vm.state === CpuState.FAULT || unit.vm.state === CpuState.HALTED) return false;
      if (unit.slice >= 0 && (unit.prog.state === CpuState.FAULT || unit.prog.state === CpuState.HALTED)) return false;
    }
    return false;
  }

  private beginTick(): void {
    this.tick++;
    this.world.now = this.tick;
    const wasNight = this.sun.elevation <= 0;
    this.director.tick(this.tick);
    this.sun = this.env.sun(this.tick);
    const squall = this.director.active('SQUALL', this.tick)?.damage ?? null;
    if (wasNight && this.sun.elevation > 0) for (const u of this.units) if (u.powered) this.stats.sunrisesPowered++;
    this.orbitAzimuth = this.env.orbitAzimuth(this.tick);
    const announced = this.director.announcedAt(this.tick);
    for (const u of this.units) {
      const integrity = u.hull + u.solarHealth + u.antennaHealth;
      this.world.touchRadius(u.x, u.y, BALANCE.chunkBubbleRadius);
      this.updatePower(u);
      this.updateWatchdog(u);
      if (u.powered) this.updateLink(u);
      if (squall) this.applySquall(u, squall);
      this.updateUnitPhysics(u);
      this.revealAround(u);
      this.updatePreempt(u, integrity, announced);
      this.updateSlice(u);
      u.cyclesLeft = u.cpu.state === CpuState.RUNNING ? u.chassis.cyclesPerTick : 0;
    }
    for (const d of this.drops) if (!d.landed && d.landTick === this.tick) this.landDrop(d);
    if (this.tick % 100 === 0) this.world.evictStale(BALANCE.chunkEvictAfterTicks);
    if (this.tick % 10 === 0) this.director.updateGoals();
    this.events.emit('TICK', { tick: this.tick });
  }

  /**
   * Slice bookkeeping at the start of a tick: a used-up slice ends once the program is
   * between instructions (an action started in the slice runs to completion first).
   */
  private updateSlice(u: Unit): void {
    if (u.slice < 0) return;
    if (u.slice > 0) u.slice--;
    else if (u.prog.state !== CpuState.BLOCKED) this.endSlice(u, ProgState.PROG_READY);
  }

  /**
   * @WDT (SPEC §3.9.5): counts down while the firmware runs or waits; BRK (HALTED) freezes it
   * like a debugger does, a FAULT leaves it to the fault reset. At 0: hard reboot.
   */
  private updateWatchdog(u: Unit): void {
    if (u.wdt <= 0 || (u.vm.state !== CpuState.RUNNING && u.vm.state !== CpuState.BLOCKED)) return;
    if (--u.wdt > 0) return;
    this.hardReboot(u, BootReason.WDT_TIMEOUT);
    this.log(u, 'warn', 'Watchdog timeout: the firmware did not kick @WDT in time. Rebooting.', 'rover');
    this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
  }

  /**
   * Fault protection (SPEC §3.9.2): a condition armed in @PREEMPT ends the running slice now.
   * The program's action in progress is aborted (@STATUS ERR_PREEMPTED); it stays PROG_READY,
   * so the next RUN resumes it after that instruction.
   */
  private updatePreempt(u: Unit, integrityBefore: number, announced: boolean): void {
    if (u.slice < 0 || !u.preemptMask) return;
    let hit = 0;
    if (announced) hit |= Preempt.PRE_ALERT;
    if (u.hull + u.solarHealth + u.antennaHealth < integrityBefore) hit |= Preempt.PRE_DAMAGE;
    if (u.batteryPercent < u.batAlarm) hit |= Preempt.PRE_LOW_BAT;
    hit &= u.preemptMask;
    if (!hit) return;
    if (u.prog.state === CpuState.BLOCKED) {
      u.action = null;
      u.prog.status = Status.ERR_PREEMPTED;
      u.prog.unblock();
      this.events.emit('UNIT_STATUS', { unitId: u.id, status: Status.ERR_PREEMPTED });
    }
    u.preempted = hit;
    this.endSlice(u, ProgState.PROG_READY);
    const why = [hit & Preempt.PRE_ALERT && 'alert', hit & Preempt.PRE_DAMAGE && 'damage', hit & Preempt.PRE_LOW_BAT && 'low battery'].filter(Boolean).join(', ');
    this.log(u, 'warn', `Program preempted (${why}): the firmware has control.`, 'rover');
  }

  private runCpu(u: Unit, maxInstructions: number): void {
    let n = 0;
    while (u.cyclesLeft > 0 && n < maxInstructions) {
      const cpu = u.cpu;
      if (cpu.state !== CpuState.RUNNING) break;
      const r = cpu.step(this.hostFor(u), BALANCE.watchdogTicks);
      n++;
      u.cyclesLeft--;
      if (r === 'endTick') u.cyclesLeft = 0;
      const after = cpu.state as CpuState; // step() may have changed it
      if (cpu === u.prog && u.slice >= 0) {
        if (after === CpuState.FAULT) {
          this.log(u, 'error', `Program FAULT: ${cpu.faultReason}. Control returns to the firmware.`, 'rover');
          this.endSlice(u, ProgState.PROG_FAULT);
        } else if (after === CpuState.HALTED) this.endSlice(u, ProgState.PROG_HALTED);
      }
      // BRK reports itself: the rover sends a register dump of the halted slot unasked
      // (dropped if the dump queue is full). Only BRK halts a CPU.
      if (after === CpuState.HALTED && u.link.sys.length < BALANCE.dumpQueueMax) this.queueRegisterDump(u, cpu === u.prog ? 'program' : 'firmware');
    }
    if (u.cpu.state !== CpuState.RUNNING) u.cyclesLeft = 0;
    if (u.vm.state === CpuState.FAULT && u.vm.watchdog === BALANCE.watchdogTicks) {
      this.log(u, 'error', `CPU FAULT: ${u.vm.faultReason}. Watchdog reboot in ${BALANCE.watchdogTicks} ticks.`, 'rover');
      this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
    }
  }

  private revealAround(u: Unit): void {
    const s = this.viewShape(u);
    const key = `${u.x},${u.y},${s.radius},${s.cone}`;
    if (key === u.lastRevealKey) return;
    u.lastRevealKey = key;
    this.world.revealCircle(u.x, u.y, s.radius);
    if (s.cone >= 0) this.world.revealTiles(u.x, u.y, coneOffsets(s.cone));
  }

  /** Solar, actuators, lights and passive drain. Runs before actions each tick. */
  private updatePower(u: Unit): void {
    if (u.vm.state === CpuState.DESTROYED) return;
    const B = BALANCE;

    // Solar charging works even when powered off: that is how a dead rover recovers.
    u.lastSolarGain = u.solarDeployed
      ? Math.floor((solarGain(u.solarAngle, this.sun) * u.solarHealth * u.chassis.solarPercent * (100 - u.solarDust)) / 1_000_000)
      : 0;
    u.energy = Math.min(u.chassis.batteryCapacity, u.energy + u.lastSolarGain);

    // Thermal (SPEC §3.3.4): drift toward the ambient; powered survival heaters hold the floor.
    const ambient = ambientTemp(this.sun.light);
    u.heater = u.powered && u.temp <= B.heaterSetpointC && ambient < B.heaterSetpointC ? 1 : 0;
    if (this.tick % B.thermalTicksPerDeg === 0) {
      if (u.heater) {
        if (u.temp < B.heaterSetpointC) u.temp++; // warming up after a cold soak
      } else if (u.temp !== ambient) u.temp += u.temp < ambient ? 1 : -1;
    }

    // Dust settles on an open array; folding it (a completed stow) shakes some off.
    if (u.solarDeploy > 0 && u.solarDust < 100 && this.tick % B.dustTicks === 0) u.solarDust++;

    if (u.vm.state === CpuState.POWER_OFF) {
      if (u.energy * 100 >= B.coldBootPercent * u.chassis.batteryCapacity) {
        u.vm.state = CpuState.RUNNING;
        this.hardReboot(u, BootReason.COLD_BOOT);
        this.log(u, 'warn', 'Solar cold boot: battery recovered, firmware restarted.', 'rover');
        this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
      }
      return;
    }

    let drain = B.idleDrainPerTick;
    if (u.headlight) drain += B.headlightPerTick;
    if (u.heater) drain += B.heaterPerTick;
    // Motors: deploy/stow array, slew panel and dish toward their targets.
    const deployTarget = u.solarOpen ? B.solarDeployTicks : 0;
    if (u.solarDeploy !== deployTarget) {
      u.solarDeploy += u.solarDeploy < deployTarget ? 1 : -1;
      drain += B.actuatorEnergyPerTick;
      if (u.solarDeploy === 0) u.solarDust -= Math.ceil((u.solarDust * B.dustShedPercent) / 100);
    }
    const slew = (cur: number, target: number): number => {
      const d = angleDiff(cur, target);
      if (d === 0) return cur;
      drain += B.actuatorEnergyPerTick;
      const step = Math.min(d, B.actuatorSlewDegPerTick);
      return wrapDeg(wrapDeg(target - cur) <= 180 ? cur + step : cur - step);
    };
    u.solarAngle = slew(u.solarAngle, u.solarTarget);
    u.antennaAngle = slew(u.antennaAngle, u.antennaTarget);
    this.drain(u, drain);
  }

  /** Micrometeorites: light hull wear (more while driving), dish wear, heavy damage to an exposed array. */
  private applySquall(u: Unit, d: SquallDamage): void {
    if (u.vm.state === CpuState.DESTROYED || this.cheats.invulnerable) return;
    const t = this.tick;
    if (d.hullEvery) {
      const base = d.hullEvery * u.chassis.hullArmor;
      const every = u.action?.kind === 'STEP' ? Math.max(1, Math.floor(base / 2)) : base;
      if (t % every === 0) this.damage(u, 1);
    }
    if (d.solarEvery && !u.solarStowed && t % d.solarEvery === 0) u.solarHealth = Math.max(0, u.solarHealth - d.solarDamage);
    if (d.dustEvery && !u.solarStowed && t % d.dustEvery === 0) u.solarDust = Math.min(100, u.solarDust + 1);
    if (d.antennaEvery && t % d.antennaEvery === 0) u.antennaHealth = Math.max(0, u.antennaHealth - 1);
  }

  /** `@TX_DATA` write: old shorthand for `LOG 0 value` that also sets @STATUS. */
  private transmit(u: Unit, value: number): void {
    const ok = u.link.enqueue(encodeLog(0, value), u.chassis.logFifoBytes);
    this.setStatus(u, ok ? Status.OK : Status.ERR_FULL);
  }

  /** Record a science product in the rover's recorder (null if it does not fit). */
  recordProduct(u: Unit, p: Omit<ProductDesc, 'seq' | 'tick'>): ProductDesc | null {
    return u.link.record({ ...p, tick: this.tick }, u.chassis.recorderBytes);
  }

  /**
   * Camera subject in `dir`: the first rover / obstacle / item within snapReach tiles; with
   * nothing that close, a landscape (subject 0) sampled from the world ahead.
   */
  cameraSubject(u: Unit, dir: number): { subject: number; x: number; y: number; horizon?: HorizonView } {
    const [dx, dy] = DIR_VEC[dir];
    for (let d = 1; d <= BALANCE.snapReach; d++) {
      const x = u.x + dx * d;
      const y = u.y + dy * d;
      const hit = this.tileAt(x, y, Layer.ACTOR) || this.tileAt(x, y, Layer.OBSTACLE) || this.tileAt(x, y, Layer.ITEM);
      if (hit) return { subject: hit, x, y };
    }
    return { subject: 0, x: u.x, y: u.y, horizon: this.horizonView(u, dir) };
  }

  /** Skyline, ground and sun over a 90° field of view in `dir` (integer only). */
  horizonView(u: Unit, dir: number): HorizonView {
    const [fx, fy] = DIR_VEC[dir];
    const [rx, ry] = DIR_VEC[(dir + 1) % 4]; // to the right of the view
    const h: number[] = [];
    const ds: number[] = [];
    const ts: number[] = [];
    for (let c = 0; c < HORIZON_COLUMNS; c++) {
      let best = 0;
      let bd = 0;
      let bt = 0;
      for (let d = 1; d <= BALANCE.horizonRange; d++) {
        const lat = Math.floor((d * (2 * c - 15) + 8) / 16); // ±45°
        const id = this.world.getTile(u.x + fx * d + rx * lat, u.y + fy * d + ry * lat, Layer.OBSTACLE);
        if (!id) continue;
        const app = Math.min(256, Math.floor((id === T.CLIFF_WALL ? 768 : 256) / d)); // cliffs ~3 tiles tall, ore mounds ~1
        if (app > best) {
          best = app;
          bd = d;
          bt = id;
        }
      }
      h.push(best);
      ds.push(bd);
      ts.push(bt);
    }
    // Ground ahead: vents if any on the first 4 tiles, else gravel if it is most of them, else sand.
    let gravel = 0;
    let vent = false;
    for (let d = 1; d <= 4; d++) {
      const id = this.world.getTile(u.x + fx * d, u.y + fy * d, Layer.TERRAIN);
      if (id === T.ACID_VENT) vent = true;
      if (id === T.ROUGH_GRAVEL) gravel++;
    }
    const ground: number = vent ? T.ACID_VENT : gravel >= 2 ? T.ROUGH_GRAVEL : T.FLAT_SAND;
    // Sun in view: within 50° of the view axis and above the horizon (45° = top of the frame).
    let rel = wrapDeg(this.sun.azimuth - dir * 90);
    if (rel > 180) rel -= 360;
    const inView = this.sun.elevation > 0 && rel >= -50 && rel <= 50;
    const sunU = inView ? 512 + Math.floor((rel * 1024) / 90) : -1;
    const sunV = inView ? HORIZON_V - Math.floor((this.sun.elevation * HORIZON_V) / 45) : 0;
    return { h, d: ds, t: ts, ground, sunU, sunV, light: this.sun.light };
  }

  /** Enough light for a photo in `dir`: daylight, or the headlight on and facing `dir`. */
  photoLit(u: Unit, dir: number): boolean {
    return this.sun.light >= BALANCE.snapMinSunLight || (u.headlight === 1 && u.heading === dir);
  }

  /**
   * SNAP's exposure ends (SPEC §3.8.7): the photo fills image memory (the rest is zeroed) and
   * becomes the capture. Its bytes come from the same function that regenerates a raw product.
   */
  capturePhoto(u: Unit, dir: number, mode: number): void {
    const shot = this.cameraSubject(u, dir);
    const cap: Capture = {
      type: mode,
      subject: shot.subject,
      x: u.x,
      y: u.y,
      sx: shot.x,
      sy: shot.y,
      lit: this.photoLit(u, dir),
      noise: { tick: this.tick, seq: u.link.seq },
      ...(shot.horizon ? { horizon: shot.horizon } : {}),
      ...(this.anomalyAt(shot.subject, shot.x, shot.y) ? { anomaly: true } : {}),
    };
    const mem = u.imageMemory();
    mem.fill(0);
    mem.set(productPayload(this.seed, { ...cap, seq: 0, tick: 0, credits: 0 }));
    u.capture = cap;
    u.snapMode = mode;
    u.imgEdited = false;
    this.stats.photosTaken++;
  }

  /**
   * SEND [type] (SPEC §3.8.7): image memory → a photo product in the recorder, for
   * BALANCE.sendEnergy (ERR_LOW_POWER without it). The first SEND
   * of the capture's type carries the capture (RAW, or EDITED after an STB); any other is DRAWN.
   */
  private send(u: Unit, type: number): void {
    const mem = u.imageMemory();
    const n = isPhoto(type) ? photoBytes(type) : 0;
    if (!n || n > mem.length) return this.setStatus(u, Status.ERR_INVALID);
    if (u.link.recFree(u.chassis.recorderBytes) < productFrameBytes(type)) return this.setStatus(u, Status.ERR_FULL);
    if (u.energy < BALANCE.sendEnergy) return this.setStatus(u, Status.ERR_LOW_POWER);
    const cap = u.capture?.type === type ? u.capture : null;
    let p: Omit<ProductDesc, 'seq' | 'tick'>;
    if (cap) {
      const { noise, ...photo } = cap;
      p = { ...photo, noise, credits: 0, ...(u.imgEdited ? { level: Level.EDITED, data: toHex(mem.subarray(0, n)) } : {}) };
      u.capture = null;
    } else {
      p = { type, subject: 0, x: u.x, y: u.y, lit: false, credits: 0, level: Level.DRAWN, data: toHex(mem.subarray(0, n)) };
    }
    this.recordProduct(u, p);
    this.setStatus(u, Status.OK);
    this.drain(u, BALANCE.sendEnergy);
    if (u.powered) {
      u.action = { kind: 'WAIT', ticksLeft: BALANCE.sendTicks };
      u.cpu.block();
    }
  }

  /** ERASE (SPEC §3.8.7): zero image memory and drop the capture, on request only. */
  private erase(u: Unit): void {
    if (u.energy < BALANCE.eraseEnergy) return this.setStatus(u, Status.ERR_LOW_POWER);
    u.clearImageMemory();
    this.setStatus(u, Status.OK);
    this.drain(u, BALANCE.eraseEnergy);
    if (u.powered) {
      u.action = { kind: 'WAIT', ticksLeft: BALANCE.eraseTicks };
      u.cpu.block();
    }
  }

  /** Is the subject at (x, y) an anomaly? Landscapes (subject 0) never are. */
  anomalyAt(subject: number, x: number, y: number): boolean {
    return isAnomaly(this.seed, subject, x, y, BALANCE.anomalyOneIn);
  }

  /**
   * Mission control flags a received photo as an anomaly (SPEC §3.8.5). Only complete, lit
   * photos, once each. Right: +anomalyFlagCredits the first time a tile is flagged (again:
   * nothing); wrong: −anomalyWrongFlag, never below 0. Returns an error, or null.
   */
  flagAnomaly(g: ReceivedProduct): string | null {
    if (!this.gallery.includes(g)) return 'unknown product';
    if (!isPhoto(g.type)) return 'only photos can be flagged';
    if (g.level === Level.DRAWN) return 'drawn picture: no camera photo';
    if (g.flag) return 'already flagged';
    if (g.received < productFrameBytes(g.type)) return 'photo not complete';
    if (!g.lit) return 'dark photo';
    if (!g.anomaly) {
      g.flag = 'miss';
      this.credits -= Math.min(this.credits, BALANCE.anomalyWrongFlag);
      return null;
    }
    const key = `${g.sx},${g.sy}`;
    if (this.anomalyTiles.includes(key)) {
      g.flag = 'known';
      return null;
    }
    g.flag = 'hit';
    this.anomalyTiles.push(key);
    this.stats.anomaliesFound++;
    this.credits += BALANCE.anomalyFlagCredits;
    return null;
  }

  /** Credits for a delivered product; lit photos pay a bonus for the first of a subject type. */
  private deliveryCredits(p: ProductDesc): number {
    if (!isPhoto(p.type)) return p.credits;
    if (!p.lit || p.level === Level.DRAWN) return 0;
    this.stats.photosDelivered++;
    let credits = BALANCE.photoCredits;
    if (!this.photoSubjects.includes(p.subject)) {
      this.photoSubjects.push(p.subject);
      credits += BALANCE.photoFirstBonus;
    }
    if (p.level === Level.EDITED) {
      this.stats.photosEdited++;
      if (!this.editedTypes.includes(p.type)) {
        this.editedTypes.push(p.type);
        credits += BALANCE.editFirstBonus;
      }
    }
    return credits;
  }

  private updateUnitPhysics(u: Unit): void {
    const vm = u.vm;
    if (vm.state === CpuState.DESTROYED) return;

    if (vm.state === CpuState.FAULT) {
      if (--vm.watchdog <= 0) {
        this.hardReboot(u, BootReason.WATCHDOG);
        this.log(u, 'warn', 'Watchdog reboot.', 'rover');
        this.events.emit('UNIT_STATE', { unitId: u.id, state: vm.state });
      }
      return;
    }

    if (vm.state === CpuState.POWER_OFF) return;

    const act = u.action;
    if (!act) return;
    if (--act.ticksLeft > 0) return;

    if (act.kind === 'WAIT') {
      u.action = null;
      u.cpu.unblock();
      return;
    }

    if (act.kind === 'TOOL') {
      const st = TOOLS[act.tool].complete(this, u, act.arg, act.arg2);
      this.finishAction(u, st);
      this.events.emit('TOOL_DONE', { unitId: u.id, tool: act.tool, status: st });
      return;
    }

    // STEP: arrive on the tile.
    u.x = act.toX;
    u.y = act.toY;
    act.tilesLeft--;
    const terrain = this.registry.get(this.world.getTile(u.x, u.y, Layer.TERRAIN));
    if (terrain?.hazardDamage) {
      this.damage(u, terrain.hazardDamage);
      if (!u.powered) return;
      this.finishAction(u, Status.ERR_HAZARD);
      return;
    }
    this.stats.maxDistance = Math.max(this.stats.maxDistance, Math.abs(u.x) + Math.abs(u.y));
    if (act.tilesLeft <= 0) {
      this.finishAction(u, Status.OK);
      return;
    }
    const st = this.beginStepTile(u, act.dir, act.tilesLeft);
    if (st !== Status.OK) this.finishAction(u, st);
  }

  private finishAction(u: Unit, status: Status): void {
    u.action = null;
    this.setStatus(u, status);
    u.cpu.unblock();
  }

  /** @STATUS of the context that runs now (each slot has its own). */
  private setStatus(u: Unit, status: Status): void {
    u.cpu.status = status;
    if (status !== Status.OK) this.events.emit('UNIT_STATUS', { unitId: u.id, status });
  }

  /** Start moving one tile. Returns OK if the move began. */
  private beginStepTile(u: Unit, dir: number, tilesLeft: number): Status {
    const [dx, dy] = DIR_VEC[dir];
    const tx = u.x + dx;
    const ty = u.y + dy;
    if (u.solarOpen || !u.solarStowed) return Status.ERR_DEPLOYED;
    if (this.isBlocked(tx, ty)) return Status.ERR_BLOCKED;
    const terrain = this.registry.get(this.world.getTile(tx, ty, Layer.TERRAIN));
    const ticks = terrain?.moveTicks ?? 3;
    const energy = terrain?.moveEnergy ?? 40;
    if (u.energy < energy) return Status.ERR_LOW_POWER;
    this.drain(u, energy);
    if (!u.powered) return Status.ERR_LOW_POWER;
    u.heading = dir;
    u.action = { kind: 'STEP', dir, tilesLeft, ticksLeft: ticks, toX: tx, toY: ty };
    u.motion = { fromX: u.x, fromY: u.y, toX: tx, toY: ty, startTick: this.tick, endTick: this.tick + ticks };
    this.events.emit('UNIT_MOVED', { unitId: u.id, ...u.motion });
    return Status.OK;
  }

  // ---------------------------------------------------------------- upgrades

  /** Why `id` cannot be bought for `u` right now, or null if it can. */
  upgradeBlocker(u: Unit, id: string): string | null {
    const def = UPGRADE_BY_ID[id];
    if (!def) return 'unknown upgrade';
    if (u.upgrades.includes(id)) return 'installed';
    if (this.drops.some((d) => d.upgrade === id)) return 'on its way';
    const missing = def.requires?.find((r) => !u.upgrades.includes(r));
    if (missing) return `needs ${UPGRADE_BY_ID[missing]?.title ?? missing}`;
    if (this.credits < def.cost) return `needs ${def.cost} credits`;
    if (!u.powered) return 'rover is offline';
    return null;
  }

  /** Spend credits and send a supply crate; it lands near `u` after supplyDropTicks. */
  buyUpgrade(u: Unit, id: string): string | null {
    const why = this.upgradeBlocker(u, id);
    if (why) return why;
    const spot = this.findDropSpot(u);
    if (!spot) return 'no clear landing spot near the rover';
    this.credits -= UPGRADE_BY_ID[id].cost;
    const d: SupplyDrop = { id: this.nextDropId++, upgrade: id, x: spot[0], y: spot[1], landTick: this.tick + BALANCE.supplyDropTicks, landed: false };
    this.drops.push(d);
    this.events.emit('SUPPLY', { phase: 'ORDERED', upgrade: id, x: d.x, y: d.y, landTick: d.landTick });
    this.log(u, 'info', `Ordered ${UPGRADE_BY_ID[id].title}: supply crate lands at (${d.x}, ${d.y}) in ${BALANCE.supplyDropTicks} ticks.`);
    return null;
  }

  /** Deterministic clear tile on a Manhattan ring 3..6 tiles from the rover. */
  private findDropSpot(u: Unit): [number, number] | null {
    const B = BALANCE;
    for (let k = 0; k < 64; k++) {
      const h = hash3(this.seed, this.tick, this.nextDropId, k);
      const dist = B.supplyDropMinDist + (h % (B.supplyDropMaxDist - B.supplyDropMinDist + 1));
      const dx = ((h >>> 8) % (2 * dist + 1)) - dist;
      const dy = ((h >>> 20) & 1 ? 1 : -1) * (dist - Math.abs(dx));
      const x = u.x + dx;
      const y = u.y + dy;
      const terrain = this.registry.get(this.world.getTile(x, y, Layer.TERRAIN));
      if (terrain?.hazardDamage) continue;
      if (this.world.getTile(x, y, Layer.OBSTACLE) || this.world.getTile(x, y, Layer.ITEM) || this.unitAt(x, y)) continue;
      if (this.drops.some((d) => d.x === x && d.y === y)) continue;
      return [x, y];
    }
    return null;
  }

  private landDrop(d: SupplyDrop): void {
    d.landed = true;
    // The spot was checked when ordered; reveal it so the crate is visible on the map.
    this.world.setTile(d.x, d.y, Layer.ITEM, T.SUPPLY_CRATE);
    this.world.revealCircle(d.x, d.y, 1);
    this.events.emit('SUPPLY', { phase: 'LANDED', upgrade: d.upgrade, x: d.x, y: d.y, landTick: d.landTick });
  }

  nearestDrop(u: Unit): SupplyDrop | null {
    let best: SupplyDrop | null = null;
    let bd = Infinity;
    for (const d of this.drops) {
      if (!d.landed) continue;
      const dist = Math.abs(d.x - u.x) + Math.abs(d.y - u.y);
      if (dist < bd || (dist === bd && best && d.id < best.id)) {
        best = d;
        bd = dist;
      }
    }
    return best;
  }

  /** Grabber picked up a supply crate at (x, y): install its upgrade on `u` immediately. */
  openSupplyCrate(u: Unit, x: number, y: number): void {
    const i = this.drops.findIndex((d) => d.landed && d.x === x && d.y === y);
    if (i < 0) return;
    const [d] = this.drops.splice(i, 1);
    this.installUpgrade(u, d.upgrade);
    this.events.emit('SUPPLY', { phase: 'INSTALLED', upgrade: d.upgrade, x, y, landTick: d.landTick });
    this.log(u, 'info', `Installed ${UPGRADE_BY_ID[d.upgrade]?.title}.`);
  }

  installUpgrade(u: Unit, id: string): void {
    const def = UPGRADE_BY_ID[id];
    if (!def || u.upgrades.includes(id)) return;
    def.apply(u.chassis, u);
    u.upgrades.push(id);
    this.stats.upgradesInstalled++;
  }

  /** Validate, pay and start a tool action; the effect applies when it completes. */
  private startTool(u: Unit, tool: ToolDef, arg: number, arg2?: number): void {
    let st = tool.check(this, u, arg, arg2);
    if (st === Status.OK && u.energy < tool.energy) st = Status.ERR_LOW_POWER;
    this.setStatus(u, st);
    if (st !== Status.OK) return;
    this.drain(u, tool.energy);
    if (!u.powered) return;
    u.action = { kind: 'TOOL', tool: tool.id, arg, arg2, ticksLeft: tool.ticks };
    u.cpu.block();
    const t = tool.target?.(u, arg) ?? null;
    if (tool.arg === 'dir' && !tool.keepsHeading && arg >= 0 && arg <= 3) u.heading = arg;
    this.events.emit('TOOL_USED', { unitId: u.id, tool: tool.id, x: u.x, y: u.y, targetX: t?.[0] ?? null, targetY: t?.[1] ?? null, ticks: tool.ticks });
  }

  private drain(u: Unit, amount: number): void {
    u.energy = Math.max(0, u.energy - amount);
    if (u.energy === 0 && u.powered) {
      u.vm.state = CpuState.POWER_OFF;
      u.action = null;
      u.cyclesLeft = 0;
      this.abortSlice(u);
      this.log(u, 'error', 'Battery depleted. Rover powered off.', 'rover');
      this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
    }
  }

  private damage(u: Unit, amount: number): void {
    if (this.cheats.invulnerable) return;
    u.hull = Math.max(0, u.hull - amount);
    if (u.hull === 0) {
      u.vm.state = CpuState.DESTROYED;
      u.action = null;
      u.cyclesLeft = 0;
      this.abortSlice(u);
      this.log(u, 'error', 'Hull breached. Rover destroyed.', 'rover');
      this.events.emit('UNIT_STATE', { unitId: u.id, state: u.vm.state });
    }
  }

  private log(u: Unit, level: 'info' | 'warn' | 'error', message: string, category: LogCategory = 'world'): void {
    this.events.emit('LOG', { unitId: u.id, level, message, category });
  }

  // ---------------------------------------------------------------- hardware

  private hostFor(u: Unit): VmHost {
    return {
      readPort: (name) => getPort(name)?.read?.(u, this.portCtx) ?? 0,
      writePort: (name, v) => {
        const p = getPort(name);
        if (p) writePortClamped(p, u, v, this.portCtx);
      },
      hardware: (ins, values) => this.hardware(u, ins, values),
      // M14 data address space (docs/ASSEMBLER_CORE.md §7.1): RAM, image memory, cargo.
      load: (addr) => {
        const ram = u.ramMemory();
        if (addr >= MEMORY_MAP.RAM && addr < MEMORY_MAP.RAM + ram.length) return ram[addr - MEMORY_MAP.RAM];
        const img = u.imageMemory();
        if (addr >= MEMORY_MAP.IMG && addr < MEMORY_MAP.IMG + img.length) return img[addr - MEMORY_MAP.IMG];
        if (addr >= MEMORY_MAP.CARGO && addr < MEMORY_MAP.CARGO + u.cargo.length) return u.cargo[addr - MEMORY_MAP.CARGO] & 255;
        return undefined;
      },
      store: (addr, value) => {
        const ram = u.ramMemory();
        if (addr >= MEMORY_MAP.RAM && addr < MEMORY_MAP.RAM + ram.length) {
          ram[addr - MEMORY_MAP.RAM] = value & 255;
          return null;
        }
        const img = u.imageMemory();
        if (addr >= MEMORY_MAP.IMG && addr < MEMORY_MAP.IMG + img.length) {
          img[addr - MEMORY_MAP.IMG] = value & 255;
          u.imgEdited = true;
          return null;
        }
        if (addr >= MEMORY_MAP.CARGO && addr < MEMORY_MAP.CARGO + u.cargo.length) return 'Cargo is read-only';
        return 'No memory';
      },
      log: (tag, value) => {
        u.link.enqueue(encodeLog(tag, value), u.chassis.logFifoBytes);
      },
      end: (value) => {
        if (u.slice < 0) return;
        u.progResult = value;
        this.endSlice(u, ProgState.PROG_DONE);
      },
    };
  }

  // ---------------------------------------------------------------- downlink

  /** After a hard reboot: @LOG_LOST restarts, and the boot frame `LOG 15 reason` is queued. */
  private booted(u: Unit, reason: number): void {
    u.link.lost = 0;
    u.link.enqueue(encodeLog(SYSTEM_TAG, reason), u.chassis.logFifoBytes);
  }

  /** Transmit this tick's bytes; completed frames and products reach mission control. */
  private updateLink(u: Unit): void {
    const { sent, sysDone, done, delivered, partial } = u.link.pump(this.signalOf(u), BALANCE.linkMinSignal, u.chassis.linkBytesPerTick);
    if (!sent) return;
    this.drain(u, BALANCE.linkEnergyPerTick);
    for (const f of sysDone) {
      const r: ReceivedFrame = { unitId: u.id, tick: this.tick, bytes: f.bytes, gap: 0, taken: f.taken };
      this.received.push(r);
      this.events.emit('DOWNLINK_FRAME', r);
    }
    for (const f of done) {
      const r: ReceivedFrame = { unitId: u.id, tick: this.tick, bytes: f.bytes, gap: f.gap };
      this.received.push(r);
      if ((f.bytes[0] >> 3) !== SYSTEM_TAG) this.stats.framesReceived++;
      this.events.emit('DOWNLINK_FRAME', r);
    }
    for (const p of delivered) {
      const g = this.galleryEntry(u, p);
      g.received = productFrameBytes(p.type);
      g.credits = this.deliveryCredits(p);
      this.stats.framesReceived++;
      this.stats.scienceDelivered++;
      this.credits += g.credits;
      this.events.emit('SCIENCE_DELIVERED', g);
    }
    if (partial) this.galleryEntry(u, partial).received = u.link.recSent;
    if (sysDone.length || done.length || delivered.length) this.events.emit('UPLINK_PULSE', { unitId: u.id, x: u.x, y: u.y, science: delivered.length > 0 });
    if (this.received.length > RECEIVED_KEEP) this.received.splice(0, this.received.length - RECEIVED_KEEP);
    if (this.gallery.length > GALLERY_KEEP) this.gallery.splice(0, this.gallery.length - GALLERY_KEEP);
  }

  /** Mission control's record of a product, created when its first byte arrives. */
  private galleryEntry(u: Unit, p: ProductDesc): ReceivedProduct {
    for (let i = this.gallery.length - 1; i >= 0; i--) {
      const g = this.gallery[i];
      if (g.unitId === u.id && g.seq === p.seq && g.tick === p.tick) {
        g.arrived = this.tick;
        return g;
      }
    }
    const g: ReceivedProduct = { ...p, unitId: u.id, arrived: this.tick, received: 0 };
    this.gallery.push(g);
    return g;
  }

  private hardware(u: Unit, ins: Instr, v: number[]): number[] | void {
    const validDir = (d: number) => d >= 0 && d <= 3;
    switch (ins.op) {
      case 'SLEEP': {
        this.setStatus(u, Status.OK);
        if (v[0] > 0) {
          u.action = { kind: 'WAIT', ticksLeft: v[0] };
          u.cpu.block();
        }
        return;
      }
      case 'SCAN': {
        const dir = v[0];
        if (!validDir(dir)) {
          this.setStatus(u, Status.ERR_INVALID);
          return [0, 0];
        }
        if (u.energy < BALANCE.scanEnergy) {
          this.setStatus(u, Status.ERR_LOW_POWER);
          return [0, 0];
        }
        // Radar: needs no light and does not turn the rover.
        const range = this.sensorRange(u);
        this.drain(u, BALANCE.scanEnergy);
        const [dx, dy] = DIR_VEC[dir];
        let hit = 0;
        let dist = 0;
        for (let d = 1; d <= range; d++) {
          const x = u.x + dx * d;
          const y = u.y + dy * d;
          hit = this.tileAt(x, y, Layer.ACTOR) || this.tileAt(x, y, Layer.OBSTACLE) || this.tileAt(x, y, Layer.ITEM);
          if (hit) {
            dist = d;
            break;
          }
        }
        this.events.emit('SCAN_PULSE', { unitId: u.id, x: u.x, y: u.y, dir, dist: dist || range, hit });
        this.setStatus(u, Status.OK);
        if (u.powered) {
          u.action = { kind: 'WAIT', ticksLeft: BALANCE.scanTicks };
          u.cpu.block();
        }
        return [hit, dist];
      }
      case 'STEP': {
        const dir = v[0];
        const tiles = v.length > 1 ? v[1] : 1;
        if (!validDir(dir) || tiles < 1) {
          this.setStatus(u, Status.ERR_INVALID);
          return;
        }
        const st = this.beginStepTile(u, dir, tiles);
        this.setStatus(u, st);
        if (st === Status.OK) u.cpu.block();
        return;
      }
      case 'RUN': {
        // Firmware only (compile rule). Nothing ready to run: ERR_INVALID, the firmware goes on.
        if (u.slice >= 0 || u.progState !== ProgState.PROG_READY || !this.hasProgram(u)) {
          this.setStatus(u, Status.ERR_INVALID);
          return;
        }
        this.setStatus(u, Status.OK);
        u.progState = ProgState.PROG_RUNNING;
        u.preempted = 0;
        u.slice = Math.max(1, v[0]);
        u.vm.block();
        return;
      }
      case 'ACT': {
        const slot = v[0];
        if (slot < 0 || slot >= u.chassis.tools.length) {
          this.setStatus(u, Status.ERR_INVALID);
          return;
        }
        const id = u.chassis.tools[slot];
        if (!id) {
          this.setStatus(u, Status.ERR_NO_TOOL);
          return;
        }
        this.startTool(u, TOOLS[id], v.length > 1 ? v[1] : 0);
        return;
      }
      case 'USE':
        this.startTool(u, TOOLS.USE_ITEM, v[0], v[1]);
        return;
      case 'SNAP':
        this.startTool(u, TOOLS.CAMERA, v[0], v.length > 1 ? v[1] : 1);
        return;
      case 'SEND':
        this.send(u, v.length ? v[0] : u.snapMode);
        return;
      case 'ERASE':
        this.erase(u);
        return;
      case 'PEEK': {
        const slot = v[0];
        if (slot < 0 || slot >= u.cargo.length) {
          this.setStatus(u, Status.ERR_INVALID);
          return [0];
        }
        return [u.cargo[slot]];
      }
    }
  }

  // ---------------------------------------------------------------- admin

  readonly admin = {
    forceCharge: (u: Unit) => {
      u.energy = u.chassis.batteryCapacity;
      if (u.vm.state === CpuState.POWER_OFF) {
        u.vm.state = CpuState.RUNNING;
        this.hardReboot(u, BootReason.ADMIN);
        this.log(u, 'warn', 'ADMIN: battery recharged, cold boot.');
      } else this.log(u, 'warn', 'ADMIN: battery recharged.');
    },
    forceRepair: (u: Unit) => {
      u.hull = 100;
      u.solarHealth = 100;
      u.antennaHealth = 100;
      u.solarDust = 0;
      if (u.vm.state === CpuState.DESTROYED) {
        u.vm.state = CpuState.RUNNING;
        this.hardReboot(u, BootReason.ADMIN);
      }
      this.log(u, 'warn', 'ADMIN: hull repaired.');
    },
    teleport: (u: Unit, x: number, y: number): boolean => {
      if (this.isBlocked(x, y)) return false;
      u.x = x;
      u.y = y;
      u.action = null;
      u.motion = null;
      if (u.cpu.state === CpuState.BLOCKED) u.cpu.unblock();
      this.revealAround(u);
      this.log(u, 'warn', `ADMIN: teleported to (${x}, ${y}).`);
      return true;
    },
    respawnAtOrigin: (u: Unit) => {
      u.x = 0;
      u.y = 0;
      u.action = null;
      u.motion = null;
      u.energy = u.chassis.batteryCapacity;
      u.hull = 100;
      u.solarHealth = 100;
      u.antennaHealth = 100;
      u.solarDust = 0;
      u.temp = ambientTemp(this.sun.light);
      u.vm.state = CpuState.RUNNING;
      this.hardReboot(u, BootReason.ADMIN);
      this.revealAround(u);
      this.log(u, 'warn', 'ADMIN: respawned at origin.');
    },
  };
}
