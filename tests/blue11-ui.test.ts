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

  it('every instruction example assembles (the names it branches to defined after it)', async () => {
    const { INSTR_DOC } = await import('../src/ui/ReferenceBlue11');
    const { assemble } = await import('../src/blue11');
    const { predefinedSymbols } = await import('../src/core/machine/symbols');
    const { createDefaultRegistry } = await import('../src/core/WorldRegistry');
    const symbols = predefinedSymbols(createDefaultRegistry());
    const labels = 'LOOP ZERO FITS POS MINUS BAD EVEN ODD BIG SMALL FAR NEAR START'.split(' ').map((l) => `${l}: NOP`).join('\n');
    for (const [name, d] of Object.entries(INSTR_DOC)) {
      const code = d.example[0].split(' · ').join('\n');
      expect(code, name).toMatch(new RegExp(`\\b${name}B?\\b`));
      const r = assemble(`${code}\n${labels}\nCOUNT: .WORD 0\n`, { symbols });
      expect(r.errors.map((e) => e.message), `${name}: ${code}`).toEqual([]);
    }
  });

  it('every ROM routine has an example that assembles; the maths examples give what they say', async () => {
    const { ROM_EXAMPLES } = await import('../src/ui/ReferenceBlue11');
    const { ROM_ROUTINES } = await import('../src/core/machine/rom');
    const { assemble } = await import('../src/blue11');
    const { predefinedSymbols } = await import('../src/core/machine/symbols');
    const { createDefaultRegistry } = await import('../src/core/WorldRegistry');
    const { rover, run, reg, HANG } = await import('./helpers/rover');
    const symbols = predefinedSymbols(createDefaultRegistry());
    expect(Object.keys(ROM_EXAMPLES).sort()).toEqual([...ROM_ROUTINES].sort());
    const lines = (n: string) => ROM_EXAMPLES[n][0].split(' · ').join('\n        ');
    for (const n of ROM_ROUTINES) {
      const r = assemble(`${lines(n)}\nSTUCK: HALT\nMSG: .ASCII /HI/\n`, { symbols });
      expect(r.errors.map((e) => e.message), n).toEqual([]);
      expect(ROM_EXAMPLES[n][0], n).toContain(`JSR PC, ${n}`);
    }
    for (const [n, r0, r1] of [['MUL16', 0o52, null], ['DIV16', 3, 3], ['ABS', 5, null]] as const) {
      const { e, u } = rover(`START:  ${lines(n)}${HANG}`);
      run(e, 10);
      expect(reg(u, 0), n).toBe(r0);
      if (r1 !== null) expect(reg(u, 1), n).toBe(r1);
    }
  });

  it('the I/O page tab\'s radar-by-hand example works', async () => {
    const { IO_DEVICE_EXAMPLE } = await import('../src/ui/ReferenceBlue11');
    const { rover, run, reg, HANG } = await import('./helpers/rover');
    const { Layer } = await import('../src/core/types');
    const { T } = await import('../src/core/WorldRegistry');
    const fw = `START:${IO_DEVICE_EXAMPLE.slice(6)}${HANG}\nFAILED: MOV #-1, R0${HANG.replace(/9\$/g, '8$')}`;
    const { e, u } = rover(fw, { flat: true, setup: (e) => e.world.setTile(2, 0, Layer.OBSTACLE, T.IRON_ORE) });
    run(e, 20);
    expect(reg(u, 0)).toBe(T.IRON_ORE);
  });

  it('every predefined system name has a meaning in the Symbols tab', async () => {
    const { symbolDocs } = await import('../src/ui/ReferenceBlue11');
    const { systemSymbols } = await import('../src/core/machine/names');
    const { IO_REGISTERS } = await import('../src/core/machine/iopage');
    const io = new Set(IO_REGISTERS.map((r) => r.name));
    const docs = symbolDocs();
    const missing = Object.keys(systemSymbols()).filter((k) => !io.has(k) && !(docs[k] ?? '').match(/\w/));
    expect(missing).toEqual([]);
  });

  it('the Tools, Image and Radio step-by-step examples work on a rover', async () => {
    const { TOOL_EXAMPLE, READ_PIXEL_EXAMPLE } = await import('../src/ui/ReferencePanel');
    const { RADIO_EXAMPLE } = await import('../src/ui/ReferenceBlue11');
    const { rover, run, reg, HANG } = await import('./helpers/rover');
    const { Layer, Status } = await import('../src/core/types');
    const { T } = await import('../src/core/WorldRegistry');
    const { MsgType } = await import('../src/core/messages');
    const fail = `\nFAILED: MOV #-1, R0${HANG.replace(/9\$/g, '8$')}`;
    // Drill the ore to the east.
    const t = rover(`START:${TOOL_EXAMPLE.slice(5)}${HANG}${fail}`, { flat: true, setup: (e) => e.world.setTile(1, 0, Layer.OBSTACLE, T.IRON_ORE) });
    run(t.e, 40);
    expect(reg(t.u, 0)).toBe(Status.OK);
    expect(t.u.cargo).toContain(T.IRON_ORE);
    // Read back pixels PLOT drew: (10, 3) light grey next to a white (11, 3).
    const plot = (x: number, g: number) => `MOV #${x}., R0\n MOV #3, R1\n MOV #${g}, R2\n JSR PC, PLOT\n`;
    const read = READ_PIXEL_EXAMPLE.split('\n').slice(1).join('\n');
    for (const [x, g] of [[10, 2], [11, 3], [12, 0]]) {
      const p = rover(`START: JSR PC, ERASE\n ${plot(10, 2)} ${plot(11, 3)} MOV #${x}., R0\n MOV #3, R1\n${read}${HANG}`);
      run(p.e, 60);
      expect(reg(p.u, 2), `pixel ${x}`).toBe(g);
    }
    // Send "HI" home.
    const r = rover(`START:${RADIO_EXAMPLE.slice(5).replace('      ...\n', `${HANG}\nFULL: HALT\n`)}`);
    run(r.e, 30, true);
    const text = r.e.messages.find((m) => m.type === MsgType.TEXT && m.status === 'ok');
    expect(text && String.fromCharCode(...text.body)).toBe('HI');
  });

  it('every Modes and Flags example assembles', async () => {
    const { MODE_DOC, PC_MODE_DOC, MODE_PATTERNS, FLAG_DOC } = await import('../src/ui/ReferenceBlue11');
    const { assemble } = await import('../src/blue11');
    const { predefinedSymbols } = await import('../src/core/machine/symbols');
    const { createDefaultRegistry } = await import('../src/core/WorldRegistry');
    const symbols = predefinedSymbols(createDefaultRegistry());
    const examples = [...MODE_DOC, ...PC_MODE_DOC, ...FLAG_DOC].map((d) => d.example[0]).concat(MODE_PATTERNS.map(([c]) => c));
    expect(examples.length).toBe(22);
    for (const ex of examples) {
      const r = assemble(`${ex.split(' · ').join('\n')}\nCOUNT: .WORD 0\nPTR: .WORD COUNT\nTABLE: .WORD 1, 2\n`, { symbols });
      expect(r.errors.map((e) => e.message), ex).toEqual([]);
    }
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
