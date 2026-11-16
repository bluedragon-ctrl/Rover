/**
 * A minimal system around the CPU: RAM, a DL11 console terminal and a KW11-L line
 * clock, at their real DEC addresses and vectors. Used by the tests and the standalone
 * simulator page; a project with its own peripherals builds on {@link DeviceMachine}
 * (`devices.ts`) the same way.
 *
 * Time is cycles: the line clock ticks every `clockCycles` CPU cycles, so a run is
 * deterministic (no wall-clock time).
 */

import { CSR, DeviceMachine, DL11, KW11L, type DeviceMachineOptions } from './devices';

export { CSR };

/** DL11 console and KW11-L clock registers (octal addresses, as on the original machines). */
export const DEV = {
  RCSR: 0o177560, RBUF: 0o177562, XCSR: 0o177564, XBUF: 0o177566,
  LKS: 0o177546,
  /** Console receiver / transmitter / clock interrupt vectors. */
  VEC_RX: 0o060, VEC_TX: 0o064, VEC_CLOCK: 0o100,
} as const;

export interface MachineOptions extends DeviceMachineOptions {
  /** CPU cycles per line-clock tick (default 1000). */
  clockCycles?: number;
}

export class SimpleMachine extends DeviceMachine {
  readonly clockCycles: number;
  readonly console: DL11;
  readonly clock: KW11L;

  constructor(opts: MachineOptions = {}) {
    super(opts);
    this.clockCycles = opts.clockCycles ?? 1000;
    this.console = new DL11();
    this.clock = new KW11L(this.clockCycles);
    this.add(this.console).add(this.clock);
  }

  /** Everything written to the console (XBUF). */
  get output(): string { return this.console.output; }
  /** Characters typed but not yet read by the program. */
  get input(): number[] { return this.console.input; }
  /** Called with each character the program prints. */
  get onOutput(): ((ch: string) => void) | null { return this.console.onOutput; }
  set onOutput(f: ((ch: string) => void) | null) { this.console.onOutput = f; }

  /** Type a character on the console keyboard. */
  type(ch: string | number): void { this.console.type(ch); }
}
