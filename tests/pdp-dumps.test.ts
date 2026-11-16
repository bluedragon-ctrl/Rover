import { describe, expect, it } from 'vitest';
import { PDP11 } from '../src/core/balance';
import { decodeDump, DumpKind, encodeCpu11Dump, encodeStack11Dump, STACK11_WORDS } from '../src/core/downlink';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, ProgState } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { T } from '../src/core/WorldRegistry';

// M15 slice 5: register and stack dumps of the PDP-11 core (uplink DUMP / DUMP_STACKS, BPT).

const factory = { factory: true };

function rover(firmware: string, program?: string): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: 5 });
  const u = e.spawnUnit('t');
  for (let x = -4; x <= 4; x++)
    for (let y = -4; y <= 4; y++) {
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
    }
  if (program !== undefined) expect(e.uploadProgram(u, program, factory).errors).toEqual([]);
  expect(e.upload(u, firmware, factory).errors).toEqual([]);
  for (let t = 0; t < 10; t++) e.advanceTick();
  return { e, u };
}

const POLL = 'START:\n1$:     MOV #GO, @#PRGCS\n        WAIT\n        BR 1$';
const dumps = (u: Unit) => u.link.sys.map((f) => decodeDump(f.bytes));

describe('PDP-11 dump frames', () => {
  it('register dump round-trips: state, PSW, R0–R7 low byte first', () => {
    const b = encodeCpu11Dump({ state: 'RUNNING', psw: 0o340, r: [1, 0o177777, 3, 4, 5, 6, 0o1776, 0o200] });
    expect([b[1], b[2]]).toEqual([DumpKind.CPU11, 19]);
    expect(b[4]).toBe(0o340 & 0xff); // PSW low byte first
    expect(decodeDump(b)).toEqual({ kind: 'regs', slot: 'firmware', state: 'RUNNING', psw: 0o340, r: [1, 0o177777, 3, 4, 5, 6, 0o1776, 0o200] });
    const p = decodeDump(encodeCpu11Dump({ state: ProgState.PROG_HALTED, psw: 0o170000, r: [0, 0, 0, 0, 0, 0, 0, 0] }, true));
    expect(p).toMatchObject({ kind: 'regs', slot: 'program', state: 'PROG_HALTED', psw: 0o170000 });
  });

  it('stack dump round-trips: SP, count, words from SP up', () => {
    const b = encodeStack11Dump(0o1770, [7, 0o160010], true);
    expect(b[1]).toBe(DumpKind.PROG_STACK11);
    expect(decodeDump(b)).toEqual({ kind: 'stack', slot: 'program', sp: 0o1770, words: [7, 0o160010] });
  });
});

describe('PDP-11 dumps on the rover', () => {
  it('DUMP sends the firmware registers as they are at the moment the request arrives', () => {
    const { e, u } = rover('START:  MOV #1234, R3\n1$:     WAIT\n        BR 1$');
    expect(e.command(u, 'DUMP')).toBeNull();
    const d = dumps(u).at(-1)!;
    expect(d).toMatchObject({ kind: 'regs', slot: 'firmware', state: 'RUNNING' });
    if (d.kind !== 'regs') throw new Error();
    expect(d.r[3]).toBe(0o1234);
    expect(d.r[6]).toBe(u.machine.registers('firmware').r[6]);
    expect(d.psw).toBe(u.machine.registers('firmware').psw);
  });

  it('DUMP_STACKS sends SP and the words above it, at most eight', () => {
    const fw = `START:  MOV #11, -(SP)\n        MOV #22, -(SP)\n1$:     WAIT\n        BR 1$`;
    const { e, u } = rover(fw);
    expect(e.command(u, 'DUMP_STACKS')).toBeNull();
    const d = dumps(u).at(-1)!;
    if (d.kind !== 'stack') throw new Error(`kind ${d.kind}`);
    expect(d.slot).toBe('firmware');
    expect(d.sp).toBe(u.machine.registers('firmware').r[6]);
    expect(d.words.slice(0, 2)).toEqual([0o22, 0o11]);
    expect(d.words.length).toBeLessThanOrEqual(STACK11_WORDS);
    expect(d.sp + 2 * d.words.length).toBeLessThanOrEqual(PDP11.programBase);
  });

  it('the program stack dump starts at its SP and ends at the top of core (the EXIT return address)', () => {
    const { e, u } = rover(POLL, 'START:  MOV #5, -(SP)\n        BPT\n        HALT');
    expect(u.progState).toBe(ProgState.PROG_HALTED);
    expect(e.command(u, 'DUMP_STACKS', 'program')).toBeNull();
    const d = dumps(u).at(-1)!;
    if (d.kind !== 'stack') throw new Error();
    expect(d.sp).toBe(u.machine.coreBytes - 4);
    expect(d.words).toEqual([5, u.machine.read(u.machine.coreBytes - 2, false)]);
  });

  it('BPT in the program sends a program register dump by itself', () => {
    const { u } = rover(POLL, 'START:  MOV #7, R2\n        BPT\n        HALT');
    expect(u.progState).toBe(ProgState.PROG_HALTED);
    const d = dumps(u).find((x) => x?.slot === 'program');
    expect(d).toMatchObject({ kind: 'regs', slot: 'program', state: 'PROG_HALTED' });
    if (d?.kind !== 'regs') throw new Error();
    expect(d.r[2]).toBe(7);
  });

  it('BPT in the firmware halts the CPU and sends a firmware register dump', () => {
    const { u } = rover('START:  MOV #3, R1\n        BPT\n1$:     WAIT\n        BR 1$');
    expect(u.cpu.state).toBe(CpuState.HALTED);
    const d = dumps(u).find((x) => x?.slot === 'firmware');
    expect(d).toMatchObject({ kind: 'regs', state: 'HALTED' });
  });

  it('dumps arrive on the downlink like the Rover-ASM ones', () => {
    const { e, u } = rover('START:\n1$:     WAIT\n        BR 1$');
    expect(e.command(u, 'DUMP')).toBeNull();
    for (let i = 0; i < 40; i++) {
      u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
      e.advanceTick();
    }
    const got = e.received.map((f) => decodeDump(f.bytes)).filter((d) => d?.kind === 'regs');
    expect(got.length).toBe(1);
  });
});

describe('debugger reads of the PDP-11 core', () => {
  it('peek and ioSnapshot change nothing in the simulation', async () => {
    const { serialize } = await import('../src/core/SaveManager');
    const { PDP_DEFAULT_FIRMWARE, PDP_FIRST_STEPS } = await import('../src/core/programs-pdp11');
    const { e, u } = rover(PDP_DEFAULT_FIRMWARE, PDP_FIRST_STEPS);
    for (let i = 0; i < 30; i++) e.advanceTick();
    const before = JSON.stringify(serialize(e));
    const snap = u.machine.ioSnapshot();
    for (let a = 0; a < 0o200000; a += 2) u.machine.peek(a);
    expect(JSON.stringify(serialize(e))).toBe(before);
    const tickl = snap.find((x) => x.reg.name === 'TICKL')!;
    expect(tickl.value).toBe(e.tick & 0xffff);
    expect(u.machine.peek(0o2000)).toBe(u.machine.read(0o2000, false));
    expect(u.machine.peek(0o177560)).toBeNull();
    expect(u.machine.peek(0o40000)).toBeNull(); // nothing installed there
  });
});
