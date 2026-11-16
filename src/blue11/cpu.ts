/**
 * The Blue-11 CPU (the original /40 model's instruction set, EIS optional), with nothing around it:
 * memory and devices come from the host through a {@link Bus}.
 *
 * Deterministic and integer-only: no wall-clock time, no randomness, no exceptions out
 * of the public methods. Time is counted in cycles; the host chooses the cycle model.
 */

/** What a bus returns for an address with nothing there (or a write it refuses). */
export const BUS_ERROR = -1;

export interface Bus {
  /** A word (even address) or a byte; {@link BUS_ERROR} if nothing answers. */
  read(addr: number, byte: boolean): number;
  /** False if nothing answers or the write is refused (protection). */
  write(addr: number, value: number, byte: boolean): boolean;
  /** The `RESET` instruction: every device to its power-up state. */
  reset?(): void;
}

export type CycleModel = 'per-bus-access' | 'flat';

export interface CpuOptions {
  /** `MUL`, `DIV`, `ASH`, `ASHC` (the Extended Instruction Set option). Default off. */
  eis?: boolean;
  /**
   * `per-bus-access` (default): every memory read or write costs 1 cycle, including
   * instruction fetches; EIS adds a fixed internal cost. `flat`: 1 per instruction.
   */
  cycles?: CycleModel;
  /**
   * The original /45 model's rules for the non-kernel modes (PSW bits 15–14 ≠ 0): `RTI` / `RTT` can't lower
   * the mode bits (15–11) or change the priority (7–5); a write to the PSW's bus address
   * traps to 4 (the I/O page is not the user's); `RESET` does nothing. Default off.
   */
  protectModes?: boolean;
}

/** Vectors of the real machine. */
export const VEC = {
  BUS_ERROR: 0o004,
  ILLEGAL: 0o010,
  BPT: 0o014,
  IOT: 0o020,
  EMT: 0o030,
  TRAP: 0o034,
} as const;

export type TrapCause =
  | 'odd-address' | 'bus-error' | 'stack-limit' | 'illegal' | 'reserved'
  | 'bpt' | 'trace' | 'iot' | 'emt' | 'trap' | 'interrupt';

export interface TrapInfo {
  vector: number;
  cause: TrapCause;
  /** Address of the instruction that caused it (for interrupts: the PC it interrupts). */
  pc: number;
  /** Bus address involved (bus errors) or the EMT / TRAP number. */
  detail?: number;
}

export type StopReason =
  /** The cycle budget is used up. */
  | 'budget'
  /** `WAIT`: asleep until an interrupt. */
  | 'wait'
  /** `HALT`. */
  | 'halt'
  /** A trap the host chose to take itself ({@link Cpu.onTrap} returned 'stop'). */
  | 'trap'
  /** A trap that could not be taken (the stack push failed): the CPU halts. */
  | 'double-fault'
  /** A breakpoint address passed to {@link Cpu.run}. */
  | 'breakpoint';

export interface RunResult {
  reason: StopReason;
  cycles: number;
  instructions: number;
  /** For 'trap' and 'double-fault'. */
  trap?: TrapInfo;
}

export interface CpuState {
  r: number[];
  psw: number;
  waiting: boolean;
  halted: boolean;
  stackLimit: number;
  pending: Array<{ vector: number; level: number }>;
}

/** Processor status word bits. */
export const PSW = {
  C: 1, V: 2, Z: 4, N: 8, T: 0o20,
  PRIORITY: 0o340,
  CURRENT_MODE: 0o140000,
  PREVIOUS_MODE: 0o030000,
} as const;

/** The PSW also answers on the bus, as on the original machines. */
export const PSW_ADDRESS = 0o177776;

class Abort {
  constructor(readonly trap: TrapInfo) {}
}

const SP = 6;
const PC = 7;

export class Cpu {
  /** R0–R7 (R6 = SP, R7 = PC), 16-bit unsigned. */
  readonly r = new Array<number>(8).fill(0);
  psw = 0;
  /** Asleep in `WAIT` until an interrupt is taken. */
  waiting = false;
  /** Stopped by `HALT` or a double fault; `run` does nothing until cleared. */
  halted = false;
  /**
   * Stack limit (the original /70 model's `STKLIM` style, simplified): a push through `SP` to an address
   * below it traps to 4 before anything is written. 0 = no limit.
   */
  stackLimit = 0;

  /**
   * Called before a trap or interrupt is taken. Return 'stop' to have `run` / `step`
   * stop instead (the host handles it; the PC is left at the trapping instruction for
   * faults, after it for EMT / TRAP / BPT / IOT).
   */
  onTrap: ((t: TrapInfo) => 'vector' | 'stop') | null = null;
  /**
   * Called for every instruction once it is fetched, before it runs: its address and its
   * first word. For profilers, coverage maps, instruction counts by opcode. Not called for
   * an instruction whose fetch faults, nor for interrupts.
   */
  onInstruction: ((pc: number, opcode: number) => void) | null = null;
  /** Called when PSW bits 15–14 (current mode) change, by a trap, `RTI` or a PSW write. */
  onModeChange: ((newMode: number, oldMode: number) => void) | null = null;

  readonly eis: boolean;
  readonly cycleModel: CycleModel;
  readonly protectModes: boolean;

  private pending: Array<{ vector: number; level: number }> = [];
  private cyc = 0;
  /** Address of the instruction being executed. */
  private ipc = 0;

  constructor(private readonly bus: Bus, opts: CpuOptions = {}) {
    this.eis = opts.eis ?? false;
    this.cycleModel = opts.cycles ?? 'per-bus-access';
    this.protectModes = opts.protectModes ?? false;
  }

  /** Current mode (PSW bits 15–14): 0 kernel, 3 user. */
  get mode(): number { return this.psw >> 14; }

  // ---------------------------------------------------------------- public API

  /**
   * Run until the budget is used, or a stop. May overshoot by one instruction.
   * `breakpoints`: stop before executing an instruction at one of these addresses; with
   * `resume` (default) a breakpoint at the current PC is passed, so Continue works.
   */
  run(maxCycles: number, breakpoints?: ReadonlySet<number>, resume = true): RunResult {
    let cycles = 0;
    let instructions = 0;
    while (true) {
      if (this.halted) return { reason: 'halt', cycles, instructions };
      const taken = this.takeInterrupt();
      if (taken.stop) return { reason: 'trap', cycles: cycles + taken.cycles, instructions, trap: taken.stop };
      cycles += taken.cycles;
      if (taken.fault) return { reason: 'double-fault', cycles, instructions, trap: taken.fault };
      if (this.waiting) return { reason: 'wait', cycles, instructions };
      if (cycles >= maxCycles) return { reason: 'budget', cycles, instructions };
      if (breakpoints && (instructions > 0 || !resume) && breakpoints.has(this.r[PC])) {
        return { reason: 'breakpoint', cycles, instructions };
      }
      const s = this.execute();
      cycles += s.cycles;
      instructions++;
      if (s.reason) return { reason: s.reason, cycles, instructions, trap: s.trap };
    }
  }

  /** Exactly one instruction (or the interrupt waiting to be taken). For debuggers. */
  step(): RunResult {
    if (this.halted) return { reason: 'halt', cycles: 0, instructions: 0 };
    const taken = this.takeInterrupt();
    if (taken.stop) return { reason: 'trap', cycles: taken.cycles, instructions: 0, trap: taken.stop };
    if (taken.fault) return { reason: 'double-fault', cycles: taken.cycles, instructions: 0, trap: taken.fault };
    if (taken.cycles > 0) return { reason: 'budget', cycles: taken.cycles, instructions: 0 };
    if (this.waiting) return { reason: 'wait', cycles: 0, instructions: 0 };
    const s = this.execute();
    return { reason: s.reason ?? 'budget', cycles: s.cycles, instructions: 1, trap: s.trap };
  }

  /**
   * Request an interrupt. It is taken between instructions once `level` is above the
   * CPU priority (PSW bits 7–5); a pending request for the same vector is replaced.
   */
  interrupt(vector: number, level: number): void {
    this.pending = this.pending.filter((p) => p.vector !== vector);
    this.pending.push({ vector, level });
  }

  /** Withdraw a pending request (a device whose condition went away). */
  cancelInterrupt(vector: number): void {
    this.pending = this.pending.filter((p) => p.vector !== vector);
  }

  /** Power-up state: registers, PSW and pending interrupts cleared. */
  reset(): void {
    this.r.fill(0);
    this.psw = 0;
    this.waiting = false;
    this.halted = false;
    this.pending = [];
  }

  save(): CpuState {
    return {
      r: [...this.r], psw: this.psw, waiting: this.waiting, halted: this.halted,
      stackLimit: this.stackLimit, pending: this.pending.map((p) => ({ ...p })),
    };
  }

  load(s: CpuState): void {
    for (let i = 0; i < 8; i++) this.r[i] = (s.r[i] ?? 0) & 0xffff;
    this.psw = s.psw & 0xffff;
    this.waiting = s.waiting;
    this.halted = s.halted;
    this.stackLimit = s.stackLimit;
    this.pending = s.pending.map((p) => ({ ...p }));
  }

  get n(): boolean { return (this.psw & PSW.N) !== 0; }
  get z(): boolean { return (this.psw & PSW.Z) !== 0; }
  get v(): boolean { return (this.psw & PSW.V) !== 0; }
  get c(): boolean { return (this.psw & PSW.C) !== 0; }
  get priority(): number { return (this.psw >> 5) & 7; }

  // ---------------------------------------------------------------- bus access

  private read(addr: number, byte: boolean): number {
    addr &= 0xffff;
    if (!byte && (addr & 1)) throw new Abort({ vector: VEC.BUS_ERROR, cause: 'odd-address', pc: this.ipc, detail: addr });
    if (this.cycleModel === 'per-bus-access') this.cyc++;
    if ((addr & 0xfffe) === PSW_ADDRESS) return byte ? (addr & 1 ? this.psw >> 8 : this.psw & 0xff) : this.psw;
    const v = this.bus.read(addr, byte);
    if (v < 0) throw new Abort({ vector: VEC.BUS_ERROR, cause: 'bus-error', pc: this.ipc, detail: addr });
    return v;
  }

  private write(addr: number, value: number, byte: boolean): void {
    addr &= 0xffff;
    if (!byte && (addr & 1)) throw new Abort({ vector: VEC.BUS_ERROR, cause: 'odd-address', pc: this.ipc, detail: addr });
    if (this.cycleModel === 'per-bus-access') this.cyc++;
    if ((addr & 0xfffe) === PSW_ADDRESS) {
      if (this.protectModes && this.mode !== 0) {
        throw new Abort({ vector: VEC.BUS_ERROR, cause: 'bus-error', pc: this.ipc, detail: addr });
      }
      let w: number;
      if (!byte) w = value & 0xffff;
      else if (addr & 1) w = ((value & 0xff) << 8) | (this.psw & 0xff);
      else w = (this.psw & 0xff00) | (value & 0xff);
      // The T bit can't be set by a write (as on the real machine).
      this.setPsw((w & ~PSW.T) | (this.psw & PSW.T));
      return;
    }
    if (!this.bus.write(addr, byte ? value & 0xff : value & 0xffff, byte)) {
      throw new Abort({ vector: VEC.BUS_ERROR, cause: 'bus-error', pc: this.ipc, detail: addr });
    }
  }

  private fetch(): number {
    const w = this.read(this.r[PC], false);
    this.r[PC] = (this.r[PC] + 2) & 0xffff;
    return w;
  }

  private push(v: number): void {
    const sp = (this.r[SP] - 2) & 0xffff;
    if (this.stackLimit && sp < this.stackLimit) {
      throw new Abort({ vector: VEC.BUS_ERROR, cause: 'stack-limit', pc: this.ipc, detail: sp });
    }
    this.r[SP] = sp;
    this.write(sp, v, false);
  }

  private pop(): number {
    const v = this.read(this.r[SP], false);
    this.r[SP] = (this.r[SP] + 2) & 0xffff;
    return v;
  }

  private setPsw(v: number): void {
    const old = this.psw;
    this.psw = v & 0xffff;
    if ((old ^ this.psw) & PSW.CURRENT_MODE) this.onModeChange?.(this.psw >> 14, old >> 14);
  }

  // ---------------------------------------------------------------- operands

  /** Resolve an operand (6-bit mode/register) to a location: −1 − reg, or an address. */
  private ea(spec: number, byte: boolean): number {
    const mode = (spec >> 3) & 7;
    const reg = spec & 7;
    const step = byte && reg < 6 ? 1 : 2;
    let a: number;
    switch (mode) {
      case 0: return -1 - reg;
      case 1: return this.r[reg];
      case 2:
        a = this.r[reg];
        this.r[reg] = (a + step) & 0xffff;
        return a;
      case 3:
        a = this.r[reg];
        this.r[reg] = (a + 2) & 0xffff;
        return this.read(a, false);
      case 4:
        a = (this.r[reg] - step) & 0xffff;
        if (reg === SP && this.stackLimit && a < this.stackLimit) {
          throw new Abort({ vector: VEC.BUS_ERROR, cause: 'stack-limit', pc: this.ipc, detail: a });
        }
        this.r[reg] = a;
        return a;
      case 5:
        a = (this.r[reg] - 2) & 0xffff;
        this.r[reg] = a;
        return this.read(a, false);
      case 6: {
        const x = this.fetch();
        return (x + this.r[reg]) & 0xffff;
      }
      default: {
        const x = this.fetch();
        return this.read((x + this.r[reg]) & 0xffff, false);
      }
    }
  }

  private ld(loc: number, byte: boolean): number {
    if (loc < 0) {
      const v = this.r[-1 - loc];
      return byte ? v & 0xff : v;
    }
    return this.read(loc, byte);
  }

  private st(loc: number, value: number, byte: boolean): void {
    if (loc < 0) {
      const reg = -1 - loc;
      this.r[reg] = byte ? (this.r[reg] & 0xff00) | (value & 0xff) : value & 0xffff;
      return;
    }
    this.write(loc, value, byte);
  }

  private flags(n: boolean, z: boolean, v: boolean, c: boolean): void {
    this.psw = (this.psw & ~0o17) | (n ? 8 : 0) | (z ? 4 : 0) | (v ? 2 : 0) | (c ? 1 : 0);
  }

  private nz(value: number, msb: number, v: boolean, c: boolean): void {
    this.flags((value & msb) !== 0, value === 0, v, c);
  }

  // ---------------------------------------------------------------- traps, interrupts

  /** Take a trap: push PSW and PC, load the vector. Throws a double fault on failure. */
  private enter(t: TrapInfo): 'vector' | 'stop' {
    if (this.onTrap && this.onTrap(t) === 'stop') return 'stop';
    const oldPsw = this.psw;
    const oldPc = this.r[PC];
    try {
      this.push(oldPsw);
      this.push(oldPc);
      const pc = this.read(t.vector, false);
      const psw = this.read(t.vector + 2, false);
      this.r[PC] = pc;
      // The previous mode field records the mode we came from.
      this.setPsw((psw & ~PSW.PREVIOUS_MODE) | ((oldPsw >> 2) & PSW.PREVIOUS_MODE));
    } catch (e) {
      if (e instanceof Abort) throw new DoubleFault(t);
      throw e;
    }
    return 'vector';
  }

  private takeInterrupt(): { cycles: number; stop?: TrapInfo; fault?: TrapInfo } {
    if (this.pending.length === 0) return { cycles: 0 };
    const pri = this.priority;
    let best = -1;
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i];
      if (p.level > pri && (best < 0 || p.level > this.pending[best].level)) best = i;
    }
    if (best < 0) return { cycles: 0 };
    const p = this.pending[best];
    this.pending.splice(best, 1);
    this.waiting = false;
    this.cyc = 0;
    const t: TrapInfo = { vector: p.vector, cause: 'interrupt', pc: this.r[PC] };
    try {
      if (this.enter(t) === 'stop') return { cycles: this.cyc, stop: t };
    } catch (e) {
      if (e instanceof DoubleFault) { this.halted = true; return { cycles: this.cyc, fault: e.trap }; }
      throw e;
    }
    return { cycles: this.cycleModel === 'flat' ? 1 : this.cyc };
  }

  // ---------------------------------------------------------------- execution

  private execute(): { cycles: number; reason?: StopReason; trap?: TrapInfo } {
    this.cyc = 0;
    this.ipc = this.r[PC];
    const trace = (this.psw & PSW.T) !== 0;
    let extra = 0;
    let reason: StopReason | undefined;
    let trap: TrapInfo | undefined;
    let traceAfter = trace;
    try {
      const r = this.exec();
      if (typeof r === 'number') extra = r;
      else if (r === 'rti-trace') traceAfter = true;
      else if (r === 'rtt') traceAfter = false;
      else if (r) {
        if ('vector' in r) trap = r;
        else reason = r.stop;
      }
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
      // Faults: the instruction is abandoned; PC points back at it for the host.
      trap = e.trap;
    }
    try {
      if (trap) {
        const faulting = trap.cause !== 'bpt' && trap.cause !== 'iot' && trap.cause !== 'emt' && trap.cause !== 'trap';
        if (this.onTrap && this.onTrap(trap) === 'stop') {
          if (faulting) this.r[PC] = this.ipc;
          return { cycles: this.cost(extra), reason: 'trap', trap };
        }
        const saved = this.onTrap;
        this.onTrap = null;
        try { this.enter(trap); } finally { this.onTrap = saved; }
      } else if (traceAfter && !reason) {
        const t: TrapInfo = { vector: VEC.BPT, cause: 'trace', pc: this.ipc };
        if (this.enter(t) === 'stop') return { cycles: this.cost(extra), reason: 'trap', trap: t };
      }
    } catch (e) {
      if (e instanceof DoubleFault) {
        this.halted = true;
        return { cycles: this.cost(extra), reason: 'double-fault', trap: e.trap };
      }
      throw e;
    }
    return { cycles: this.cost(extra), reason };
  }

  private cost(extra: number): number {
    return this.cycleModel === 'flat' ? 1 : this.cyc + extra;
  }

  /**
   * One instruction. Returns extra internal cycles (EIS), a trap to take, a stop, or a
   * trace hint for RTI / RTT.
   */
  private exec(): ExecResult {
    const w = this.fetch();
    if (this.onInstruction) this.onInstruction(this.ipc, w);
    const op4 = w >> 12;
    switch (op4) {
      case 0o01: case 0o02: case 0o03: case 0o04: case 0o05:
      case 0o11: case 0o12: case 0o13: case 0o14: case 0o15:
        return this.double(w, op4 & 7, op4 >= 0o10);
      case 0o06: return this.double(w, 6, false); // ADD
      case 0o16: return this.double(w, 7, false); // SUB
      case 0o07: return this.exec7(w);
      case 0o00: return this.exec0(w);
      default: return this.exec10(w);
    }
  }

  /** k: 1 MOV, 2 CMP, 3 BIT, 4 BIC, 5 BIS, 6 ADD, 7 SUB. */
  private double(w: number, k: number, byte: boolean): ExecResult {
    const msb = byte ? 0x80 : 0x8000;
    const mask = byte ? 0xff : 0xffff;
    const src = this.ld(this.ea((w >> 6) & 0o77, byte), byte);
    const dl = this.ea(w & 0o77, byte);
    switch (k) {
      case 1: // MOV(B)
        this.nz(src, msb, false, this.c);
        if (byte && dl < 0) this.r[-1 - dl] = src & 0x80 ? src | 0xff00 : src; // MOVB to a register sign-extends
        else this.st(dl, src, byte);
        return;
      case 2: { // CMP(B): src − dst
        const d = this.ld(dl, byte);
        const r = (src - d) & mask;
        this.nz(r, msb, ((src ^ d) & msb) !== 0 && ((r ^ d) & msb) === 0, src < d);
        return;
      }
      case 3: // BIT(B)
        this.nz(src & this.ld(dl, byte), msb, false, this.c);
        return;
      case 4: { // BIC(B)
        const r = ~src & this.ld(dl, byte) & mask;
        this.nz(r, msb, false, this.c);
        this.st(dl, r, byte);
        return;
      }
      case 5: { // BIS(B)
        const r = (src | this.ld(dl, byte)) & mask;
        this.nz(r, msb, false, this.c);
        this.st(dl, r, byte);
        return;
      }
      case 6: { // ADD
        const d = this.ld(dl, false);
        const sum = src + d;
        const r = sum & 0xffff;
        this.nz(r, msb, ((src ^ d) & msb) === 0 && ((r ^ d) & msb) !== 0, sum > 0xffff);
        this.st(dl, r, false);
        return;
      }
      default: { // SUB: dst − src
        const d = this.ld(dl, false);
        const r = (d - src) & 0xffff;
        this.nz(r, msb, ((src ^ d) & msb) !== 0 && ((r ^ src) & msb) === 0, d < src);
        this.st(dl, r, false);
        return;
      }
    }
  }

  /** Single-operand group 0050–0063 and 1050–1063 (k = bits 8–6 plus 8 for 006x). */
  private single(w: number, byte: boolean): ExecResult {
    const msb = byte ? 0x80 : 0x8000;
    const mask = byte ? 0xff : 0xffff;
    const code = (w >> 6) & 0o77;
    const loc = this.ea(w & 0o77, byte);
    const c = this.c ? 1 : 0;
    let d: number;
    let r: number;
    switch (code) {
      case 0o50: // CLR
        this.flags(false, true, false, false);
        this.st(loc, 0, byte);
        return;
      case 0o51: // COM
        r = ~this.ld(loc, byte) & mask;
        this.nz(r, msb, false, true);
        this.st(loc, r, byte);
        return;
      case 0o52: // INC
        d = this.ld(loc, byte);
        r = (d + 1) & mask;
        this.nz(r, msb, d === msb - 1, this.c);
        this.st(loc, r, byte);
        return;
      case 0o53: // DEC
        d = this.ld(loc, byte);
        r = (d - 1) & mask;
        this.nz(r, msb, d === msb, this.c);
        this.st(loc, r, byte);
        return;
      case 0o54: // NEG
        d = this.ld(loc, byte);
        r = -d & mask;
        this.nz(r, msb, r === msb, r !== 0);
        this.st(loc, r, byte);
        return;
      case 0o55: // ADC
        d = this.ld(loc, byte);
        r = (d + c) & mask;
        this.nz(r, msb, d === msb - 1 && c === 1, d === mask && c === 1);
        this.st(loc, r, byte);
        return;
      case 0o56: // SBC
        d = this.ld(loc, byte);
        r = (d - c) & mask;
        this.nz(r, msb, d === msb && c === 1, d === 0 && c === 1);
        this.st(loc, r, byte);
        return;
      case 0o57: // TST
        this.nz(this.ld(loc, byte), msb, false, false);
        return;
      case 0o60: { // ROR
        d = this.ld(loc, byte);
        r = (d >> 1) | (c ? msb : 0);
        const cOut = (d & 1) !== 0;
        const n = (r & msb) !== 0;
        this.flags(n, r === 0, n !== cOut, cOut);
        this.st(loc, r, byte);
        return;
      }
      case 0o61: { // ROL
        d = this.ld(loc, byte);
        r = ((d << 1) | c) & mask;
        const cOut = (d & msb) !== 0;
        const n = (r & msb) !== 0;
        this.flags(n, r === 0, n !== cOut, cOut);
        this.st(loc, r, byte);
        return;
      }
      case 0o62: { // ASR
        d = this.ld(loc, byte);
        r = (d >> 1) | (d & msb);
        const cOut = (d & 1) !== 0;
        const n = (r & msb) !== 0;
        this.flags(n, r === 0, n !== cOut, cOut);
        this.st(loc, r, byte);
        return;
      }
      case 0o63: { // ASL
        d = this.ld(loc, byte);
        r = (d << 1) & mask;
        const cOut = (d & msb) !== 0;
        const n = (r & msb) !== 0;
        this.flags(n, r === 0, n !== cOut, cOut);
        this.st(loc, r, byte);
        return;
      }
      default:
        return this.illegal();
    }
  }

  private illegal(): TrapInfo {
    return { vector: VEC.ILLEGAL, cause: 'illegal', pc: this.ipc };
  }

  private branch(w: number): void {
    const cond = ((w >> 8) & 0o200) | ((w >> 8) & 7); // 0o00x or 0o20x
    const n = this.n, z = this.z, v = this.v, c = this.c;
    let take: boolean;
    switch (cond) {
      case 0o001: take = true; break; // BR
      case 0o002: take = !z; break; // BNE
      case 0o003: take = z; break; // BEQ
      case 0o004: take = n === v; break; // BGE
      case 0o005: take = n !== v; break; // BLT
      case 0o006: take = !z && n === v; break; // BGT
      case 0o007: take = z || n !== v; break; // BLE
      case 0o200: take = !n; break; // BPL
      case 0o201: take = n; break; // BMI
      case 0o202: take = !c && !z; break; // BHI
      case 0o203: take = c || z; break; // BLOS
      case 0o204: take = !v; break; // BVC
      case 0o205: take = v; break; // BVS
      case 0o206: take = !c; break; // BCC
      default: take = c; break; // BCS
    }
    if (take) {
      const off = w & 0o377;
      this.r[PC] = (this.r[PC] + 2 * (off & 0o200 ? off - 0o400 : off)) & 0xffff;
    }
  }

  private exec0(w: number): ExecResult {
    if (w >= 0o000400 && w < 0o004000) { this.branch(w); return; }
    if (w >= 0o004000 && w < 0o005000) { // JSR R, dst
      const reg = (w >> 6) & 7;
      const loc = this.ea(w & 0o77, false);
      if (loc < 0) return this.illegal();
      this.push(this.r[reg]);
      this.r[reg] = this.r[PC];
      this.r[PC] = loc;
      return;
    }
    if (w >= 0o005000 && w < 0o006400) return this.single(w, false);
    if (w >= 0o006700 && w < 0o007000) { // SXT
      const loc = this.ea(w & 0o77, false);
      const n = this.n;
      this.flags(n, !n, false, this.c);
      this.st(loc, n ? 0xffff : 0, false);
      return;
    }
    if (w >= 0o000300 && w < 0o000400) { // SWAB
      const loc = this.ea(w & 0o77, false);
      const d = this.ld(loc, false);
      const r = ((d >> 8) | (d << 8)) & 0xffff;
      this.nz(r & 0xff, 0x80, false, false);
      this.st(loc, r, false);
      return;
    }
    if (w >= 0o000100 && w < 0o000200) { // JMP
      const loc = this.ea(w & 0o77, false);
      if (loc < 0) return this.illegal();
      this.r[PC] = loc;
      return;
    }
    if (w >= 0o000200 && w <= 0o000207) { // RTS
      const reg = w & 7;
      this.r[PC] = this.r[reg];
      this.r[reg] = this.pop();
      return;
    }
    if (w >= 0o000240 && w < 0o000300) { // flag operations
      const bits = w & 0o17;
      if (w & 0o20) this.psw |= bits;
      else this.psw &= ~bits;
      return;
    }
    switch (w) {
      case 0: this.halted = true; return { stop: 'halt' };
      case 1: this.waiting = true; return { stop: 'wait' };
      case 2: case 6: { // RTI, RTT
        const pc = this.pop();
        let psw = this.pop();
        if (this.protectModes && this.mode !== 0) {
          // Not kernel: the mode bits can only go up, the priority stays.
          psw = (psw & ~0o174340) | ((psw | this.psw) & 0o174000) | (this.psw & 0o340);
        }
        this.r[PC] = pc;
        this.setPsw(psw);
        if (w === 6) return 'rtt';
        return psw & PSW.T ? 'rti-trace' : undefined;
      }
      case 3: return { vector: VEC.BPT, cause: 'bpt', pc: this.ipc };
      case 4: return { vector: VEC.IOT, cause: 'iot', pc: this.ipc };
      case 5: // RESET
        if (this.protectModes && this.mode !== 0) return;
        this.bus.reset?.(); this.pending = []; return;
      default: return this.illegal();
    }
  }

  private exec10(w: number): ExecResult {
    if (w < 0o104000) { this.branch(w); return; }
    if (w < 0o104400) return { vector: VEC.EMT, cause: 'emt', pc: this.ipc, detail: w & 0o377 };
    if (w < 0o105000) return { vector: VEC.TRAP, cause: 'trap', pc: this.ipc, detail: w & 0o377 };
    if (w < 0o106400) return this.single(w, true);
    return this.illegal();
  }

  private exec7(w: number): ExecResult {
    const sub = (w >> 9) & 7;
    const reg = (w >> 6) & 7;
    if (sub === 4) { // XOR R, dst
      const loc = this.ea(w & 0o77, false);
      const r = (this.r[reg] ^ this.ld(loc, false)) & 0xffff;
      this.nz(r, 0x8000, false, this.c);
      this.st(loc, r, false);
      return;
    }
    if (sub === 7) { // SOB R, offset
      this.r[reg] = (this.r[reg] - 1) & 0xffff;
      if (this.r[reg] !== 0) this.r[PC] = (this.r[PC] - 2 * (w & 0o77)) & 0xffff;
      return;
    }
    if (sub > 3 || !this.eis) return this.illegal();
    const s = this.ld(this.ea(w & 0o77, false), false);
    const ss = s & 0x8000 ? s - 0x10000 : s;
    const rv = this.r[reg];
    const rs = rv & 0x8000 ? rv - 0x10000 : rv;
    switch (sub) {
      case 0: { // MUL
        const p = rs * ss; // fits a double exactly (|p| < 2^31)
        const lo = p & 0xffff;
        const hi = (p >> 16) & 0xffff;
        if ((reg & 1) === 0) { this.r[reg] = hi; this.r[reg | 1] = lo; }
        else this.r[reg] = lo;
        this.flags(p < 0, p === 0, false, p < -0x8000 || p > 0x7fff);
        return 4;
      }
      case 1: { // DIV
        if (reg & 1) return this.illegal();
        const dividend = (this.r[reg] << 16) | this.r[reg + 1]; // 32-bit signed
        if (ss === 0) { this.flags(false, false, true, true); return 8; }
        const q = Math.trunc(dividend / ss);
        if (q < -0x8000 || q > 0x7fff) { this.flags(false, false, true, false); return 8; }
        const rem = dividend - q * ss;
        this.r[reg] = q & 0xffff;
        this.r[reg + 1] = rem & 0xffff;
        this.flags(q < 0, q === 0, false, false);
        return 8;
      }
      case 2: { // ASH
        const n = s & 0o77;
        const cnt = n & 0o40 ? n - 0o100 : n;
        let v = rs;
        let c = false;
        let ov = false;
        if (cnt > 0) {
          for (let i = 0; i < cnt; i++) {
            c = (v & 0x8000) !== 0;
            const nv = (v << 1) & 0xffff;
            if (((nv ^ v) & 0x8000) !== 0) ov = true;
            v = nv;
          }
        } else if (cnt < 0) {
          let u = rv;
          for (let i = 0; i < -cnt; i++) { c = (u & 1) !== 0; u = (u >> 1) | (u & 0x8000); }
          v = u;
        }
        v &= 0xffff;
        this.r[reg] = v;
        this.flags((v & 0x8000) !== 0, v === 0, ov, c);
        return 1;
      }
      default: { // ASHC
        const odd = (reg & 1) !== 0;
        let v = odd ? ((rv << 16) | rv) >>> 0 : ((rv << 16) | this.r[reg | 1]) >>> 0;
        const n = s & 0o77;
        const cnt = n & 0o40 ? n - 0o100 : n;
        let c = false;
        let ov = false;
        if (cnt > 0) {
          for (let i = 0; i < cnt; i++) {
            c = (v & 0x80000000) !== 0;
            const nv = (v << 1) >>> 0;
            if (((nv ^ v) & 0x80000000) !== 0) ov = true;
            v = nv;
          }
        } else if (cnt < 0) {
          for (let i = 0; i < -cnt; i++) { c = (v & 1) !== 0; v = ((v >>> 1) | (v & 0x80000000)) >>> 0; }
        }
        if (odd) this.r[reg] = v & 0xffff;
        else { this.r[reg] = (v >>> 16) & 0xffff; this.r[reg | 1] = v & 0xffff; }
        this.flags((v & 0x80000000) !== 0, v === 0, ov, c);
        return 1;
      }
    }
  }
}

type ExecResult = number | TrapInfo | { stop: StopReason } | 'rti-trace' | 'rtt' | void;

class DoubleFault {
  constructor(readonly trap: TrapInfo) {}
}
