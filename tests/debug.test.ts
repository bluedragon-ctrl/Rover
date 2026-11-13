import { describe, expect, it } from 'vitest';
import { BALANCE, CHASSIS_MK1 } from '../src/core/balance';
import { decodeDump, DUMP_HEADER, encodeCpuDump, encodeLog, encodeStackDump, hex } from '../src/core/downlink';
import { deserialize, migrate, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { compile } from '../src/core/vm/Compiler';
import { describeFrame, emptyDictionary } from '../src/ui/comms';

const factory = { factory: true };

/** Keep the dish on the orbiter (signal = antennaHealth) before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

function rover(src: string, seed = 5): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  e.upload(u, src, factory);
  run(e, 1);
  u.link.fifo = []; // drop the boot frame: tests look at what follows
  u.link.headSent = 0;
  return { e, u };
}

/** Program: two registers, one stack value, one call frame, then BRK. */
const HALT_SRC = 'MOV r0 7\nMOV r1 -300\nPUSH 5\nCALL f\nf: BRK\nMOV r2 1';

describe('BRK and HALTED (SPEC §3.8.4)', () => {
  it('is a 1-byte, 1-cycle compute instruction that leaves @STATUS alone', () => {
    const r = compile('BRK', CHASSIS_MK1);
    expect(r.errors).toEqual([]);
    expect(r.flashUsed).toBe(1);
    const e = new SimulationEngine({ seed: 1 });
    const u = e.spawnUnit('t');
    e.upload(u, 'MOV r0 1\nBRK\nMOV r0 2', factory);
    u.vm.status = Status.ERR_BLOCKED;
    run(e, 1);
    expect(u.vm.state).toBe(CpuState.HALTED);
    expect(u.vm.instructionsExecuted).toBe(2); // both in the first tick: BRK takes one cycle
    expect(u.vm.regs[0]).toBe(1);
    expect(u.vm.status).toBe(Status.ERR_BLOCKED);
  });

  it('halts the CPU; the world keeps running and the watchdog never fires', () => {
    const { e, u } = rover(HALT_SRC);
    run(e, 2);
    expect(u.vm.state).toBe(CpuState.HALTED);
    const executed = u.vm.instructionsExecuted;
    u.solarTarget = 90; // motors still slew
    u.link.enqueue(encodeLog(3, 1), u.chassis.logFifoBytes); // the transmitter still sends
    run(e, BALANCE.watchdogTicks * 3);
    expect(u.vm.state).toBe(CpuState.HALTED);
    expect(u.vm.instructionsExecuted).toBe(executed);
    expect(u.solarAngle).toBe(90);
    expect(e.received.at(-1)?.bytes).toEqual(encodeLog(3, 1));
    expect(e.stepInstruction(u)).toBe(false); // the admin stepper does not spin through ticks
  });

  it('Continue resumes after the BRK; on a running CPU it is ignored but still paid', () => {
    const { e, u } = rover(HALT_SRC);
    run(e, 2);
    const before = u.energy;
    expect(e.command(u, 'CONTINUE')).toBeNull();
    expect(before - u.energy).toBe(e.commandCost(u));
    run(e, 1);
    expect(u.vm.regs[2]).toBe(1); // ran the instruction after BRK
    const { e: e2, u: u2 } = rover('loop: SLEEP 5\nJMP loop');
    const b = u2.energy;
    expect(e2.command(u2, 'CONTINUE')).toBeNull();
    expect(b - u2.energy).toBe(e2.commandCost(u2));
    expect(u2.vm.state).toBe(CpuState.BLOCKED);
  });

  it('an upload ends the halt (hard reboot)', () => {
    const { e, u } = rover(HALT_SRC);
    run(e, 2);
    e.upload(u, 'MOV r3 9\nSLEEP 100', factory);
    run(e, 1);
    expect(u.vm.state).toBe(CpuState.BLOCKED);
    expect(u.vm.regs[3]).toBe(9);
  });
});

describe('memory dumps (SPEC §3.8.4)', () => {
  it('encodes a 22-byte CPU dump on Mk-I (25 B on air) and decodes it back', () => {
    const f = encodeCpuDump({ ip: 300, status: Status.ERR_FULL, state: 'HALTED', regs: [7, -300, 0, 2147483647], dsDepth: 1, csDepth: 2 });
    expect(f).toHaveLength(25);
    expect(hex(f.slice(0, 7))).toBe('F8 01 16 01 2C 02 02');
    expect(decodeDump(f)).toEqual({ kind: 1, slot: 'firmware', ip: 300, status: 2, state: 'HALTED', regs: [7, -300, 0, 2147483647], dsDepth: 1, csDepth: 2 });
    const s = encodeStackDump([5, -1], [4]);
    expect(hex(s)).toBe('F8 02 0C 02 00 00 00 05 FF FF FF FF 01 00 04');
    expect(decodeDump(s)).toEqual({ kind: 2, slot: 'firmware', dataStack: [5, -1], callStack: [4] });
    expect(decodeDump(encodeLog(15, 1))).toBeNull();
  });

  it('snapshots the CPU when commanded and sends the reply before the log', () => {
    const { e, u } = rover(HALT_SRC);
    run(e, 2);
    u.link.enqueue(encodeLog(4, 1000), u.chassis.logFifoBytes);
    const t = e.tick;
    const before = u.energy;
    expect(e.command(u, 'DUMP')).toBeNull();
    expect(e.command(u, 'DUMP_STACKS')).toBeNull();
    expect(before - u.energy).toBe(2 * Math.ceil((BALANCE.dumpEnergy * 100) / e.signalOf(u)));
    u.vm.regs[0] = 99; // later changes are not in the snapshot
    run(e, 40);
    const rx = e.received.slice(-3);
    expect(rx.map((f) => f.bytes[0])).toEqual([DUMP_HEADER, DUMP_HEADER, encodeLog(4, 1000)[0]]);
    expect(rx[0].taken).toBe(t);
    expect(decodeDump(rx[0].bytes)).toMatchObject({ kind: 1, state: 'HALTED', regs: [7, -300, 0, 0], dsDepth: 1, csDepth: 1 });
    expect(decodeDump(rx[1].bytes)).toEqual({ kind: 2, slot: 'firmware', dataStack: [5], callStack: [13] });
    expect(rx[0].tick).toBeGreaterThan(t + 10); // 25 B at 2 B/tick: a snapshot, not a live view
    expect(e.stats.framesReceived).toBe(1); // dumps are system frames
  });

  it('rejects commands without power, without energy, or with a full dump queue', () => {
    const { e, u } = rover('loop: SLEEP 50\nJMP loop');
    for (let i = 0; i < BALANCE.dumpQueueMax; i++) expect(e.command(u, 'DUMP')).toBeNull();
    const before = u.energy;
    expect(e.command(u, 'DUMP')).toMatch(/already waiting/);
    expect(u.energy).toBe(before);
    expect(e.command(u, 'CONTINUE')).toBeNull(); // not a dump: not limited by the queue
    u.energy = e.commandCost(u);
    expect(e.command(u, 'CONTINUE')).toMatch(/battery/);
    u.vm.state = CpuState.POWER_OFF;
    expect(e.command(u, 'DUMP')).toMatch(/POWER_OFF/);
  });

  it('costs more at weak signal; free with the admin free-upload cheat', () => {
    const { e, u } = rover('SLEEP 100');
    expect(e.commandCost(u)).toBe(BALANCE.dumpEnergy);
    u.antennaHealth = 25;
    expect(e.commandCost(u)).toBe(BALANCE.dumpEnergy * 4);
    e.cheats.freeUpload = true;
    expect(e.commandCost(u)).toBe(0);
  });

  it('the console shows dumps as snapshots with their tick, addresses and source lines', () => {
    const lines: Record<number, number> = { 5: 6, 4: 5 };
    const d = { firmware: { tags: {}, regs: {}, lineAt: (a: number) => lines[a] ?? 0 }, program: emptyDictionary() };
    const cpu = { unitId: 1, tick: 90, gap: 0, taken: 77, bytes: encodeCpuDump({ ip: 5, status: 0, state: 'HALTED', regs: [7, -300, 0, 0], dsDepth: 1, csDepth: 1 }) };
    expect(describeFrame(cpu, d)).toBe('FIRMWARE DUMP (snapshot t77): next fw:0x005 (L6) · HALTED · @STATUS OK · r0=7 r1=-300 r2=0 r3=0 · stacks 1/1');
    const st = { ...cpu, bytes: encodeStackDump([5], [4, 9]) };
    expect(describeFrame(st, d)).toBe('FIRMWARE STACKS (snapshot t77): data [5] · return to [fw:0x004 (L5) fw:0x009]');
  });

  it('save while a dump is on the air, load, continue == uninterrupted run', () => {
    const make = () => {
      const { e, u } = rover('CONST T 2\nloop: LOG T @TICK\nSLEEP 9\nBRK\nJMP loop', 13);
      u.antennaHealth = 75;
      e.command(u, 'DUMP');
      e.command(u, 'DUMP_STACKS');
      return e;
    };
    const a = make();
    run(a, 60);
    const b0 = make();
    run(b0, 9);
    expect(b0.units[0].link.sysSent).toBeGreaterThan(0);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, 51);
    expect(serialize(b)).toEqual(serialize(a));
    expect(a.units[0].vm.state).toBe(CpuState.HALTED);
    // The two requested dumps, plus the one BRK sent by itself.
    expect(a.received.filter((f) => f.taken !== undefined)).toHaveLength(3);
  });

  it('migrates v5 saves to an empty dump queue', () => {
    const { e } = rover('SLEEP 10');
    const v5 = serialize(e) as unknown as Record<string, any>;
    v5.version = 5;
    for (const u of v5.units) {
      delete u.link.sys;
      delete u.link.sysSent;
    }
    expect(migrate(v5).units[0].link.sys).toEqual([]);
    expect(deserialize(v5).units[0].link.sysSent).toBe(0);
  });
});
