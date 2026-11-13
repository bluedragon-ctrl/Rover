import type { ChassisDef } from '../balance';
import { CpuState, Status, i32 } from '../types';
import { HARDWARE_OPS, type Instr, type Operand, type Program } from './Compiler';

/** What the VM needs from the outside world. Implemented by SimulationEngine. */
export interface VmHost {
  readPort(name: string): number;
  writePort(name: string, value: number): void;
  /**
   * Start a hardware instruction. `values` are the resolved value operands.
   * Return output values (written to the instruction's destination operands, in order).
   * The host decides whether the CPU becomes BLOCKED (via vm.block()).
   */
  hardware(instr: Instr, values: number[]): number[] | void;
  /** LOG: queue a log frame (compute instruction, no @STATUS). */
  log?(tag: number, value: number | null): void;
  /** END (program slot, M10): the program finished with `value`. */
  end?(value: number): void;
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
  /** Source line of the instruction executed most recently (for the debugger). */
  lastLine = 0;
  instructionsExecuted = 0;

  constructor(readonly chassis: ChassisDef) {
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

  /** Byte address of the instruction that will run next (after wrap-around). */
  get nextIp(): number {
    const n = this.program?.code.length ?? 0;
    return n === 0 || this.ip >= n || this.ip < 0 ? 0 : this.ip;
  }

  /** Source line of the instruction at byte address `addr` (0 if none starts there). */
  lineAt(addr: number): number {
    const p = this.program;
    const k = p?.indexAt.get(addr);
    return k === undefined ? 0 : p!.instrs[k].line;
  }

  get nextLine(): number {
    return this.lineAt(this.nextIp);
  }

  /** Execute exactly one instruction. Caller guarantees state === RUNNING. */
  step(host: VmHost, watchdogTicks: number): StepResult {
    const prog = this.program;
    if (!prog || prog.instrs.length === 0) return 'endTick';
    if (this.ip >= prog.code.length || this.ip < 0) this.ip = 0; // implicit main loop
    const k = prog.indexAt.get(this.ip);
    if (k === undefined) {
      // Only reachable through a corrupted return address: no instruction starts here.
      this.fault(`No instruction at address 0x${this.ip.toString(16)}`, watchdogTicks);
      return 'endTick';
    }
    const ins = prog.instrs[k];
    this.lastLine = ins.line;
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
      }
    };
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
        this.dataStack.push(...args);
        this.callStack.push(next);
        jump(a[0]);
        return 'continue';
      }
      case 'RET': {
        const r = this.callStack.pop();
        if (r === undefined) return stackFault('Call stack underflow (RET)');
        next = r;
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
        return 'endTick';
      case 'PEEK': {
        // Cargo is [later]; route through host so it can implement it without VM changes.
        const out = host.hardware(ins, [val(a[0])]) ?? [];
        put(a[1], out[0] ?? 0);
        break;
      }
      default: {
        if (!HARDWARE_OPS.has(ins.op)) throw new Error(`Unhandled op ${ins.op}`);
        const values: number[] = [];
        const dests: Operand[] = [];
        if (ins.op === 'SCAN') {
          values.push(val(a[0]));
          dests.push(a[1], a[2]);
        } else for (const o of a) values.push(val(o));
        this.ip = next;
        const out = host.hardware(ins, values) ?? [];
        dests.forEach((d, i) => put(d, out[i] ?? 0));
        return 'endTick';
      }
    }
    this.ip = next;
    return 'continue';
  }
}
