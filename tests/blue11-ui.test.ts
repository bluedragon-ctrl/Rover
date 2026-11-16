import { describe, expect, it } from 'vitest';
import { DEFAULT_FIRMWARE, FIRMWARE_TEMPLATES, FIRST_STEPS, IMAGE_NEGATIVE, PROGRAM_TEMPLATES } from '../src/core/programs';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { oct6, listingRows, coreRegions, toolchain } from '../src/ui/toolchain';

// M15 slice 5: the Code tab's view of the Blue-11 (headless parts).

function setup() {
  const e = new SimulationEngine({ seed: 1 });
  const u = e.spawnUnit('t');
  return { e, u, tc: toolchain(e) };
}

describe('toolchain for the Code tab', () => {
  it('picks the templates and octal addresses', () => {
    const { tc } = setup();
    expect(tc.templates('program')).toBe(PROGRAM_TEMPLATES);
    expect(tc.templates('firmware')).toBe(FIRMWARE_TEMPLATES);
    expect(tc.addr(0o2000, 'program')).toBe('002000');
  });

  it('builds every template; sizes fit the regions', () => {
    const { u, tc } = setup();
    const r = coreRegions(u);
    expect(r).toEqual({ fw: 0o1600, prog: 2048 - 2 - 0o2000 });
    for (const [slot, set] of [['program', PROGRAM_TEMPLATES], ['firmware', FIRMWARE_TEMPLATES]] as const)
      for (const [name, src] of Object.entries(set)) {
        const b = tc.build(u, src, slot);
        expect(b.errors, name).toEqual([]);
        expect(b.bytes, name).toBeLessThanOrEqual(slot === 'program' ? r.prog : r.fw);
      }
  });

  it('maps instruction addresses to source lines', () => {
    const { u, tc } = setup();
    const b = tc.build(u, FIRST_STEPS, 'program');
    const start = b.result.asm.symbols.get('START')!;
    const line = FIRST_STEPS.split('\n').findIndex((l) => l.startsWith('START:')) + 1;
    expect(b.lineAt(start)).toBe(line);
    expect(b.lineAt(0o177776)).toBe(0);
  });

  it('reports errors and warnings with their lines', () => {
    const { u, tc } = setup();
    const b = tc.build(u, 'START:  MOV #1, NOPE\n        HALT', 'program');
    expect(b.ok).toBe(false);
    expect(b.errors[0]).toMatchObject({ line: 1 });
    const w = tc.build(u, 'START:  HALT\nNOP=5', 'program');
    expect(w.ok).toBe(true);
    expect(w.warnings[0]).toMatchObject({ line: 2 });
  });

  it('the listing splits address, octal words and source, and marks errors', () => {
    const { u, tc } = setup();
    const b = tc.build(u, 'START:  MOV #3, R1\nLOOP:   BR LOOP\nD:      .WORD 7\n        CLR Q\n', 'program');
    const rows = listingRows(b);
    expect(rows[0]).toMatchObject({ line: 1, addr: '002000', code: ['012701', '000003'], kind: 'instr' });
    expect(rows[0].source).toMatch(/^START:\s+MOV #3, R1/);
    expect(rows[1]).toMatchObject({ addr: '002004', code: ['000777'], kind: 'instr' });
    expect(rows[2]).toMatchObject({ addr: '002006', code: ['000007'], kind: 'data' });
    expect(rows.find((r) => r.line === 4)?.error).toMatch(/undefined symbol Q/);
  });

  it('knows which firmware runs a program and which code photographs without sending', () => {
    const { u, tc } = setup();
    expect(tc.runsProgram(tc.build(u, DEFAULT_FIRMWARE, 'firmware'))).toBe(true);
    expect(tc.runsProgram(tc.build(u, FIRMWARE_TEMPLATES['All-in-one Explorer (no program)'], 'firmware'))).toBe(false);
    const snapOnly = tc.build(u, 'START:  CLR R0\n        MOV #F.M1, R1\n        JSR PC, SNAP   ; SNDIMG in a comment does not count\n        HALT', 'program');
    expect(tc.snapsWithoutSend(snapOnly, null)).toBe(true);
    expect(tc.snapsWithoutSend(tc.build(u, IMAGE_NEGATIVE, 'program'), null)).toBe(false);
  });

  it('formats words as six octal digits', () => {
    expect(oct6(0)).toBe('000000');
    expect(oct6(-1)).toBe('177777');
  });
});

describe('Comms', () => {
  it('names log tags from the L. symbols and finds the lines that use them', async () => {
    const { slotDictionary } = await import('../src/ui/comms');
    const { u, tc } = setup();
    const src = 'L.X = 5   ; tag\nSTART:  MOV #L.X, R0\n        JSR PC, LOG\n        HALT';
    const d = slotDictionary(tc.build(u, src, 'program'));
    expect(d.tags[5]).toEqual({ names: ['L.X'], lines: [2] });
  });

  it('describes framed messages and explains their bytes', async () => {
    const { describeMessage, messageFields, slotDictionary, emptyDictionary } = await import('../src/ui/comms');
    const { MsgType } = await import('../src/core/messages');
    const { u, tc } = setup();
    const d = { firmware: slotDictionary(tc.build(u, DEFAULT_FIRMWARE, 'firmware')), program: emptyDictionary() };
    const log = { unitId: 1, tick: 3, type: MsgType.LOG, body: [1, 0xff, 0xff], status: 'ok' as const };
    expect(describeMessage(log, d)).toBe('L.BAT = -1');
    const f = messageFields(log, d);
    expect(f.map((x) => x.name)).toEqual(['SOH', 'type', 'length', 'tag', 'value', 'ETX']);
    expect(f.flatMap((x) => x.bytes)).toEqual([1, MsgType.LOG, 3, 1, 0xff, 0xff, 3]);
    expect(f[3].goto?.slot).toBe('firmware');
    expect(describeMessage({ ...log, type: MsgType.TEXT, body: [...'HI'].map((c) => c.charCodeAt(0)) }, d)).toBe('“HI”');
    expect(describeMessage({ ...log, type: MsgType.ERR, body: [4, 0o10, 0o4] }, d)).toBe('error E.BLK at 002010');
    expect(describeMessage({ ...log, type: 0o100, body: [1, 2] }, d)).toBe('type 100: 01 02');
    const broken = messageFields({ ...log, status: 'broken' }, d);
    expect(broken.at(-1)?.name).toBe('broken');
  });

  it('explains dumps byte by byte; BPT dumps count as sent by a breakpoint', async () => {
    const { frameFields, describeFrame, sentByBreakpoint, slotDictionary, emptyDictionary, romRoutineAt } = await import('../src/ui/comms');
    const { encodeCpu11Dump, encodeStack11Dump } = await import('../src/core/downlink');
    const { ROM_EXPORTS } = await import('../src/core/machine/rom');
    const { ProgState } = await import('../src/core/types');
    const { u, tc } = setup();
    const d = { firmware: emptyDictionary(), program: slotDictionary(tc.build(u, FIRST_STEPS, 'program')) };
    const bytes = encodeCpu11Dump({ state: ProgState.PROG_HALTED, psw: 0o170004, r: [1, 2, 3, 4, 5, 6, 0o3774, 0o2002] }, true);
    const fields = frameFields(bytes, d);
    expect(fields.flatMap((x) => x.bytes)).toEqual(bytes);
    expect(fields.find((x) => x.name === 'PSW')?.value).toBe('170004 nZvc');
    expect(fields.find((x) => x.name === 'PC')?.note).toMatch(/after the BPT on line 16/);
    const frame = { unitId: 1, tick: 9, bytes, gap: 0, taken: 8 };
    expect(sentByBreakpoint(frame, [])).toBe(true);
    expect(describeFrame(frame, d)).toMatch(/^PROGRAM DUMP \(snapshot t8\): PC 002002 \(L17\) · PROG_HALTED · PSW 170004 nZvc · R0=000001/);
    const st = encodeStack11Dump(0o1774, [7, 0o2014]);
    expect(frameFields(st, d).flatMap((x) => x.bytes)).toEqual(st);
    expect(romRoutineAt(ROM_EXPORTS.STEP + 2)).toBe('STEP');
    expect(romRoutineAt(0o2000)).toBe('');
  });
});

describe('Reference', () => {
  it('documents every instruction of the set and every ROM routine', async () => {
    const { INSTR_DOC, romDocs } = await import('../src/ui/ReferenceBlue11');
    const { INSTRUCTIONS } = await import('../src/blue11');
    const { ROM_ROUTINES } = await import('../src/core/machine/rom');
    for (const i of INSTRUCTIONS) {
      const base = i.byte ? i.name.slice(0, -1) : i.name;
      expect(INSTR_DOC[base], i.name).toBeDefined();
      expect(INSTR_DOC[base].flags, i.name).toMatch(/^[-*01]{4}$/);
    }
    const docs = romDocs();
    for (const n of ROM_ROUTINES) expect(docs[n], n).toMatch(/\w/);
    expect(docs.STEP).toMatch(/^drive R1 tiles in direction R0/);
  });
});

describe('double-resolution photos in the Gallery', () => {
  it('a delivered photo frame has all its bytes (not cut to the 1x size)', async () => {
    const { productFrame, productSize } = await import('../src/core/imaging');
    const { PHOTO_FORMATS_2X, photoBytes } = await import('../src/core/photos');
    const g = { type: 1, subject: 0, x: 0, y: 0, lit: true, seq: 0, tick: 5, credits: 0, x2: true as const };
    expect(productSize(g)).toBe(2 + photoBytes(1, PHOTO_FORMATS_2X));
    expect(productFrame(7, g).length).toBe(productSize(g));
    expect(productSize({ type: 1 })).toBe(2 + 256);
  });
});
