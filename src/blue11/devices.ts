/**
 * Memory-mapped devices on the Blue-11 bus, and a machine that hosts them: RAM from address
 * 0, devices in the I/O page, the CPU, and time counted in CPU cycles (deterministic: no
 * wall-clock time). A project adds its own peripherals as {@link Device}s instead of
 * writing its own address decoding; {@link DL11} and {@link KW11L} are DEC's console and
 * line clock, as examples and for reuse.
 *
 * Bus rules follow the Unibus: the CPU reads whole words (a byte read takes half of one,
 * with the same side effects), and writes words or bytes (DATO / DATOB). A device decides
 * itself what a byte write to its odd (high) byte does.
 */

import { BUS_ERROR, Cpu, PSW_ADDRESS, type Bus, type CpuOptions, type RunResult } from './cpu';
import type { AssembleResult } from './assembler';

export interface Device {
  /** First bus address (even). */
  readonly base: number;
  /** Size in bytes (even). */
  readonly size: number;
  /** Called once when added, with the CPU (to request interrupts). */
  attach?(cpu: Cpu): void;
  /** The word at an even `offset` from `base`, or {@link BUS_ERROR} for a hole. */
  read(offset: number): number;
  /**
   * A word, or a byte when `byte` (an odd `offset` is the high byte; `value` is then the
   * byte itself, 0–255). False: nothing answers (bus error).
   */
  write(offset: number, value: number, byte: boolean): boolean;
  /** `RESET` instruction (`powerUp` false), or power-up / boot (`powerUp` true). */
  reset?(powerUp: boolean): void;
  /** Time passed, in CPU cycles. */
  advance?(cycles: number): void;
  /**
   * Cycles until the device changes by itself (a flag set, an interrupt requested), or
   * Infinity. The machine stops the CPU there, so programs that poll see it on time.
   */
  nextEvent?(): number;
  /**
   * While the CPU is in `WAIT`: cycles until this device interrupts by itself (Infinity if
   * it won't), and whether it could interrupt at all (interrupts enabled, perhaps waiting
   * for host input). A sleeping CPU nobody can wake stops the run at once.
   */
  wakeIn?(): number;
  canWake?(): boolean;
}

export interface DeviceMachineOptions extends CpuOptions {
  /** Installed RAM in bytes from address 0 (default 56 KB: 000000–157777). */
  memory?: number;
}

export class DeviceMachine implements Bus {
  readonly cpu: Cpu;
  readonly ram: Uint8Array;
  /** Total cycles and instructions since the last boot. */
  cycles = 0;
  instructions = 0;

  private readonly devices: Device[] = [];
  /** Device index + 1 for each word address (0: none). */
  private readonly slots = new Uint8Array(0x8000);

  constructor(opts: DeviceMachineOptions = {}) {
    this.ram = new Uint8Array(opts.memory ?? 0o160000);
    this.cpu = new Cpu(this, opts);
  }

  /** Plug a device in. Throws if it overlaps RAM, the PSW or another device. */
  add(dev: Device): this {
    const { base, size } = dev;
    const at = `device at ${base.toString(8)}`;
    if (base & 1 || size & 1 || size <= 0) throw new Error(`${at}: base and size must be even, size > 0`);
    if (base < this.ram.length) throw new Error(`${at}: overlaps RAM`);
    if (base + size > 0x10000) throw new Error(`${at}: runs past 177777`);
    if (base <= PSW_ADDRESS && PSW_ADDRESS < base + size) throw new Error(`${at}: 177776 is the CPU's PSW`);
    if (this.devices.length >= 255) throw new Error('at most 255 devices');
    for (let a = base; a < base + size; a += 2) {
      if (this.slots[a >> 1]) throw new Error(`${at}: overlaps another device at ${a.toString(8)}`);
    }
    this.devices.push(dev);
    this.slots.fill(this.devices.length, base >> 1, (base + size) >> 1);
    dev.attach?.(this.cpu);
    return this;
  }

  // ---------------------------------------------------------------- Bus

  read(addr: number, byte: boolean): number {
    if (addr < this.ram.length) {
      if (byte) return this.ram[addr];
      // The CPU traps odd word addresses itself; a host reading one gets the even word.
      const a = addr & 0xfffe;
      return this.ram[a] | ((this.ram[a + 1] ?? 0) << 8);
    }
    const i = this.slots[addr >> 1];
    if (!i) return BUS_ERROR;
    const dev = this.devices[i - 1];
    const w = dev.read((addr & 0xfffe) - dev.base);
    if (w < 0 || !byte) return w;
    return addr & 1 ? (w >> 8) & 0xff : w & 0xff;
  }

  write(addr: number, value: number, byte: boolean): boolean {
    if (addr < this.ram.length) {
      if (byte) { this.ram[addr] = value & 0xff; return true; }
      const a = addr & 0xfffe;
      this.ram[a] = value & 0xff;
      if (a + 1 < this.ram.length) this.ram[a + 1] = (value >> 8) & 0xff;
      return true;
    }
    const i = this.slots[addr >> 1];
    if (!i) return false;
    const dev = this.devices[i - 1];
    return byte ? dev.write(addr - dev.base, value & 0xff, true) : dev.write((addr & 0xfffe) - dev.base, value & 0xffff, false);
  }

  /** The `RESET` instruction. */
  reset(): void {
    for (const d of this.devices) d.reset?.(false);
  }

  // ---------------------------------------------------------------- host side

  /** Clear memory, power the devices up, load an assembled program, PC = its start, SP below it. */
  boot(asm: Pick<AssembleResult, 'origin' | 'bytes' | 'start'>): void {
    this.ram.fill(0);
    this.cpu.reset();
    for (const d of this.devices) d.reset?.(true);
    this.cycles = 0;
    this.instructions = 0;
    this.ram.set(asm.bytes.subarray(0, Math.max(0, this.ram.length - asm.origin)), asm.origin);
    this.cpu.r[7] = asm.start;
    this.cpu.r[6] = asm.origin >= 0o400 ? asm.origin & 0xfffe : 0o1000;
  }

  /**
   * Run up to `maxCycles`, keeping the devices in step. A sleeping CPU (`WAIT`) skips
   * ahead to the next device event, or stops at once if no device can wake it.
   */
  run(maxCycles: number, breakpoints?: ReadonlySet<number>): RunResult {
    let used = 0;
    let instructions = 0;
    let first = true;
    while (true) {
      const slice = Math.min(maxCycles - used, this.soonest('nextEvent'));
      if (slice <= 0 && !first) return { reason: 'budget', cycles: used, instructions };
      const r = this.cpu.run(Math.max(slice, 0), breakpoints, first);
      first = false;
      let spent = r.cycles;
      instructions += r.instructions;
      this.instructions += r.instructions;
      if (r.reason === 'wait') {
        if (!this.devices.some((d) => d.canWake?.())) {
          this.advance(spent);
          return { ...r, cycles: used + spent, instructions };
        }
        // Asleep: time passes until a device interrupts by itself, or the budget ends.
        spent = Math.max(spent, Math.min(this.soonest('wakeIn'), maxCycles - used));
      }
      this.advance(spent);
      used += spent;
      if (r.reason !== 'budget' && r.reason !== 'wait') return { ...r, cycles: used, instructions };
      if (used >= maxCycles) return { reason: r.reason, cycles: used, instructions };
    }
  }

  /** One instruction (or the interrupt waiting to be taken), with the devices kept in step. */
  step(): RunResult {
    const r = this.cpu.step();
    this.instructions += r.instructions;
    this.advance(r.cycles);
    return r;
  }

  private advance(cycles: number): void {
    this.cycles += cycles;
    if (cycles > 0) for (const d of this.devices) d.advance?.(cycles);
  }

  private soonest(what: 'nextEvent' | 'wakeIn'): number {
    let t = Infinity;
    for (const d of this.devices) {
      const f = d[what];
      if (f) t = Math.min(t, f.call(d));
    }
    return t;
  }
}

// -------------------------------------------------------------------- DEC devices

/** CSR bits shared by DEC devices. */
export const CSR = { DONE: 0o200, IE: 0o100 } as const;

export interface DL11Options {
  /** Default 177560 (the console). */
  base?: number;
  /** Receiver vector (transmitter: +4). Default 060. */
  vector?: number;
  /** Bus request level. Default 4. */
  level?: number;
}

/**
 * DL11 serial line: RCSR, RBUF, XCSR, XBUF. Characters typed by the host wait in
 * `input`; characters the program sends are appended to `output` at once (the line is
 * infinitely fast, so the transmitter is always ready).
 */
export class DL11 implements Device {
  readonly base: number;
  readonly size = 8;
  readonly vector: number;
  readonly level: number;
  /** Everything the program sent. */
  output = '';
  /** Characters typed but not yet read by the program. */
  input: number[] = [];
  /** Called with each character the program sends. */
  onOutput: ((ch: string) => void) | null = null;

  private cpu!: Cpu;
  private rcsr = 0;
  private rbuf = 0;
  private xcsr: number = CSR.DONE;

  constructor(opts: DL11Options = {}) {
    this.base = opts.base ?? 0o177560;
    this.vector = opts.vector ?? 0o060;
    this.level = opts.level ?? 4;
  }

  attach(cpu: Cpu): void { this.cpu = cpu; }

  /** Type a character on the line. */
  type(ch: string | number): void {
    this.input.push(typeof ch === 'number' ? ch & 0xff : ch.charCodeAt(0) & 0xff);
    this.feed();
  }

  read(offset: number): number {
    switch (offset) {
      case 0: return this.rcsr;
      case 2: {
        const v = this.rbuf;
        this.rcsr &= ~CSR.DONE;
        this.feed();
        return v;
      }
      case 4: return this.xcsr;
      default: return 0; // XBUF reads as 0
    }
  }

  write(offset: number, value: number, byte: boolean): boolean {
    if (byte && offset & 1) return true; // the high bytes take no writes
    switch (offset) {
      case 0:
        this.rcsr = (this.rcsr & ~CSR.IE) | (value & CSR.IE);
        if ((this.rcsr & CSR.IE) && (this.rcsr & CSR.DONE)) this.cpu.interrupt(this.vector, this.level);
        return true;
      case 2: return true;
      case 4:
        this.xcsr = (this.xcsr & ~CSR.IE) | (value & CSR.IE);
        if (this.xcsr & CSR.IE) this.cpu.interrupt(this.vector + 4, this.level);
        else this.cpu.cancelInterrupt(this.vector + 4);
        return true;
      default: {
        const ch = String.fromCharCode(value & 0x7f);
        this.output += ch;
        this.onOutput?.(ch);
        // The character is sent at once: ready again, and an interrupt if enabled.
        if (this.xcsr & CSR.IE) this.cpu.interrupt(this.vector + 4, this.level);
        return true;
      }
    }
  }

  reset(powerUp: boolean): void {
    this.rcsr = powerUp ? 0 : this.rcsr & CSR.DONE;
    this.xcsr = CSR.DONE;
    if (powerUp) { this.input = []; this.output = ''; }
    this.cpu.cancelInterrupt(this.vector);
    this.cpu.cancelInterrupt(this.vector + 4);
  }

  canWake(): boolean { return (this.rcsr & CSR.IE) !== 0; }

  private feed(): void {
    if (this.rcsr & CSR.DONE || this.input.length === 0) return;
    this.rbuf = this.input.shift()!;
    this.rcsr |= CSR.DONE;
    if (this.rcsr & CSR.IE) this.cpu.interrupt(this.vector, this.level);
  }
}

/** KW11-L line clock at 177546, vector 100, level 6: ticks every `cycles` CPU cycles. */
export class KW11L implements Device {
  readonly base = 0o177546;
  readonly size = 2;
  static readonly VECTOR = 0o100;

  private cpu!: Cpu;
  private lks: number = CSR.DONE;
  private untilTick: number;

  constructor(readonly cycles = 1000) {
    if (!(cycles >= 1)) throw new Error('KW11L: cycles per tick must be at least 1');
    this.untilTick = cycles;
  }

  attach(cpu: Cpu): void { this.cpu = cpu; }

  read(): number { return this.lks; }

  write(offset: number, value: number, byte: boolean): boolean {
    if (byte && offset & 1) return true; // the high byte takes no writes
    this.lks = (this.lks & ~CSR.IE) | (value & CSR.IE);
    if (!(value & CSR.DONE)) this.lks &= ~CSR.DONE;
    if (!(this.lks & CSR.IE)) this.cpu.cancelInterrupt(KW11L.VECTOR);
    return true;
  }

  reset(powerUp: boolean): void {
    this.lks = CSR.DONE;
    if (powerUp) this.untilTick = this.cycles;
    this.cpu.cancelInterrupt(KW11L.VECTOR);
  }

  advance(cycles: number): void {
    this.untilTick -= cycles;
    if (this.untilTick > 0) return;
    this.untilTick += (Math.floor(-this.untilTick / this.cycles) + 1) * this.cycles; // ticks missed while asleep count once
    this.lks |= CSR.DONE;
    if (this.lks & CSR.IE) this.cpu.interrupt(KW11L.VECTOR, 6);
  }

  nextEvent(): number { return this.untilTick; }
  wakeIn(): number { return this.lks & CSR.IE ? this.untilTick : Infinity; }
  canWake(): boolean { return (this.lks & CSR.IE) !== 0; }
}
