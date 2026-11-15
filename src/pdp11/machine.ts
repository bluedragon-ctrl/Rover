/**
 * A minimal PDP-11 system around the CPU: RAM, a DL11 console terminal and a KW11-L line
 * clock, at their real DEC addresses and vectors. Used by the tests and the standalone
 * simulator page; any project can use it as a starting point for its own bus.
 *
 * Time is cycles: the line clock ticks every `clockCycles` CPU cycles, so a run is
 * deterministic (no wall-clock time).
 */

import { BUS_ERROR, Cpu, type Bus, type CpuOptions, type RunResult } from './cpu';
import type { AssembleResult } from './assembler';

/** DL11 console and KW11-L clock registers (octal addresses, as on every PDP-11). */
export const DEV = {
  RCSR: 0o177560, RBUF: 0o177562, XCSR: 0o177564, XBUF: 0o177566,
  LKS: 0o177546,
  /** Console receiver / transmitter / clock interrupt vectors. */
  VEC_RX: 0o060, VEC_TX: 0o064, VEC_CLOCK: 0o100,
} as const;

/** CSR bits shared by DEC devices. */
export const CSR = { DONE: 0o200, IE: 0o100 } as const;

export interface MachineOptions extends CpuOptions {
  /** Installed RAM in bytes from address 0 (default 56 KB: 000000–157777). */
  memory?: number;
  /** CPU cycles per line-clock tick (default 1000). */
  clockCycles?: number;
}

export class SimpleMachine implements Bus {
  readonly cpu: Cpu;
  readonly ram: Uint8Array;
  readonly clockCycles: number;
  /** Everything written to the console (XBUF). */
  output = '';
  /** Characters typed but not yet read by the program. */
  input: number[] = [];
  /** Total cycles and instructions since the last boot. */
  cycles = 0;
  instructions = 0;
  /** Called with each character the program prints. */
  onOutput: ((ch: string) => void) | null = null;

  private rcsr = 0;
  private rbuf = 0;
  private xcsr: number = CSR.DONE;
  private lks: number = CSR.DONE;
  private untilTick: number;

  constructor(opts: MachineOptions = {}) {
    this.ram = new Uint8Array(opts.memory ?? 0o160000);
    this.clockCycles = opts.clockCycles ?? 1000;
    this.untilTick = this.clockCycles;
    this.cpu = new Cpu(this, opts);
  }

  // ---------------------------------------------------------------- Bus

  read(addr: number, byte: boolean): number {
    if (addr < this.ram.length) {
      return byte ? this.ram[addr] : this.ram[addr] | (this.ram[addr + 1] << 8);
    }
    const reg = addr & 0xfffe;
    let v: number;
    switch (reg) {
      case DEV.RCSR: v = this.rcsr; break;
      case DEV.RBUF:
        v = this.rbuf;
        this.rcsr &= ~CSR.DONE;
        this.feed();
        break;
      case DEV.XCSR: v = this.xcsr; break;
      case DEV.XBUF: v = 0; break;
      case DEV.LKS: v = this.lks; break;
      default: return BUS_ERROR;
    }
    return byte ? (addr & 1 ? v >> 8 : v & 0xff) : v;
  }

  write(addr: number, value: number, byte: boolean): boolean {
    if (addr < this.ram.length) {
      this.ram[addr] = value & 0xff;
      if (!byte) this.ram[addr + 1] = (value >> 8) & 0xff;
      return true;
    }
    const reg = addr & 0xfffe;
    if (byte && (addr & 1)) value = 0; // writes to the high byte of these registers do nothing
    switch (reg) {
      case DEV.RCSR:
        this.rcsr = (this.rcsr & ~CSR.IE) | (value & CSR.IE);
        if ((this.rcsr & CSR.IE) && (this.rcsr & CSR.DONE)) this.cpu.interrupt(DEV.VEC_RX, 4);
        return true;
      case DEV.RBUF: return true;
      case DEV.XCSR:
        this.xcsr = (this.xcsr & ~CSR.IE) | (value & CSR.IE);
        if (this.xcsr & CSR.IE) this.cpu.interrupt(DEV.VEC_TX, 4);
        else this.cpu.cancelInterrupt(DEV.VEC_TX);
        return true;
      case DEV.XBUF: {
        const ch = String.fromCharCode(value & 0x7f);
        this.output += ch;
        this.onOutput?.(ch);
        // The character is sent at once: ready again, and an interrupt if enabled.
        if (this.xcsr & CSR.IE) this.cpu.interrupt(DEV.VEC_TX, 4);
        return true;
      }
      case DEV.LKS:
        this.lks = (this.lks & ~CSR.IE) | (value & CSR.IE);
        if (!(value & CSR.DONE)) this.lks &= ~CSR.DONE;
        if (!(this.lks & CSR.IE)) this.cpu.cancelInterrupt(DEV.VEC_CLOCK);
        return true;
      default: return false;
    }
  }

  reset(): void {
    this.rcsr &= CSR.DONE;
    this.xcsr = CSR.DONE;
    this.lks = CSR.DONE;
    for (const v of [DEV.VEC_RX, DEV.VEC_TX, DEV.VEC_CLOCK]) this.cpu.cancelInterrupt(v);
  }

  // ---------------------------------------------------------------- host side

  /** Clear memory and devices, load an assembled program, PC = its start, SP below it. */
  boot(asm: Pick<AssembleResult, 'origin' | 'bytes' | 'start'>): void {
    this.ram.fill(0);
    this.cpu.reset();
    this.reset();
    this.rcsr = 0;
    this.input = [];
    this.output = '';
    this.cycles = 0;
    this.instructions = 0;
    this.untilTick = this.clockCycles;
    this.ram.set(asm.bytes.subarray(0, Math.max(0, this.ram.length - asm.origin)), asm.origin);
    this.cpu.r[7] = asm.start;
    this.cpu.r[6] = asm.origin >= 0o400 ? asm.origin & 0xfffe : 0o1000;
  }

  /** Type a character on the console keyboard. */
  type(ch: string | number): void {
    this.input.push(typeof ch === 'number' ? ch & 0xff : ch.charCodeAt(0) & 0xff);
    this.feed();
  }

  private feed(): void {
    if (this.rcsr & CSR.DONE || this.input.length === 0) return;
    this.rbuf = this.input.shift()!;
    this.rcsr |= CSR.DONE;
    if (this.rcsr & CSR.IE) this.cpu.interrupt(DEV.VEC_RX, 4);
  }

  /**
   * Run up to `maxCycles`, ticking the line clock on the way. A sleeping CPU (`WAIT`)
   * skips ahead to the next clock tick if the clock interrupt is enabled.
   */
  run(maxCycles: number, breakpoints?: ReadonlySet<number>): RunResult {
    let used = 0;
    let instructions = 0;
    let first = true;
    while (true) {
      const slice = Math.min(maxCycles - used, this.untilTick);
      if (slice <= 0 && !first) return { reason: 'budget', cycles: used, instructions };
      const r = this.cpu.run(Math.max(slice, 0), breakpoints, first);
      first = false;
      let spent = r.cycles;
      instructions += r.instructions;
      this.instructions += r.instructions;
      if (r.reason === 'wait') {
        if (!(this.lks & CSR.IE) && !(this.rcsr & CSR.IE)) {
          this.advance(spent);
          return { ...r, cycles: used + spent, instructions };
        }
        // Asleep: time passes until the next tick (or the budget).
        spent = Math.max(spent, Math.min(this.untilTick, maxCycles - used));
      }
      this.advance(spent);
      used += spent;
      if (r.reason !== 'budget' && r.reason !== 'wait') return { ...r, cycles: used, instructions };
      if (used >= maxCycles) return { reason: r.reason, cycles: used, instructions };
    }
  }

  /** One instruction (or the interrupt waiting to be taken), with the clock kept in step. */
  step(): RunResult {
    const r = this.cpu.step();
    this.instructions += r.instructions;
    this.advance(r.cycles);
    return r;
  }

  private advance(cycles: number): void {
    this.cycles += cycles;
    this.untilTick -= cycles;
    while (this.untilTick <= 0) {
      this.untilTick += this.clockCycles;
      this.lks |= CSR.DONE;
      if (this.lks & CSR.IE) this.cpu.interrupt(DEV.VEC_CLOCK, 6);
    }
  }
}
