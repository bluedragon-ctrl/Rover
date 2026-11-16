import { describe, expect, it } from 'vitest';
import { PDP11 } from '../src/core/balance';
import { ProgState } from '../src/core/types';
import { factory, HANG, reg, rover as base, run, sleep } from './helpers/rover';
import type { SimulationEngine } from '../src/core/SimulationEngine';
import type { Unit } from '../src/core/Unit';

function rover(firmware: string, program?: string): { e: SimulationEngine; u: Unit } {
  return base(firmware, { setup: (e, u) => {
    if (program !== undefined) expect(e.uploadProgram(u, program, factory).errors).toEqual([]);
  } });
}

function until(e: SimulationEngine, cond: () => boolean, max = 2000): number {
  for (let i = 0; i < max; i++) {
    if (cond()) return i;
    run(e, 1, true);
  }
  throw new Error('condition never held');
}

/** Firmware: R5 = 5, then run the program in slices of `ticks`. */
const runLoop = (ticks: number) => `START:  MOV  #5, R5\n1$:     MOV  #${ticks}., R0\n        JSR  PC, RUN\n        WAIT\n        BR   1$`;

describe('uploads and commands (SPEC §3.9.3)', () => {
  it('a program upload is cheaper, does not reboot and replaces a running program', () => {
    const { e, u } = rover(runLoop(50), `START:\n1$:     ${sleep(30)}\n        BR   1$`);
    until(e, () => u.slice > 0, 20);
    const before = u.energy;
    const res = e.uploadProgram(u, 'START:  MOV  #3, R1\n        MOV  #9., R0\n        HALT');
    expect(res.rejected).toBeUndefined();
    expect(res.cost).toBe(e.programUploadCost(u, res.bytes));
    expect(res.cost).toBeLessThan(e.uploadCost(u, res.bytes));
    expect(u.energy).toBe(before - res.cost);
    expect(reg(u, 5)).toBe(5); // no reboot
    until(e, () => u.progState === ProgState.PROG_DONE);
    expect(u.progResult).toBe(9);
    expect(u.machine.registers('program').r[1]).toBe(3);
  });

  it('an empty program erases it; Run again then has nothing to run', () => {
    const { e, u } = rover(runLoop(5), 'START:  HALT');
    e.uploadProgram(u, '; nothing', factory);
    expect(u.progState).toBe(ProgState.PROG_NONE);
    expect(u.programBytes).toBe(0);
    expect(e.command(u, 'RUN_AGAIN')).toMatch(/no program/);
  });

  it('rejects code that does not fit its region of core, naming the limit', () => {
    const { e, u } = rover(`START:${HANG}`);
    const big = (n: number) => `START:  .BLKW ${n}.\n        HALT`;
    const fw = e.upload(u, big((PDP11.programBase - PDP11.firmwareBase) / 2), factory);
    expect(fw.assembled.image).toBeNull();
    expect(fw.errors[0].message).toMatch(/firmware ends at .*: it must end below 002000/);
    const prog = e.uploadProgram(u, big((PDP11.coreBytes - PDP11.programBase) / 2), factory);
    expect(prog.errors[0].message).toMatch(/program ends at/);
    expect(u.programBytes).toBe(0);
  });

  it('a rejected upload changes nothing and is recorded as not sent', () => {
    const { e, u } = rover(`START:${HANG}`);
    u.energy = 1;
    const src = u.sourceCode;
    const res = e.upload(u, 'START:  BR   START');
    expect(res.rejected).toMatch(/battery/);
    expect(u.sourceCode).toBe(src);
    expect(e.sent.at(-1)).toMatchObject({ kind: 'FIRMWARE', rejected: res.rejected });
  });
});
