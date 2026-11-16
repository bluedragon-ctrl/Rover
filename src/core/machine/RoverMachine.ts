/**
 * M15 Rover's side of the PDP-11 core (docs/PDP11_CPU.md §6–§8, §14.1): the bus (core,
 * image memory, ROM, I/O page), write protection, the two contexts and the gate, when
 * interrupts arrive, and program faults leaving through the gate. The CPU itself is the
 * standalone library in src/pdp11/; nothing here changes how it executes.
 *
 * Contexts: the gate (`MOV #GO, @#PRGCS`) swaps the whole register set, PC and PSW (two
 * saved CPU states). An interrupt or `TRAP` during the program swaps only the stack
 * pointer, as the PDP-11/45's kernel and user SPs: the firmware's handler runs on the
 * program's R0–R5 (saving what it uses) and on the firmware's stack, and its `RTI` back
 * into program mode restores the program's SP.
 */

import { BUS_ERROR, Cpu, PSW_ADDRESS, assemble, type AssembleResult, type Bus, type CpuState as Pdp11State, type TrapInfo } from '../../pdp11';
import { PDP11 } from '../balance';
import { TX_BOOT } from '../downlink';
import { freshParser, parseStream, type ParserState } from '../messages';

import { ProgState } from '../types';
import type { Capture, Unit } from '../Unit';
import type { WorldRegistry } from '../WorldRegistry';
import {
  CARGO_BASE,
  CARGO_BYTES,
  CLOCK_LEVEL,
  CLOCK_VECTOR,
  CSR,
  DEVICE_BLOCKS,
  DEVICE_LEVEL,
  deviceDone,
  freshIo,
  ioRegister,
  PROG_FAULT_NAMES,
  ProgFault,
  TX_VECTOR,
  Why,
  type DevKey,
  IO_REGISTERS,
  type IoContext,
  type IoHost,
  type IoRegister,
  type IoState,
} from './iopage';
import { ROM_BYTES, ROM_ENTRY } from './rom';
import { predefinedSymbols } from './symbols';

export type MachineSlot = 'firmware' | 'program';

/** An assembled image as it sits "on the disk". */
export interface MachineImage {
  source: string;
  origin: number;
  bytes: Uint8Array;
  start: number;
  /** First byte after the image (word-aligned): the stack limit of its context. */
  end: number;
}

export interface ImageResult {
  asm: AssembleResult;
  image: MachineImage | null;
  errors: Array<{ line: number; column: number; message: string }>;
}

/** Assemble a slot's source for its place in core (PDP11_CPU.md §6). */
export function assembleImage(source: string, slot: MachineSlot, registry: WorldRegistry, coreBytes = PDP11.coreBytes): ImageResult {
  const origin = slot === 'firmware' ? PDP11.firmwareBase : PDP11.programBase;
  const limit = slot === 'firmware' ? PDP11.programBase : coreBytes - 2; // the program's first stack word: its return address
  const asm = assemble(source, { origin, symbols: predefinedSymbols(registry), names: 'dec' });
  const errors = [...asm.errors];
  if (asm.ok && asm.bytes.length) {
    const end = asm.origin + asm.bytes.length;
    if (asm.origin < origin) {
      errors.push({ line: 0, column: 0, message: `${slot} code starts at ${asm.origin.toString(8).padStart(6, '0')}, below its region (${origin.toString(8).padStart(6, '0')})` });
    } else if (end > limit) {
        errors.push({ line: 0, column: 0, message: `${slot} ends at ${end.toString(8).padStart(6, '0')}: it must end below ${limit.toString(8).padStart(6, '0')} (${limit - origin} bytes)` });
    } else if (slot === 'firmware' && asm.bytes.length && asm.start !== origin) {
      errors.push({ line: 0, column: 0, message: 'the firmware starts at its first word (000200): put the entry point first' });
    }
  }
  const ok = errors.length === 0;
  const at = asm.bytes.length ? asm.origin : origin;
  const image = ok ? { source, origin: at, bytes: asm.bytes, start: asm.start, end: (at + asm.bytes.length + 1) & ~1 } : null;
  return { asm, image, errors };
}

/** What the machine asks of the engine. */
export interface MachineHost {
  readonly ctx: IoContext;
  /** Hard reboot (the `REBOOT` register, after the instruction). */
  reboot(u: Unit, reason: number, why: string): void;
  /** `HALT` (or a double fault) in the firmware: the whole CPU stops. */
  halt(u: Unit, fault: string | null): void;
  /** The program came back with a fault (already recorded in `PRGER`). */
  programFault(u: Unit, why: string): void;
  /** The program stopped at a `BPT` (or the trace bit): it reports itself with a dump. */
  programHalted?(u: Unit): void;
}

/** Saved machine state (SaveManager). */
export interface MachineSave {
  core: string;
  cpu: Pdp11State;
  fw: Pdp11State | null;
  prog: Pdp11State;
  bank: 'fw' | 'prog';
  progSp: number;
  progLimit: number;
  io: IoState;
  exitPending: { state: ProgState; why: number } | null;
  restartAfterExit: boolean;
  firmware: string;
  program: string;
  /** v20 (slice 4): the recorder's message stream and its view of it, boot status for safe mode. */
  rover?: {
    rec: number[];
    recParser: ParserState;
    imgCaps: Array<Capture | null>;
    bootReason: number;
    faultBoots: number[];
    safeMode: boolean;
  };
}

/** The program's PSW: current and previous mode user (11). */
const PROGRAM_PSW = 0o170000;

const hex = (b: Uint8Array): string => {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  let s = '';
  for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
};
const unhex = (s: string, into: Uint8Array): void => {
  into.fill(0);
  for (let i = 0; i * 2 < s.length && i < into.length; i++) into[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
};
const oct = (v: number): string => (v & 0xffff).toString(8).padStart(6, '0');

export class RoverMachine implements Bus {
  readonly cpu: Cpu;
  readonly core: Uint8Array;
  io: IoState = freshIo();
  firmware: MachineImage | null = null;
  program: MachineImage | null = null;
  /** The firmware's state while the program has control (saved at the gate). */
  private fw: Pdp11State | null = null;
  /** The program's state while the firmware has control. */
  private prog: Pdp11State;
  /** Whose registers the CPU holds. In program time, 'fw' means a firmware handler runs. */
  private bank: 'fw' | 'prog' = 'fw';
  /** The program's SP and stack limit while a firmware handler runs in its time. */
  private progSp = 0;
  private progLimit = 0;
  private gatePending = false;
  private rebootPending: number | null = null;
  /** A gate exit asked for while a handler runs (taken when it returns to the program). */
  private exitPending: { state: ProgState; why: number } | null = null;
  /** The program trap `run` stops on (set by onTrap). */
  private stopped: { state: ProgState; why: number; code: number; pc: number; text: string } | null = null;
  /** Why the last bus access failed. */
  private busFault: 'nxm' | 'pro' = 'nxm';
  /** The last firmware fault, for the reboot message. */
  private fwFault = '';
  private readonly host: IoHost;
  /**
   * Cycle meter for measuring the budget (slice 4): cycles executed this tick and in all, and
   * ticks that used the whole budget without sleeping. Metrics only: not saved, never read
   * by the simulation.
   */
  readonly meter = { tick: 0, total: 0, ticks: 0, starved: 0, peak: 0 };

  constructor(
    readonly u: Unit,
    private readonly mh: MachineHost,
    readonly coreBytes = PDP11.coreBytes,
  ) {
    this.core = new Uint8Array(coreBytes);
    this.cpu = new Cpu(this, { eis: false, cycles: 'per-bus-access', protectModes: true });
    this.cpu.onTrap = (t) => this.onTrap(t);
    this.cpu.onModeChange = (mode) => this.onModeChange(mode);
    this.prog = this.freshProgram();
    const m = this;
    this.host = {
      u,
      ctx: mh.ctx,
      get io() {
        return m.io;
      },
      get program() {
        return m.bank === 'prog';
      },
      gate: () => this.gate(),
      reboot: (reason) => (this.rebootPending = reason),
      // In the firmware's registers (also in a handler) the CPU holds its limit; else the saved state.
      get fwStackLimit() {
        return m.bank === 'fw' ? m.cpu.stackLimit : (m.fw?.stackLimit ?? 0);
      },
      set fwStackLimit(v: number) {
        if (m.bank === 'fw') m.cpu.stackLimit = v;
      },
      raise: (key) => this.raise(key),
      started: (key) => {
        const b = DEVICE_BLOCKS.find((d) => d.key === key)!;
        this.io.dev[key].ev = false;
        this.io.dev[key].done = false;
        this.cpu.cancelInterrupt(b.vector);
      },
    };
  }

  // ---------------------------------------------------------------- bus

  /** Core, image memory, ROM and cargo words (no side effects); BUS_ERROR elsewhere. */
  private readMemory(addr: number): number {
    if (addr < this.core.length) return this.core[addr] | (this.core[addr + 1] << 8);
    const img = this.u.imageMemory();
    if (addr >= PDP11.imageBase && addr < PDP11.imageBase + img.length) return img[addr - PDP11.imageBase] | (img[addr - PDP11.imageBase + 1] << 8);
    if (addr >= PDP11.romBase && addr < PDP11.romBase + ROM_BYTES.length) return ROM_BYTES[addr - PDP11.romBase] | ((ROM_BYTES[addr - PDP11.romBase + 1] ?? 0) << 8);
    if (addr >= CARGO_BASE && addr < CARGO_BASE + CARGO_BYTES) return ((this.u.cargo[addr - CARGO_BASE] ?? 0) & 0xff) | (((this.u.cargo[addr - CARGO_BASE + 1] ?? 0) & 0xff) << 8);
    return BUS_ERROR;
  }

  read(addr: number, byte: boolean): number {
    if (addr < this.core.length) return byte ? this.core[addr] : this.core[addr] | (this.core[addr + 1] << 8);
    const img = this.u.imageMemory();
    if (addr >= PDP11.imageBase && addr < PDP11.imageBase + img.length) {
      const a = addr - PDP11.imageBase;
      return byte ? img[a] : img[a] | (img[a + 1] << 8);
    }
    if (addr >= PDP11.romBase && addr < PDP11.romBase + ROM_BYTES.length) {
      const a = addr - PDP11.romBase;
      return byte ? ROM_BYTES[a] : ROM_BYTES[a] | ((ROM_BYTES[a + 1] ?? 0) << 8);
    }
    if (addr >= CARGO_BASE && addr < CARGO_BASE + CARGO_BYTES) {
      const slot = (i: number) => (this.u.cargo[i] ?? 0) & 0xff;
      const i = addr - CARGO_BASE;
      return byte ? slot(i) : slot(i) | (slot(i + 1) << 8);
    }
    const r = addr >= PDP11.ioBase ? ioRegister(addr) : undefined;
    if (!r) {
      this.busFault = 'nxm';
      return BUS_ERROR;
    }
    const v = r.access === 'WO' || !r.read ? 0 : r.read(this.host) & 0xffff;
    return byte ? (addr & 1 ? v >> 8 : v & 0xff) : v;
  }

  write(addr: number, value: number, byte: boolean): boolean {
    const program = this.bank === 'prog';
    if (addr < this.core.length) {
      if (program && addr < PDP11.programBase) return this.refuse('pro');
      this.core[addr] = value & 0xff;
      if (!byte) this.core[addr + 1] = (value >> 8) & 0xff;
      return true;
    }
    const img = this.u.imageMemory();
    if (addr >= PDP11.imageBase && addr < PDP11.imageBase + img.length) {
      const a = addr - PDP11.imageBase;
      img[a] = value & 0xff;
      if (!byte) img[a + 1] = (value >> 8) & 0xff;
      return true;
    }
    if (addr >= PDP11.romBase && addr < PDP11.romBase + ROM_BYTES.length) return this.refuse('pro');
    if (addr >= CARGO_BASE && addr < CARGO_BASE + CARGO_BYTES) return true; // read-only: ignored
    const r = addr >= PDP11.ioBase ? ioRegister(addr) : undefined;
    if (!r) return this.refuse('nxm');
    if (r.access === 'FW' && program) return this.refuse('pro');
    if (byte && addr & 1) return true; // the high byte of these registers takes no writes
    if (r.access !== 'RO' && r.write) r.write(this.host, value & 0xffff);
    this.afterIoWrite();
    return true;
  }

  /** `RESET` (firmware): every device register to its reboot state; a drive stops at the end of its tile. */
  reset(): void {
    const keepPrg = this.io.prg;
    this.io = freshIo();
    this.io.prg = keepPrg;
    this.io.tx.ready = this.u.link.txFree(PDP11.txFifoBytes) > 0;
    if (this.u.action?.kind === 'STEP') this.host.ctx.device(this.u, 'DRIVE_N', 0);
    this.u.driveN = 0;
  }

  private refuse(why: 'nxm' | 'pro'): false {
    this.busFault = why;
    return false;
  }

  private afterIoWrite(): void {
    if (this.io.tx.ev) {
      this.io.tx.ev = false;
      this.cpu.interrupt(TX_VECTOR, DEVICE_LEVEL);
    }
  }

  /** A device event: interrupt now if its IE is set, else remember nothing (one request per event). */
  private raise(key: DevKey): void {
    const l = this.io.dev[key];
    l.done = true;
    if (l.ie) this.cpu.interrupt(DEVICE_BLOCKS.find((d) => d.key === key)!.vector, DEVICE_LEVEL);
  }

  // ---------------------------------------------------------------- images and reboot

  /** Hard reboot: core cleared, both images copied in from the disk, the CPU at the boot ROM. */
  hardReboot(): void {
    this.core.fill(0);
    if (this.firmware) this.core.set(this.firmware.bytes, this.firmware.origin);
    this.loadProgramImage();
    this.io = freshIo();
    this.u.driveN = 0;
    this.u.link.tx.push(TX_BOOT);
    this.u.link.rec.push(TX_BOOT); // a message being written into the recorder stays incomplete
    parseStream(this.u.recParser, [TX_BOOT], this.u.id, 0);
    this.u.link.txLost = 0;
    this.io.tx.ready = this.u.link.txFree(PDP11.txFifoBytes) > 0;
    this.cpu.reset();
    this.cpu.r[7] = ROM_ENTRY.BOOT;
    this.cpu.psw = 0o340;
    this.cpu.stackLimit = this.firmware?.end ?? PDP11.firmwareBase;
    this.fw = null;
    this.bank = 'fw';
    this.gatePending = false;
    this.rebootPending = null;
    this.exitPending = null;
    this.restartAfterExit = false;
    this.stopped = null;
    this.prog = this.freshProgram();
  }

  /** The program image into core (upload, reboot). Its old memory is overwritten. */
  loadProgramImage(): void {
    this.core.fill(0, PDP11.programBase);
    if (this.program) this.core.set(this.program.bytes, this.program.origin);
  }

  get hasProgram(): boolean {
    return (this.program?.bytes.length ?? 0) > 0;
  }

  /** A fresh program context: entry point, SP at the top of core with the ROM's EXIT as return address. */
  private freshProgram(): Pdp11State {
    const top = this.coreBytes;
    return {
      r: [0, 0, 0, 0, 0, 0, top - 2, this.program?.start ?? PDP11.programBase],
      psw: PROGRAM_PSW,
      waiting: false,
      halted: false,
      stackLimit: this.program?.end ?? PDP11.programBase,
      pending: [],
    };
  }

  /**
   * Restart the program from the top (upload, Run again, `PRGST` P.RDY). Its memory keeps
   * what it changed. Asked while a firmware handler runs in the program's time, it happens
   * when the handler returns; returns false then.
   */
  restartProgram(): boolean {
    if (this.u.slice >= 0 && this.bank === 'fw') {
      this.exitPending = { state: ProgState.PROG_READY, why: Why.NONE };
      this.restartAfterExit = true;
      return false;
    }
    if (this.u.slice >= 0) this.exit(ProgState.PROG_READY, Why.NONE);
    this.fresh();
    return true;
  }

  private fresh(): void {
    this.exitPending = null;
    this.restartAfterExit = false;
    this.prog = this.freshProgram();
    const sp = this.prog.r[6];
    this.core[sp] = ROM_ENTRY.EXIT & 0xff;
    this.core[sp + 1] = ROM_ENTRY.EXIT >> 8;
  }

  private restartAfterExit = false;

  // ---------------------------------------------------------------- the gate

  private gate(): void {
    const ok = this.bank === 'fw' && this.u.slice < 0 && this.u.progState === ProgState.PROG_READY && this.hasProgram;
    this.io.prg.err = !ok;
    if (ok) this.gatePending = true;
  }

  /** After the gate instruction: the program's registers in, the firmware's saved. */
  private enterProgram(): void {
    this.gatePending = false;
    const u = this.u;
    const fw = this.cpu.save();
    this.fw = fw;
    this.cpu.load({ ...this.prog, pending: fw.pending });
    this.bank = 'prog';
    u.progState = ProgState.PROG_RUNNING;
    u.preempted = 0;
    u.slice = u.sliceSet;
  }

  /** The program comes back: its state saved, the firmware continues after its gate write. */
  private exit(state: ProgState, why: number): void {
    const u = this.u;
    if (u.slice < 0 || !this.fw) return;
    if (this.bank === 'fw') {
      // A firmware handler runs in the program's time: put the program's SP back first.
      this.fw.r[6] = this.cpu.r[6];
      this.fw.stackLimit = this.cpu.stackLimit;
      this.cpu.r[6] = this.progSp;
      this.cpu.stackLimit = this.progLimit;
    }
    const prog = this.cpu.save();
    this.prog = { ...prog, pending: [] };
    this.cpu.load({ ...this.fw, pending: prog.pending });
    this.fw = null;
    this.bank = 'fw';
    this.exitPending = null;
    u.slice = -1;
    u.progState = state;
    this.io.prg.why = why;
    this.io.prg.pc = prog.r[7];
    if (this.restartAfterExit) {
      this.fresh();
      u.progResult = 0;
      u.progState = this.hasProgram ? ProgState.PROG_READY : ProgState.PROG_NONE;
    }
  }

  /**
   * The engine ends the program's run (slice used up, preempted, restart): now if the
   * program's registers are in, else when the firmware handler returns to it.
   */
  requestExit(state: ProgState): void {
    if (this.u.slice < 0) return;
    const why = state === ProgState.PROG_READY ? (this.u.preempted ? Why.PRE : Why.TIME) : state === ProgState.PROG_DONE ? Why.DONE : state === ProgState.PROG_FAULT ? Why.FLT : Why.BPT;
    if (this.bank === 'prog') this.exit(state, why);
    else this.exitPending = { state, why };
  }

  // ---------------------------------------------------------------- traps and modes

  private onTrap(t: TrapInfo): 'vector' | 'stop' {
    if (this.bank === 'prog' && this.u.slice >= 0) {
      if (t.cause === 'interrupt') return this.enterHandler();
      if (t.cause === 'trap' && this.read(0o34, false) !== ROM_ENTRY.TRPDEF) return this.enterHandler();
      const bpt = t.cause === 'bpt' || t.cause === 'trace';
      const code = this.faultCode(t);
      this.io.prg.code = bpt ? this.io.prg.code : code;
      this.stopped = {
        state: bpt ? ProgState.PROG_HALTED : ProgState.PROG_FAULT,
        why: bpt ? Why.BPT : Why.FLT,
        code,
        pc: t.pc,
        text: this.describe(t, code),
      };
      return 'stop';
    }
    if (t.cause !== 'interrupt' && t.cause !== 'bpt' && t.cause !== 'trace' && t.cause !== 'trap' && t.cause !== 'emt' && t.cause !== 'iot') {
      this.fwFault = this.describe(t, this.faultCode(t));
    }
    return 'vector';
  }

  /** Interrupt or system call in the program's time: the firmware's stack, the program's R0–R5. */
  private enterHandler(): 'vector' {
    const fw = this.fw!;
    this.progSp = this.cpu.r[6];
    this.progLimit = this.cpu.stackLimit;
    this.cpu.r[6] = fw.r[6];
    this.cpu.stackLimit = fw.stackLimit;
    this.bank = 'fw';
    return 'vector';
  }

  /** `RTI` back into program mode ends a handler: the program's SP returns. */
  private onModeChange(mode: number): void {
    if (mode !== 3 || this.bank !== 'fw' || this.u.slice < 0 || !this.fw) return;
    this.fw.r[6] = this.cpu.r[6];
    this.fw.stackLimit = this.cpu.stackLimit;
    this.cpu.r[6] = this.progSp;
    this.cpu.stackLimit = this.progLimit;
    this.bank = 'prog';
  }

  private faultCode(t: TrapInfo): number {
    switch (t.cause) {
      case 'odd-address': return ProgFault.ODD;
      case 'bus-error': return t.detail === PSW_ADDRESS || this.busFault === 'pro' ? ProgFault.PRO : ProgFault.NXM;
      case 'stack-limit': return ProgFault.STK;
      case 'iot': return ProgFault.IOT;
      case 'emt': return ProgFault.EMT;
      case 'trap': return ProgFault.TRP;
      case 'bpt': case 'trace': return 0;
      default: return ProgFault.ILL;
    }
  }

  private describe(t: TrapInfo, code: number): string {
    const at = ` at ${oct(t.pc)}`;
    if (t.cause === 'bpt' || t.cause === 'trace') return `breakpoint${at}`;
    const addr = t.detail !== undefined && (code === ProgFault.ODD || code === ProgFault.NXM || code === ProgFault.PRO || code === ProgFault.STK) ? ` ${oct(t.detail)}` : '';
    return `${PROG_FAULT_NAMES[code] ?? t.cause}${addr}${at}`;
  }

  // ---------------------------------------------------------------- ticks

  /**
   * Start of a tick (after the world moved): the line clock ticks, devices that finished
   * request their interrupts, a TX FIFO with room again requests its own.
   */
  tickStart(): void {
    const m = this.meter;
    m.ticks++;
    m.tick = 0;
    const io = this.io;
    io.lks |= CSR.DONE;
    if (io.lks & CSR.IE) this.cpu.interrupt(CLOCK_VECTOR, CLOCK_LEVEL);
    for (const b of DEVICE_BLOCKS) {
      const l = io.dev[b.key];
      const done = deviceDone(this.u, io, b.key);
      if (done && !l.done) {
        l.done = true;
        if (l.ie) this.cpu.interrupt(b.vector, DEVICE_LEVEL);
      } else l.done = done;
    }
    const ready = this.u.link.txFree(PDP11.txFifoBytes) > 0;
    if (ready && !io.tx.ready && io.tx.ie) this.cpu.interrupt(TX_VECTOR, DEVICE_LEVEL);
    io.tx.ready = ready;
    if (this.exitPending && this.bank === 'prog') this.exit(this.exitPending.state, this.exitPending.why);
  }

  /**
   * Run until the tick's cycles are used (`u.cyclesLeft`), the CPU sleeps or stops, or
   * `maxInstructions`. Returns the instructions executed.
   */
  run(maxInstructions = Infinity): number {
    const u = this.u;
    const cpu = this.cpu;
    let n = 0;
    if (cpu.halted && this.bank === 'fw') cpu.halted = false; // Continue after a firmware HALT
    while (u.cyclesLeft > 0 && n < maxInstructions) {
      if (this.exitPending && this.bank === 'prog') this.exit(this.exitPending.state, this.exitPending.why);
      const r = cpu.step();
      n += r.instructions;
      u.cyclesLeft -= r.cycles;
      this.meter.total += r.cycles;
      this.meter.tick += r.cycles;
      if (this.meter.tick > this.meter.peak) this.meter.peak = this.meter.tick;
      if (u.cyclesLeft <= 0 && !cpu.waiting) this.meter.starved++;
      if (this.rebootPending !== null) {
        const reason = this.rebootPending;
        this.rebootPending = null;
        u.cyclesLeft = 0;
        this.mh.reboot(u, reason, this.fwFault);
        this.fwFault = '';
        return n;
      }
      if (this.gatePending) this.enterProgram();
      if (r.reason === 'trap' && this.stopped) {
        const s = this.stopped;
        this.stopped = null;
        this.exit(s.state, s.why);
        if (s.state === ProgState.PROG_FAULT) this.mh.programFault(u, s.text);
        else if (s.state === ProgState.PROG_HALTED) this.mh.programHalted?.(u);
      } else if (r.reason === 'halt') {
        if (this.bank === 'prog' && u.slice >= 0) {
          cpu.halted = false;
          u.progResult = cpu.r[0];
          this.exit(ProgState.PROG_DONE, Why.DONE);
        } else {
          u.cyclesLeft = 0;
          this.mh.halt(u, null);
          return n;
        }
      } else if (r.reason === 'double-fault') {
        u.cyclesLeft = 0;
        this.mh.halt(u, `double fault: ${r.trap ? this.describe(r.trap, this.faultCode(r.trap)) : '?'}`);
        return n;
      }
      if (cpu.waiting) {
        u.cyclesLeft = 0; // asleep until an interrupt: the rest of the tick
        break;
      }
      if (r.instructions === 0 && r.cycles === 0) break;
    }
    return n;
  }

  /** A context's registers R0–R7 and PSW as they are now (debugger, tests). */
  registers(slot: MachineSlot): { r: number[]; psw: number } {
    const live = { r: [...this.cpu.r], psw: this.cpu.psw };
    if (slot === 'program') {
      if (this.bank === 'prog') return live;
      if (this.u.slice >= 0) return { r: [...live.r.slice(0, 6), this.progSp, live.r[7]], psw: live.psw }; // a handler runs on its R0–R5
      return { r: [...this.prog.r], psw: this.prog.psw };
    }
    if (this.u.slice < 0 || !this.fw) return live;
    return { r: [...this.fw.r], psw: this.fw.psw };
  }

  /**
   * A context's stack for a dump: SP and up to `max` words from SP towards the stack's base
   * (the firmware's at the program base, the program's at the top of core). Read from core
   * without bus side effects; an SP outside core gives no words.
   */
  stackWords(slot: MachineSlot, max: number): { sp: number; words: number[] } {
    const sp = this.registers(slot).r[6] & 0xfffe;
    const base = slot === 'program' ? this.coreBytes : PDP11.programBase;
    const words: number[] = [];
    const end = Math.min(base, this.coreBytes);
    for (let a = sp; a + 2 <= end && words.length < max; a += 2) words.push(this.core[a] | (this.core[a + 1] << 8));
    return { sp, words };
  }

  /**
   * Debugger read of memory (core, image memory, ROM, cargo): no bus side effects, null for
   * the I/O page and addresses with nothing there.
   */
  peek(addr: number): number | null {
    addr &= 0xfffe;
    if (addr >= PDP11.ioBase) return null;
    const v = this.readMemory(addr);
    return v === BUS_ERROR ? null : v;
  }

  /**
   * Debugger view of the I/O page: every named register's value as a read would give it,
   * computed on a copy of the device state so that reads with side effects (`TICKL` latches
   * `TICKH`) change nothing. Write-only registers read 0.
   */
  ioSnapshot(): Array<{ reg: IoRegister; value: number }> {
    const none = () => {};
    const host: IoHost = { u: this.u, ctx: this.mh.ctx, io: structuredClone(this.io), program: this.bank === 'prog', fwStackLimit: this.host.fwStackLimit, gate: none, reboot: none, raise: none, started: none };
    return IO_REGISTERS.filter((r) => !r.alias).map((reg) => ({ reg, value: reg.access === 'WO' || !reg.read ? 0 : reg.read(host) & 0xffff }));
  }

  /** Who runs now: firmware, a firmware handler in the program's time, or the program. */
  get context(): 'firmware' | 'handler' | 'program' {
    return this.bank === 'prog' ? 'program' : this.u.slice >= 0 ? 'handler' : 'firmware';
  }

  // ---------------------------------------------------------------- save

  save(): MachineSave {
    return {
      core: hex(this.core),
      cpu: this.cpu.save(),
      fw: this.fw ? { ...this.fw, r: [...this.fw.r], pending: [] } : null,
      prog: { ...this.prog, r: [...this.prog.r], pending: [] },
      bank: this.bank,
      progSp: this.progSp,
      progLimit: this.progLimit,
      io: JSON.parse(JSON.stringify(this.io)) as IoState,
      exitPending: this.exitPending ? { ...this.exitPending } : null,
      restartAfterExit: this.restartAfterExit,
      firmware: this.firmware?.source ?? '',
      program: this.program?.source ?? '',
      rover: {
        rec: [...this.u.link.rec],
        recParser: structuredClone(this.u.recParser),
        imgCaps: this.u.imgCaps.map((c) => (c ? structuredClone(c) : null)),
        bootReason: this.u.bootReason,
        faultBoots: [...this.u.faultBoots],
        safeMode: this.u.safeMode,
      },
    };
  }

  /** Restore (images already assembled from the saved sources). */
  load(s: MachineSave): void {
    unhex(s.core, this.core);
    this.cpu.load(s.cpu);
    this.fw = s.fw ? { ...s.fw, r: [...s.fw.r], pending: [] } : null;
    this.prog = { ...s.prog, r: [...s.prog.r], pending: [] };
    this.bank = s.bank;
    this.progSp = s.progSp;
    this.progLimit = s.progLimit;
    this.io = JSON.parse(JSON.stringify(s.io)) as IoState;
    this.exitPending = s.exitPending ? { ...s.exitPending } : null;
    this.restartAfterExit = s.restartAfterExit;
    const r = s.rover;
    this.u.link.rec = [...(r?.rec ?? [])];
    this.u.recParser = r ? structuredClone(r.recParser) : freshParser();
    this.u.imgCaps = (r?.imgCaps ?? []).map((c) => (c ? structuredClone(c) : null));
    this.u.bootReason = r?.bootReason ?? 0;
    this.u.faultBoots = [...(r?.faultBoots ?? [])];
    this.u.safeMode = r?.safeMode ?? false;
  }
}
