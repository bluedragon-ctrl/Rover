import { describe, expect, it } from 'vitest';
import { deserialize, migrate, SAVE_VERSION, serialize } from '../src/core/SaveManager';
import { SENT_KEEP, SimulationEngine } from '../src/core/SimulationEngine';
import type { Unit } from '../src/core/Unit';
import { latestSnapshot, pendingRequests, replyTo, sentText, snapshotOutdated } from '../src/ui/comms';

/** Keep the dish on the orbiter (full signal) before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

const FW = 'CONST T 2\nloop: LOG T @TICK\nRUN 5\nSLEEP 4\nJMP loop';
const PROG = 'CONST P 3\nLOG P 1\nSLEEP 2\nEND 1';

function rover(seed = 3): { e: SimulationEngine; u: Unit; logs: { message: string; category?: string }[] } {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  const logs: { message: string; category?: string }[] = [];
  e.events.on('LOG', (m) => logs.push(m));
  e.upload(u, FW, { factory: true });
  run(e, 1);
  return { e, u, logs };
}

describe('Mission control sent record (M11 Comms)', () => {
  it('records accepted commands and uploads, not factory installs or rejected commands', () => {
    const { e, u, logs } = rover();
    expect(e.sent).toEqual([]);
    e.uploadProgram(u, PROG);
    e.command(u, 'DUMP', 'program');
    e.command(u, 'CONTINUE', 'firmware');
    e.command(u, 'RUN_AGAIN', 'firmware');
    e.upload(u, FW);
    expect(e.sent.map((r) => [r.kind, r.slot])).toEqual([
      ['PROGRAM', 'program'],
      ['DUMP', 'program'],
      ['CONTINUE', 'firmware'],
      ['RUN_AGAIN', 'program'],
      ['FIRMWARE', 'firmware'],
    ]);
    expect(e.sent[0].bytes).toBeGreaterThan(0);
    expect(e.sent.every((r) => r.tick === e.tick && r.cost > 0)).toBe(true);
    // Receipts are tagged so the Mission events strip can leave them to Comms; the factory install is not a receipt.
    expect(logs.filter((l) => l.category === 'sent')).toHaveLength(5);
    expect(logs[0].category).toBe('world');
    u.energy = 0;
    expect(e.command(u, 'DUMP')).not.toBeNull();
    expect(e.sent).toHaveLength(5);
  });

  it('erasing the program is recorded with 0 bytes; the record keeps the newest SENT_KEEP', () => {
    const { e, u } = rover();
    e.cheats.freeUpload = true;
    e.uploadProgram(u, '');
    expect(sentText(e.sent[0])).toBe('Program erased');
    for (let i = 0; i < SENT_KEEP + 5; i++) e.command(u, 'CONTINUE', 'program');
    expect(e.sent).toHaveLength(SENT_KEEP);
    expect(e.sent[0].kind).toBe('CONTINUE');
  });

  it('rover-internal messages are tagged rover, world messages world', () => {
    const { e, u, logs } = rover();
    e.uploadProgram(u, 'POP r0');
    run(e, 12);
    expect(logs.find((l) => l.message.startsWith('Program FAULT'))?.category).toBe('rover');
    e.admin.forceRepair(u);
    expect(logs.at(-1)?.category).toBe('world');
  });
});

describe('Pairing requests with copies', () => {
  it('a copy answers the request sent in the tick it was taken; pending until it arrives', () => {
    const { e, u } = rover();
    e.uploadProgram(u, PROG);
    run(e, 2);
    e.command(u, 'DUMP', 'program');
    e.command(u, 'DUMP_STACKS', 'firmware');
    const [, regs, stacks] = e.sent;
    expect(replyTo(regs, e.received)).toBeNull();
    expect(pendingRequests(e.sent, e.received, u.id, 'program', 'regs')).toEqual([regs]);
    run(e, 60);
    const r = replyTo(regs, e.received)!;
    expect(r.dump.slot).toBe('program');
    expect(r.dump.kind).toBe(1);
    expect(r.taken).toBe(regs.tick);
    expect(replyTo(stacks, e.received)?.dump.kind).toBe(2);
    expect(pendingRequests(e.sent, e.received, u.id, 'program', 'regs')).toEqual([]);
    // Nothing of the other slot / kind is mixed up.
    expect(latestSnapshot(e.received, u.id, 'firmware', 'regs')).toBeNull();
    expect(latestSnapshot(e.received, u.id, 'program', 'regs')?.frame).toBe(r.frame);
  });

  it('a copy taken before a new upload of its slot is outdated; other slot uploads do not matter', () => {
    const { e, u } = rover();
    e.uploadProgram(u, PROG);
    e.command(u, 'DUMP', 'program');
    run(e, 60);
    const s = latestSnapshot(e.received, u.id, 'program', 'regs')!;
    expect(snapshotOutdated(s, e.sent, u.id)).toBe(false);
    e.upload(u, FW);
    expect(snapshotOutdated(s, e.sent, u.id)).toBe(false);
    e.uploadProgram(u, PROG);
    expect(snapshotOutdated(s, e.sent, u.id)).toBe(true);
  });

  it('player-facing names say what is copied and never say dump', () => {
    const r = { unitId: 1, tick: 1, slot: 'program' as const, cost: 0 };
    expect(sentText({ ...r, kind: 'DUMP' })).toBe("Request a copy of the program's registers");
    expect(sentText({ ...r, kind: 'DUMP_STACKS', slot: 'firmware' })).toBe("Request a copy of the firmware's stacks");
    for (const kind of ['DUMP', 'DUMP_STACKS', 'CONTINUE', 'RUN_AGAIN', 'PROGRAM', 'FIRMWARE'] as const) expect(sentText({ ...r, kind })).not.toMatch(/dump/i);
  });
});

describe('Saving the sent record', () => {
  it('save with a request on the air, load, continue == uninterrupted run', () => {
    const make = () => {
      const { e, u } = rover(9);
      e.uploadProgram(u, PROG);
      e.command(u, 'DUMP', 'program');
      return e;
    };
    const a = make();
    run(a, 40);
    const b0 = make();
    run(b0, 7);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    expect(b.sent).toEqual(b0.sent);
    run(b, 33);
    expect(serialize(b)).toEqual(serialize(a));
    expect(replyTo(a.sent[1], a.received)).not.toBeNull();
  });

  it('migrates v12 saves to an empty sent record', () => {
    const { e } = rover();
    const v12 = serialize(e) as unknown as Record<string, unknown>;
    v12.version = 12;
    delete v12.sent;
    expect(SAVE_VERSION).toBe(13);
    expect(migrate(v12).sent).toEqual([]);
    expect(deserialize(v12).sent).toEqual([]);
  });
});
