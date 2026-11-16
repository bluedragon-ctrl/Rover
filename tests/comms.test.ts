import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SENT_KEEP, SimulationEngine } from '../src/core/SimulationEngine';
import type { Unit } from '../src/core/Unit';
import { encodeCpu11Dump, encodeLog, encodeStack11Dump } from '../src/core/downlink';
import { ProgState } from '../src/core/types';
import { dumpRunning, emptyDictionary, fieldsHtml, frameFields, sentByBreakpoint, latestSnapshot, pendingRequests, replyTo, sentText, snapshotOutdated, type Dictionaries } from '../src/ui/comms';
import { fw, sleep } from './helpers/rover';

/** Keep the dish on the orbiter (full signal) before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

const FW = `START:\n1$:     MOV  #2, R0\n        MOV  @#TICKL, R1\n        JSR  PC, LOG\n        MOV  #5, R0\n        JSR  PC, RUN\n        ${sleep(4)}\n        BR   1$`;
const PROG = `START:  MOV  #3, R0\n        MOV  #1, R1\n        JSR  PC, LOG\n        ${sleep(2)}\n        MOV  #1, R0\n        HALT`;

function rover(seed = 3): { e: SimulationEngine; u: Unit; logs: { message: string; category?: string }[] } {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  const logs: { message: string; category?: string }[] = [];
  e.events.on('LOG', (m) => logs.push(m));
  e.upload(u, FW, { factory: true });
  run(e, 4); // booted
  return { e, u, logs };
}

describe('Mission control sent record (M11 Comms)', () => {
  it('records commands and uploads (rejected ones marked), not factory installs', () => {
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
    // A rejected command is recorded as rejected (Comms lists it), costs nothing and never waits for a reply.
    u.energy = 0;
    expect(e.command(u, 'DUMP', 'program')).not.toBeNull();
    expect(e.sent).toHaveLength(6);
    expect(e.sent[5]).toMatchObject({ kind: 'DUMP', cost: 0, rejected: expect.stringContaining('battery') });
    expect(pendingRequests(e.sent, e.received, u.id, 'program', 'regs')).toEqual([e.sent[1]]);
    expect(e.uploadProgram(u, PROG).rejected).toBeTruthy();
    expect(e.sent[6]).toMatchObject({ kind: 'PROGRAM', rejected: expect.stringContaining('battery') });
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
    e.uploadProgram(u, 'START:  MOV  #1, @#200\n        HALT'); // writes the firmware: a protection fault
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
    expect(r.dump.kind).toBe('regs');
    expect(r.taken).toBe(regs.tick);
    expect(replyTo(stacks, e.received)?.dump.kind).toBe('stack');
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

  it('player-facing names say what is dumped from which slot', () => {
    const r = { unitId: 1, tick: 1, slot: 'program' as const, cost: 0 };
    expect(sentText({ ...r, kind: 'DUMP' })).toBe("Dump the program's registers");
    expect(sentText({ ...r, kind: 'DUMP_STACKS', slot: 'firmware' })).toBe("Dump the firmware's stack");
  });
});

describe('Byte-by-byte decoding (Comms "Decode bytes", Reference → Radio)', () => {
  const d: Dictionaries = {
    firmware: emptyDictionary(),
    program: { tags: { 2: { names: ['L.BAT'], lines: [5] } }, lineAt: (a) => (a === 0o2026 ? 18 : 0) },
  };
  const joined = (b: number[]) => frameFields(b, d).flatMap((f) => f.bytes);

  it('explains every byte exactly once', () => {
    const frames = [
      encodeLog(2, 812),
      encodeLog(3, null),
      encodeLog(1, -70000),
      encodeLog(15, 2),
      encodeCpu11Dump({ state: ProgState.PROG_RUNNING, psw: 0o170000, r: [3, 255, 0xffff, 0, 0, 0, 0o3770, 0o2026] }, true),
      encodeCpu11Dump({ state: 'HALTED', psw: 0, r: [1, 2, 3, 4, 5, 6, 7, 8] }),
      encodeStack11Dump(0o3770, [5, 0o2030], true),
      encodeStack11Dump(0o2000, []),
    ];
    for (const b of frames) expect(joined(b)).toEqual(b);
  });

  it('decodes words low byte first, in octal with the signed decimal, the PC with its line', () => {
    const f = frameFields(encodeCpu11Dump({ state: ProgState.PROG_RUNNING, psw: 0o170000, r: [3, 255, 0xffff, 0, 0, 0, 0o3770, 0o2026] }, true), d);
    const row = (name: string) => f.find((x) => x.name === name)!;
    expect(row('kind').value).toBe('program registers');
    expect(row('PC')).toMatchObject({ bytes: [0o26, 0o4], value: '002026 → line 18', goto: { slot: 'program', line: 18 } });
    expect(row('state').value).toBe('PROG_RUNNING');
    expect(row('R1')).toMatchObject({ bytes: [0xff, 0], value: '000377' });
    expect(row('R2')).toMatchObject({ bytes: [0xff, 0xff], value: '177777' });
    expect(row('R2').note).toMatch(/^-1\./);
  });

  it('Comms explains each header layout once: LOG and system share one, dumps have their own', () => {
    const seen = new Set<string>();
    const comment = (b: number[]) => fieldsHtml(frameFields(b, d), seen).includes('value size');
    const dumpComment = (b: number[]) => fieldsHtml(frameFields(b, d), seen).includes('length byte');
    expect(comment(encodeLog(2, 812))).toBe(true);
    expect(comment(encodeLog(2, 811))).toBe(false);
    expect(comment(encodeLog(15, 2))).toBe(false);
    const dump = encodeStack11Dump(0o2000, [], true);
    expect(dumpComment(dump)).toBe(true);
    expect(dumpComment(dump)).toBe(false);
    // The header value (tag, size) stays on every row.
    expect(fieldsHtml(frameFields(encodeLog(2, 811), d), seen)).toContain('LOG tag 2 L.BAT, 2-byte value');
    // Without a set (Reference) every comment is shown.
    expect(fieldsHtml(frameFields(encodeLog(2, 811), d))).toContain('value size');
  });

  it('LOG and boot messages: header bits, tag names, values, boot reasons', () => {
    const log = frameFields(encodeLog(2, 812), d);
    expect(log[0].value).toBe('LOG tag 2 L.BAT, 2-byte value');
    expect(log[0].note).toContain('0|0010|10|0');
    expect(log[1]).toMatchObject({ bytes: [0x03, 0x2c], value: '812' });
    expect(frameFields(encodeLog(15, 2), d)[1].value).toBe('2 = rebooted: watchdog');
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

});

describe('a breakpoint reports itself (SPEC §3.8.4)', () => {
  it('a BPT in the firmware sends a register dump unasked; Comms labels it a breakpoint', () => {
    const e = new SimulationEngine({ seed: 4 });
    const u = e.spawnUnit('t');
    e.upload(u, fw('MOV  #7, R0', 'BPT', 'MOV  #10, R0'), { factory: true });
    run(e, 40);
    const f = e.received.find((x) => x.taken !== undefined)!;
    expect(f).toBeDefined();
    expect(sentByBreakpoint(f, e.sent)).toBe(true);
    const fields = frameFields(f.bytes, { firmware: emptyDictionary(), program: emptyDictionary() });
    expect(fields.find((x) => x.name === 'state')).toMatchObject({ value: 'HALTED', note: expect.stringContaining('stopped by HALT or BPT') });
    expect(fields.find((x) => x.name === 'PC')!.note).toMatch(/in the ROM/); // the ROM's BPT handler halted the CPU
    expect(fields.find((x) => x.name === 'R0')!.value).toBe('000007');
    // Asking for a dump of the halted firmware is not a breakpoint's.
    e.command(u, 'DUMP', 'firmware');
    run(e, 40);
    expect(sentByBreakpoint(e.received.filter((x) => x.taken !== undefined).at(-1)!, e.sent)).toBe(false);
  });

  it('a BPT in the program dumps the program (PROG_HALTED); a finished program has no meaningful PC', () => {
    const { e, u } = rover();
    e.uploadProgram(u, 'START:  MOV  #5, R1\n        BPT\n        HALT');
    run(e, 60);
    const f = e.received.find((x) => x.taken !== undefined)!;
    expect(sentByBreakpoint(f, e.sent)).toBe(true);
    const fields = frameFields(f.bytes, { firmware: emptyDictionary(), program: emptyDictionary() });
    expect(fields.find((x) => x.name === 'state')!.value).toBe('PROG_HALTED');
    expect(dumpRunning('PROG_HALTED')).toBe(true);
    expect(dumpRunning('PROG_DONE')).toBe(false);
    expect(dumpRunning('PROG_NONE')).toBe(false);
  });

  it('a dump of a program that is not running says so and links nowhere', () => {
    const b = encodeCpu11Dump({ state: ProgState.PROG_NONE, psw: 0, r: [0, 0, 0, 0, 0, 0, 0, 0o2000] }, true);
    const f = frameFields(b, { firmware: emptyDictionary(), program: { tags: {}, lineAt: () => 7 } });
    expect(f.find((x) => x.name === 'PC')).toMatchObject({ value: '002000 (not running)', goto: undefined });
    expect(fieldsHtml(f, undefined, true)).not.toContain('data-goto');
  });
});
