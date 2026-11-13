import { describe, expect, it } from 'vitest';
import { BALANCE, CHASSIS_MK1 } from '../src/core/balance';
import { decodeDump, decodeFrame } from '../src/core/downlink';
import { DEFAULT_FIRMWARE, PROGRAM_TEMPLATES } from '../src/core/programs';
import { deserialize, migrate, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, ProgState, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { compile } from '../src/core/vm/Compiler';
import { createDefaultRegistry } from '../src/core/WorldRegistry';

const factory = { factory: true };
const consts = createDefaultRegistry().constants();

/** Keep the dish on the orbiter (signal = antennaHealth) before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

/** A rover with `firmware`, optionally a program, not ticked yet. */
function rover(firmware: string, program?: string, seed = 7): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  expect(e.upload(u, firmware, factory).errors).toEqual([]);
  if (program !== undefined) expect(e.uploadProgram(u, program, factory).errors).toEqual([]);
  return { e, u };
}

/** Run until `cond` holds (at most `max` ticks); returns the ticks it took. */
function until(e: SimulationEngine, cond: () => boolean, max = 2000): number {
  for (let i = 0; i < max; i++) {
    if (cond()) return i;
    run(e, 1);
  }
  throw new Error('condition never held');
}

describe('compiler slots (SPEC §3.9.1)', () => {
  const c = (src: string, slot: 'firmware' | 'program', otherBytes = 0) => compile(src, CHASSIS_MK1, consts, { slot, otherBytes });

  it('RUN and @PROG_STATE writes are firmware-only, END is program-only', () => {
    expect(c('RUN 10', 'firmware').errors).toEqual([]);
    expect(c('RUN 10', 'program').errors[0].message).toMatch(/RUN is a firmware instruction/);
    expect(c('END 3', 'program').errors).toEqual([]);
    expect(c('END', 'program').flashUsed).toBe(1);
    expect(c('END 3', 'firmware').errors[0].message).toMatch(/END is a program instruction/);
    expect(c('MOV @PROG_STATE PROG_NONE', 'firmware').errors).toEqual([]);
    expect(c('MOV @PROG_STATE PROG_NONE', 'program').errors[0].message).toMatch(/Only the firmware/);
    expect(c('MOV r0 @PROG_STATE\nJEQ @PROG_RESULT 1 x\nx: END @PROG_STATE', 'program').errors).toEqual([]);
    expect(c('RUN 50', 'firmware').flashUsed).toBe(3);
  });

  it('firmware and program share the flash; the error names both sizes', () => {
    const src = Array.from({ length: 10 }, () => 'ADD r0 100').join('\n'); // 40 B
    expect(c(src, 'program', 216).errors).toEqual([]);
    expect(c(src, 'program', 217).errors).toEqual([{ line: 10, message: 'Program is 40 bytes + firmware 217 bytes; Rover Mk-I has 256 bytes of Flash' }]);
    expect(c(src, 'firmware', 217).errors[0].message).toBe('Firmware is 40 bytes + program 217 bytes; Rover Mk-I has 256 bytes of Flash');
  });

  it('the default firmware leaves room for every shipped program; comfort blocks state their real cost', () => {
    const fw = c(DEFAULT_FIRMWARE, 'firmware');
    expect(fw.errors).toEqual([]);
    expect(fw.flashUsed).toBeLessThanOrEqual(136);
    for (const [name, src] of Object.entries(PROGRAM_TEMPLATES)) expect(c(src, 'program', fw.flashUsed).errors, name).toEqual([]);
    const lines = DEFAULT_FIRMWARE.split('\n');
    let block: { cost: number; sum: number; title: string } | null = null;
    let blocks = 0;
    lines.forEach((l, i) => {
      const m = /^;--- comfort: (.*) \((\d+) B\) ---$/.exec(l);
      if (m) block = { title: m[1], cost: +m[2], sum: 0 };
      else if (l.startsWith(';--- end')) {
        expect(block, `stray end marker at line ${i + 1}`).not.toBeNull();
        expect(block!.sum, block!.title).toBe(block!.cost);
        block = null;
        blocks++;
      } else if (block) block.sum += fw.lineBytes[i + 1] ?? 0;
    });
    expect(blocks).toBeGreaterThanOrEqual(5);
  });
});

describe('RUN slices (SPEC §3.9.2)', () => {
  it('gives the program whole ticks with separate registers; the firmware resumes after the slice', () => {
    const { e, u } = rover('MOV r0 99\nRUN 3\nMOV r1 @PROG_STATE\nSLEEP 1000', 'loop: ADD r0 1\nJMP loop');
    expect(u.progState).toBe(ProgState.PROG_READY);
    run(e, 1); // firmware: MOV, RUN (ends the tick)
    expect(u.slice).toBe(3);
    expect(u.progState).toBe(ProgState.PROG_RUNNING);
    expect(u.vm.state).toBe(CpuState.BLOCKED);
    run(e, 3); // three program ticks, 4 cycles each: ADD/JMP pairs
    expect(u.prog.regs[0]).toBe(6);
    expect(u.vm.regs[0]).toBe(99);
    run(e, 1); // slice over: firmware runs MOV r1 @PROG_STATE, then SLEEP
    expect(u.slice).toBe(-1);
    expect(u.vm.regs[1]).toBe(ProgState.PROG_READY);
    expect(u.prog.regs[0]).toBe(6);
  });

  it('lets an action started in the slice finish first', () => {
    const { e, u } = rover('RUN 1\nMOV r0 @TICK\nSLEEP 1000', 'SLEEP 10\nMOV r0 1');
    run(e, 1);
    const t0 = e.tick;
    until(e, () => u.vm.regs[0] !== 0);
    expect(u.vm.regs[0] - t0).toBeGreaterThanOrEqual(10);
    expect(u.prog.regs[0]).toBe(0); // the slice ended right after the SLEEP, before MOV
  });

  it('RUN with nothing ready sets ERR_INVALID and the firmware goes on', () => {
    const { e, u } = rover('RUN 5\nMOV r0 @STATUS\nSLEEP 1000');
    expect(u.progState).toBe(ProgState.PROG_NONE);
    run(e, 2);
    expect(u.vm.regs[0]).toBe(Status.ERR_INVALID);
    expect(u.slice).toBe(-1);
  });

  it('each slot has its own @STATUS', () => {
    const { e, u } = rover('DIV r0 0\nRUN 2\nMOV r1 @STATUS\nSLEEP 1000', 'MOV r0 @STATUS\nSLEEP 1\nMOV r1 @STATUS\nSLEEP 1000');
    run(e, 6);
    expect(u.prog.regs[0]).toBe(Status.OK); // the firmware's RUN wrote OK, but to its own @STATUS
    expect(u.vm.regs[1]).toBe(Status.OK);
  });

  it('END reports DONE and the result; RUN does not restart it until the firmware writes PROG_READY', () => {
    const fw = 'loop: RUN 10\nJNE @PROG_STATE PROG_DONE loop\nMOV r0 @PROG_RESULT\nADD r1 1\nJGE r1 2 stop\nMOV @PROG_STATE PROG_READY\nJMP loop\nstop: RUN 10\nMOV r2 @STATUS\nSLEEP 1000';
    const { e, u } = rover(fw, 'ADD r0 1\nEND 7');
    until(e, () => u.vm.regs[2] !== 0);
    expect(u.vm.regs[0]).toBe(7);
    expect(u.vm.regs[1]).toBe(2); // ran twice: the restart gave it a fresh context
    expect(u.prog.regs[0]).toBe(1);
    expect(u.vm.regs[2]).toBe(Status.ERR_INVALID);
    expect(u.progState).toBe(ProgState.PROG_DONE);
  });

  it('PROG_NONE acknowledges: the program stays in flash and Run again restarts it', () => {
    const { e, u } = rover('loop: RUN 5\nJNE @PROG_STATE PROG_DONE loop\nMOV @PROG_STATE PROG_NONE\nJMP loop', 'END 1');
    until(e, () => u.progState === ProgState.PROG_NONE);
    run(e, 20);
    expect(u.progState).toBe(ProgState.PROG_NONE);
    expect(u.progResult).toBe(1);
    expect(e.command(u, 'RUN_AGAIN')).toBeNull();
    expect(u.progState).toBe(ProgState.PROG_READY);
    expect(u.progResult).toBe(0);
    until(e, () => u.progState === ProgState.PROG_NONE);
    expect(u.progResult).toBe(1);
  });

  it('a program fault returns to the firmware without a watchdog reboot', () => {
    const { e, u } = rover('loop: RUN 5\nMOV r0 @PROG_STATE\nJMP loop', 'POP r0');
    run(e, 3);
    expect(u.progState).toBe(ProgState.PROG_FAULT);
    expect(u.vm.regs[0]).toBe(ProgState.PROG_FAULT);
    run(e, BALANCE.watchdogTicks + 10);
    expect(u.vm.state).not.toBe(CpuState.FAULT);
    expect(u.progState).toBe(ProgState.PROG_FAULT); // nobody rebooted it
  });

  it('BRK halts only the program; Continue (program slot) resumes after the BRK', () => {
    const { e, u } = rover('loop: RUN 5\nADD r1 1\nJMP loop', 'MOV r0 1\nBRK\nMOV r0 2\nSLEEP 1000');
    run(e, 3);
    expect(u.progState).toBe(ProgState.PROG_HALTED);
    const r1 = u.vm.regs[1];
    run(e, 5);
    expect(u.vm.regs[1]).toBeGreaterThan(r1); // the firmware keeps running
    expect(u.prog.regs[0]).toBe(1);
    expect(e.command(u, 'CONTINUE', 'firmware')).toBeNull();
    expect(u.progState).toBe(ProgState.PROG_HALTED);
    expect(e.command(u, 'CONTINUE', 'program')).toBeNull();
    expect(u.progState).toBe(ProgState.PROG_READY);
    run(e, 3);
    expect(u.prog.regs[0]).toBe(2);
  });

  it('hard reboots reset both contexts and make the program READY again', () => {
    const { e, u } = rover('loop: RUN 5\nJMP loop', 'ADD r0 1\nEND 4');
    until(e, () => u.progState === ProgState.PROG_DONE);
    e.upload(u, 'loop: RUN 5\nJMP loop', factory);
    expect(u.progState).toBe(ProgState.PROG_READY);
    expect(u.prog.regs[0]).toBe(0);
    expect(u.progResult).toBe(0);
    // Power loss in the middle of a slice.
    e.uploadProgram(u, 'loop: SLEEP 5\nJMP loop', factory);
    run(e, 3);
    expect(u.slice).toBeGreaterThanOrEqual(0);
    u.energy = 1;
    until(e, () => !u.powered);
    expect(u.slice).toBe(-1);
    e.admin.forceCharge(u);
    expect(u.progState).toBe(ProgState.PROG_READY);
    expect(u.vm.state).toBe(CpuState.RUNNING);
  });
});

describe('uploads and commands (SPEC §3.9.3)', () => {
  it('a program upload is cheaper, does not reboot and replaces a running program', () => {
    const { e, u } = rover('MOV r0 5\nloop: RUN 50\nJMP loop', 'loop: SLEEP 30\nJMP loop');
    run(e, 3);
    expect(u.slice).toBeGreaterThan(0);
    expect(u.action?.kind).toBe('WAIT');
    const before = u.energy;
    const res = e.uploadProgram(u, 'MOV r1 3\nEND 9');
    expect(res.rejected).toBeUndefined();
    expect(res.cost).toBe(e.programUploadCost(u, res.flashUsed));
    expect(res.cost).toBeLessThan(e.uploadCost(u, res.flashUsed));
    expect(u.energy).toBe(before - res.cost);
    expect(u.action).toBeNull(); // the old program's SLEEP was aborted
    expect(u.slice).toBe(-1);
    expect(u.vm.regs[0]).toBe(5); // no reboot
    until(e, () => u.progState === ProgState.PROG_DONE);
    expect(u.progResult).toBe(9);
    expect(u.prog.regs[1]).toBe(3);
  });

  it('an empty program erases it; Run again then has nothing to run', () => {
    const { e, u } = rover('loop: RUN 5\nJMP loop', 'END 1');
    e.uploadProgram(u, '; nothing', factory);
    expect(u.progState).toBe(ProgState.PROG_NONE);
    expect(u.programBytes).toBe(0);
    expect(e.command(u, 'RUN_AGAIN')).toMatch(/no program/);
  });

  it('rejects a firmware that no longer fits next to the program', () => {
    const big = Array.from({ length: 40 }, () => 'ADD r0 100').join('\n'); // 160 B
    const { e, u } = rover('loop: RUN 5\nJMP loop', big);
    const res = e.upload(u, big, factory);
    expect(res.program).toBeNull();
    expect(res.errors[0].message).toMatch(/Firmware is \d+ bytes \+ program 160 bytes/);
  });

  it('dumps the selected slot: program dumps are kinds 3/4 with @PROG_STATE', () => {
    const { e, u } = rover('loop: RUN 5\nJMP loop', 'MOV r0 42\nPUSH 6\nBRK\nSLEEP 1000');
    run(e, 3);
    expect(u.progState).toBe(ProgState.PROG_HALTED);
    expect(e.command(u, 'DUMP', 'program')).toBeNull();
    expect(e.command(u, 'DUMP_STACKS', 'program')).toBeNull();
    expect(e.command(u, 'DUMP', 'firmware')).toBeNull();
    const [cpu, stacks, fw] = u.link.sys.map((f) => decodeDump(f.bytes));
    expect(cpu).toMatchObject({ kind: 1, slot: 'program', ip: 3, state: 'PROG_HALTED', regs: [42, 0, 0, 0], dsDepth: 1 });
    expect(u.link.sys[0].bytes[1]).toBe(3);
    expect(stacks).toMatchObject({ kind: 2, slot: 'program', dataStack: [6] });
    expect(fw).toMatchObject({ kind: 1, slot: 'firmware' });
  });
});

describe('default firmware with the shipped programs', () => {
  it('runs First steps to the end and reports it', () => {
    const { e, u } = rover(DEFAULT_FIRMWARE, PROGRAM_TEMPLATES['First steps']);
    until(e, () => u.progState === ProgState.PROG_NONE, 3000);
    expect([0, 1]).toContain(u.progResult);
    expect(u.prog.instructionsExecuted).toBeGreaterThan(1);
    expect(e.stats.maxDistance).toBeGreaterThan(0);
    expect(u.post).toBe(u.progResult);
    run(e, 40);
    const logged = e.received.map((f) => decodeFrame(f.bytes)).filter((d) => d.kind === 0);
    expect(logged).toContainEqual({ kind: 0, tag: 14, value: ProgState.PROG_DONE });
    expect(logged).toContainEqual({ kind: 0, tag: 13, value: u.progResult });
  });

  it('Explorer explores; the firmware charges between slices', () => {
    const { e, u } = rover(DEFAULT_FIRMWARE, PROGRAM_TEMPLATES.Explorer);
    run(e, 1500);
    expect(Math.abs(u.x) + Math.abs(u.y)).toBeGreaterThan(0);
    expect(e.stats.maxDistance).toBeGreaterThan(3);
    expect(u.powered).toBe(true);
    expect(u.vm.state).not.toBe(CpuState.FAULT);
  });
});

describe('save v10', () => {
  it('round-trips a program in the middle of a slice', () => {
    const make = () => rover(DEFAULT_FIRMWARE, PROGRAM_TEMPLATES.Prospector, 11).e;
    const a = make();
    run(a, 400);
    const b0 = make();
    run(b0, 173);
    expect(b0.units[0].slice).toBeGreaterThanOrEqual(0); // saved inside a RUN slice
    expect(b0.units[0].prog.instructionsExecuted).toBeGreaterThan(0);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    expect(b.units[0].programSource).toBe(PROGRAM_TEMPLATES.Prospector);
    run(b, 227);
    expect(serialize(b)).toEqual(serialize(a));
  });

  it('migrates v9 saves: the old code stays the firmware, no program', () => {
    const { e } = rover('SLEEP 10');
    const v9 = serialize(e) as unknown as Record<string, any>;
    v9.version = 9;
    for (const u of v9.units) delete u.program;
    expect(migrate(v9).units[0].program.state).toBe(ProgState.PROG_NONE);
    const l = deserialize(v9);
    expect(l.units[0].sourceCode).toBe('SLEEP 10');
    expect(l.units[0].progState).toBe(ProgState.PROG_NONE);
    expect(l.units[0].slice).toBe(-1);
  });
});
