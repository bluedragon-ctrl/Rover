/**
 * Hosting the CPU in your own machine: a complete, tested example (README "Host your own
 * machine"). It shows the four things every host decides for itself:
 *
 * 1. the **bus**: what answers at which address (RAM, a device register, nothing);
 * 2. **time**: how many cycles the CPU gets per host step ("frame");
 * 3. **interrupts**: when a device requests one (here a frame clock at vector 100);
 * 4. **traps the host serves itself**: `TRAP n` as a system call, without any handler in
 *    the machine's memory (`onTrap` returns 'stop').
 */

import { assemble, BUS_ERROR, Cpu, type AssembleResult, type Bus } from '../src';

/** A lamp the program can write (a 16-bit register) and a frame counter it can read. */
export const LAMP = 0o170000;
export const FRAMES = 0o170002;
/** The frame clock's interrupt vector and level. */
export const CLOCK_VECTOR = 0o100;
export const CLOCK_LEVEL = 6;

export class TinyHost implements Bus {
  /** 4 KB of RAM from address 0. */
  readonly ram = new Uint8Array(0o10000);
  readonly cpu: Cpu;
  lamp = 0;
  frames = 0;
  /** What the program asked the host to print with `TRAP 1` (R0 each time). */
  printed: number[] = [];

  constructor() {
    this.cpu = new Cpu(this, { cycles: 'per-bus-access' });
    // TRAP n is served by the host; every other trap goes through its vector as usual.
    this.cpu.onTrap = (t) => (t.cause === 'trap' ? 'stop' : 'vector');
  }

  // ------------------------------------------------------------ 1. the bus

  read(addr: number, byte: boolean): number {
    if (addr < this.ram.length) return byte ? this.ram[addr] : this.ram[addr] | (this.ram[addr + 1] << 8);
    if (addr === LAMP) return this.lamp;
    if (addr === FRAMES) return this.frames & 0xffff;
    return BUS_ERROR; // nothing here: the CPU traps to 4
  }

  write(addr: number, value: number, byte: boolean): boolean {
    if (addr < this.ram.length) {
      this.ram[addr] = value & 0xff;
      if (!byte) this.ram[addr + 1] = (value >> 8) & 0xff;
      return true;
    }
    if (addr === LAMP) {
      this.lamp = value & 0xffff;
      return true;
    }
    return false; // read-only or nothing there: bus error
  }

  // ------------------------------------------------------------ loading

  /** Assemble with the host's register names predefined, copy into RAM, set PC and SP. */
  load(source: string): AssembleResult {
    const asm = assemble(source, { origin: 0o1000, symbols: { LAMP, FRAMES } });
    if (!asm.ok) return asm;
    this.ram.fill(0);
    this.ram.set(asm.bytes, asm.origin);
    this.cpu.reset();
    this.cpu.r[7] = asm.start;
    this.cpu.r[6] = 0o1000; // the stack grows down from the program
    return asm;
  }

  // ------------------------------------------------------------ 2.–4. time, interrupts, traps

  /**
   * One host frame: the CPU runs up to `cycles`, then the frame clock ticks and requests its
   * interrupt, which is taken at the start of the next frame. (Requesting it before the
   * program has set its vector would send the CPU through vector 100 while it still holds 0.)
   */
  frame(cycles: number): void {
    let left = cycles;
    while (left > 0 && !this.cpu.halted) {
      const r = this.cpu.run(left);
      left -= r.cycles;
      if (r.reason === 'trap' && r.trap?.cause === 'trap') {
        // A system call: the number is in trap.detail, the PC already after the TRAP.
        if (r.trap.detail === 1) this.printed.push(this.cpu.r[0]);
        continue;
      }
      break; // 'wait' (asleep until the next frame), 'halt', 'budget', ...
    }
    this.frames++;
    this.cpu.interrupt(CLOCK_VECTOR, CLOCK_LEVEL);
  }
}

/** The program used by the README and the test: count frames on the lamp, print every 4th. */
export const HOST_PROGRAM = `
START:  MOV  #CLOCK, @#100      ; the clock vector: handler...
        MOV  #300, @#102        ; ...and its PSW (priority 6)
        CLR  R1
LOOP:   WAIT                    ; sleep until the host's next frame
        INC  R1
        MOV  R1, @#LAMP         ; show the count
        BIT  #3, R1             ; every 4th frame...
        BNE  LOOP
        MOV  R1, R0
        TRAP 1                  ; ...ask the host to print R0
        CMP  R1, #20
        BLO  LOOP
        HALT
CLOCK:  RTI                     ; the interrupt only wakes the WAIT
`;
