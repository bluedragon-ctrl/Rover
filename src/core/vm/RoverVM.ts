import type { ChassisDef } from '../balance';
import { CpuState, Status, i32 } from '../types';
import { PROGRAM_GATE, romProgram, ROM_BASE, type Operand, type Program } from './Compiler';

/** What the VM needs from the outside world. Implemented by SimulationEngine. */
export interface VmHost {
  readPort(name: string): number;
  /** A port write; writing a device's start port starts it and sets @STATUS (M14). */
  writePort(name: string, value: number): void;
  /** LOG: queue a log frame (compute instruction, no @STATUS). */
  log?(tag: number, value: number | null): void;
  /** END, or RET from the program's top level (program slot): the program finished with `value`. */
  end?(value: number): void;
  /**
   * M14 `WAIT @port` found the port at 0: the device's result for @STATUS (undefined: not a
   * device port, @STATUS stays).
   */
  waitResult?(port: string): number | undefined;
  /**
   * M14 firmware `CALL PROGRAM`: enter the program if it is ready (true; the host switches
   * contexts), else false (the CALL does nothing, @STATUS = ERR_INVALID).
   */
  callProgram?(): boolean;
  /**
   * LDB: the byte (0–255) at data address `addr` (M14 memory map: RAM, image memory, cargo),
   * or undefined if no memory answers there (the CPU faults). Compute: no @STATUS.
   */
  load?(addr: number): number | undefined;
  /** STB: store `value & 255` at data address `addr`; returns why not (the CPU faults), or null. */
  store?(addr: number, value: number): string | null;
}

export type StepResult = 'continue' | 'endTick';

export class RoverVM {
  program: Program | null = null;
  ip = 0;
  regs: Int32Array;
  dataStack: number[] = [];
  callStack: number[] = [];
  state: CpuState = CpuState.RUNNING;
  status: Status = Status.OK;
  faultReason = '';
  /** Ticks until the watchdog reboots a FAULTed CPU. */
  watchdog = 0;
  /** M14 @TIMER of this slot: ticks left (counted down by the host every tick). */
  timer = 0;
  /** Source line of the instruction executed most recently (for the debugger). */
  lastLine = 0;
  instructionsExecuted = 0;

  /** `isProgram`: the program slot's context (a top-level RET returns to the firmware). */
  constructor(readonly chassis: ChassisDef, readonly isProgram = false) {
    this.regs = new Int32Array(chassis.registers);
  }

  /** Hardware upgrade: grow the register file, keeping current values. */
  resizeRegisters(n: number): void {
    if (n <= this.regs.length) return;
    const r = new Int32Array(n);
    r.set(this.regs);
    this.regs = r;
  }

  load(program: Program): void {
    this.program = program;
    this.reboot();
  }

  /** Hard reboot: wipe CPU state, keep the program. Physical state is the host's concern. */
  reboot(): void {
    this.ip = 0;
    this.regs.fill(0);
    this.dataStack = [];
    this.callStack = [];
    this.status = Status.OK;
    this.faultReason = '';
    this.watchdog = 0;
    this.timer = 0;
    this.lastLine = 0;
    if (this.state !== CpuState.DESTROYED && this.state !== CpuState.POWER_OFF) this.state = CpuState.RUNNING;
  }

  block(): void {
    this.state = CpuState.BLOCKED;
  }

  unblock(): void {
    if (this.state === CpuState.BLOCKED) this.state = CpuState.RUNNING;
  }

  /** BRK: stop until mission control sends Continue (or an upload reboots). */
  halt(): void {
    this.state = CpuState.HALTED;
  }

  /** Continue command: leave HALTED. */
  resume(): void {
    if (this.state === CpuState.HALTED) this.state = CpuState.RUNNING;
  }

  fault(reason: string, watchdogTicks: number): void {
    this.state = CpuState.FAULT;
    this.faultReason = reason;
    this.watchdog = watchdogTicks;
  }

  /** Byte address of the instruction that will run next (after wrap-around; ROM and the program gate as they are). */
  get nextIp(): number {
    if (this.ip >= PROGRAM_GATE) return this.ip;
    const n = this.program?.codeBytes ?? 0;
    return n === 0 || this.ip >= n || this.ip < 0 ? 0 : this.ip;
  }

  /** Inside a ROM routine (M14)? */
  get inRom(): boolean {
    return this.ip >= ROM_BASE;
  }

  /** Source line of the instruction at byte address `addr` in this slot's code (0 if none starts there, or ROM). */
  lineAt(addr: number): number {
    if (addr >= PROGRAM_GATE) return 0;
    const p = this.program;
    const k = p?.indexAt.get(addr);
    return k === undefined ? 0 : p!.instrs[k].line;
  }

  get nextLine(): number {
    return this.lineAt(this.nextIp);
  }

  /** Execute exactly one instruction. Caller guarantees state === RUNNING. */
  step(host: VmHost, watchdogTicks: number): StepResult {
    const own = this.program;
    if (!own || own.instrs.length === 0) return 'endTick';
    const rom = this.ip >= ROM_BASE;
    if (!rom && (this.ip >= own.codeBytes || this.ip < 0)) this.ip = 0; // implicit main loop (the data section is not code)
    const prog = rom ? romProgram() : own;
    const k = prog.indexAt.get(this.ip);
    if (k === undefined) {
      // Only reachable through a corrupted return address: no instruction starts here.
      this.fault(`No instruction at address 0x${this.ip.toString(16)}`, watchdogTicks);
      return 'endTick';
    }
    const ins = prog.instrs[k];
    if (!rom) this.lastLine = ins.line;
    this.instructionsExecuted++;
    const a = ins.args;
    const val = (o: Operand): number => {
      switch (o.k) {
        case 'imm':
          return o.v;
        case 'reg':
          return this.regs[o.i];
        case 'port':
          return i32(host.readPort(o.name));
        case 'label':
          return o.target;
        case 'mem':
          return addrOf(o);
      }
    };
    const addrOf = (o: Operand): number => {
      const m = o as { base: number; off: number };
      return (m.base >= 0 ? this.regs[m.base] : 0) + m.off;
    };
    const hex = (n: number) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(3, '0')}`;
    const put = (o: Operand, v: number): void => {
      if (o.k === 'reg') this.regs[o.i] = v;
      else if (o.k === 'port') host.writePort(o.name, i32(v));
    };
    const jump = (o: Operand) => {
      this.ip = (o as { target: number }).target;
    };
    const stackFault = (why: string): StepResult => {
      this.fault(why, watchdogTicks);
      return 'endTick';
    };

    let next = ins.addr + ins.size;
    switch (ins.op) {
      case 'MOV':
        put(a[0], val(a[1]));
        break;
      case 'PUSH':
        if (this.dataStack.length >= this.chassis.dataStack) return stackFault('Data stack overflow (PUSH)');
        this.dataStack.push(val(a[0]));
        break;
      case 'POP': {
        const v = this.dataStack.pop();
        if (v === undefined) return stackFault('Data stack underflow (POP)');
        put(a[0], v);
        break;
      }
      case 'ADD':
        put(a[0], i32(val(a[0]) + val(a[1])));
        break;
      case 'SUB':
        put(a[0], i32(val(a[0]) - val(a[1])));
        break;
      case 'MUL':
        put(a[0], Math.imul(val(a[0]), val(a[1])));
        break;
      case 'DIV':
      case 'MOD': {
        const x = val(a[0]);
        const y = val(a[1]);
        if (y === 0) {
          put(a[0], 0);
          this.status = Status.ERR_INVALID;
          break;
        }
        if (ins.op === 'DIV') put(a[0], i32(Math.trunc(x / y)));
        else {
          let r = x % y;
          if (r < 0) r += Math.abs(y);
          put(a[0], i32(r));
        }
        break;
      }
      case 'AND':
        put(a[0], val(a[0]) & val(a[1]));
        break;
      case 'OR':
        put(a[0], val(a[0]) | val(a[1]));
        break;
      case 'SHL':
      case 'SHR': {
        // Counts are clamped to 0–32: 32 or more shifts every bit out (unlike JS, which
        // uses the count mod 32). SHR is logical: zeros come in from the left.
        const n = Math.max(0, Math.min(32, val(a[1])));
        const x = val(a[0]);
        if (n === 32) put(a[0], 0);
        else put(a[0], ins.op === 'SHL' ? x << n : i32(x >>> n));
        break;
      }
      case 'JMP':
        jump(a[0]);
        return 'continue';
      case 'JEQ':
      case 'JNE':
      case 'JLT':
      case 'JGT':
      case 'JLE':
      case 'JGE': {
        const x = val(a[0]);
        const y = val(a[1]);
        const take =
          ins.op === 'JEQ' ? x === y : ins.op === 'JNE' ? x !== y : ins.op === 'JLT' ? x < y : ins.op === 'JGT' ? x > y : ins.op === 'JLE' ? x <= y : x >= y;
        if (take) {
          jump(a[2]);
          return 'continue';
        }
        break;
      }
      case 'CALL': {
        const args = a.slice(1).map(val);
        if (this.callStack.length >= this.chassis.callStack) return stackFault('Call stack overflow (CALL)');
        if (this.dataStack.length + args.length > this.chassis.dataStack) return stackFault('Data stack overflow (CALL args)');
        if ((a[0] as { target: number }).target === PROGRAM_GATE) {
          // M14 CALL PROGRAM: the return address goes on this call stack; the host switches to
          // the program's context, which continues in this tick with the cycles left.
          this.ip = next;
          if (!this.isProgram && host.callProgram?.()) {
            this.status = Status.OK;
            this.callStack.push(next);
            this.ip = PROGRAM_GATE;
          } else this.status = Status.ERR_INVALID;
          return 'continue';
        }
        this.dataStack.push(...args);
        this.callStack.push(next);
        jump(a[0]);
        return 'continue';
      }
      case 'RET': {
        const r = this.callStack.pop();
        if (r === undefined) {
          if (!this.isProgram) return stackFault('Call stack underflow (RET)');
          // M14: RET from the program's top level returns to the firmware with r0.
          this.ip = next;
          host.end?.(this.regs[0]);
          return 'continue';
        }
        next = r;
        break;
      }
      case 'WAIT': {
        // M14: sleep until the port reads 0, checked again at the start of every tick (the
        // host wakes the CPU; this instruction then runs again and finds 0).
        const port = (a[0] as { name: string }).name;
        if (i32(host.readPort(port)) !== 0) {
          this.block();
          return 'endTick';
        }
        const r = host.waitResult?.(port);
        if (r !== undefined) this.status = r as Status;
        break;
      }
      case 'LOG':
        host.log?.((a[0] as { v: number }).v, a.length > 1 ? val(a[1]) : null);
        break;
      case 'BRK':
        this.ip = next;
        this.halt();
        return 'endTick';
      case 'END':
        this.ip = next;
        host.end?.(a.length ? val(a[0]) : 0);
        return 'continue';
      case 'LDB': {
        const at = addrOf(a[1]);
        const b = host.load?.(at);
        if (b === undefined) {
          this.fault(`No memory at ${hex(at)} (LDB)`, watchdogTicks);
          return 'endTick';
        }
        put(a[0], b);
        break;
      }
      case 'STB': {
        const at = addrOf(a[0]);
        const why = host.store ? host.store(at, val(a[1])) : 'no memory';
        if (why) {
          this.fault(`${why} at ${hex(at)} (STB)`, watchdogTicks);
          return 'endTick';
        }
        break;
      }
      case 'LDF': {
        // Flash of this slot (instructions, then the DATA section), or the ROM at 0xF000+.
        const at = addrOf(a[1]);
        const romFlash = romProgram().code;
        if (at >= ROM_BASE && at < ROM_BASE + romFlash.length) {
          put(a[0], romFlash[at - ROM_BASE]);
          break;
        }
        if (at < 0 || at >= own.code.length) {
          this.fault(`No Flash at ${hex(at)} (LDF: this slot has ${own.code.length} B)`, watchdogTicks);
          return 'endTick';
        }
        put(a[0], own.code[at]);
        break;
      }
      default:
        throw new Error(`Unhandled op ${ins.op satisfies never}`);
    }
    this.ip = next;
    return 'continue';
  }
}
