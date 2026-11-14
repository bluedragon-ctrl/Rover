import { describe, expect, it } from 'vitest';
import { CHASSIS_MK1 } from '../src/core/balance';
import { PORT_CODES, PORTS } from '../src/core/ports';
import { DEFAULT_FIRMWARE, FACTORY_IDLE, PROGRAM_TEMPLATES, TEMPLATES } from '../src/core/programs';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { compile, romLabels, type Program } from '../src/core/vm/Compiler';
import { decodeProgram, encodeInstr, EXT_OPCODE_NUMBERS, EXT_PREFIX, formatAddr, OPCODE_NUMBERS, OPCODES, opcodeHex } from '../src/core/vm/isa';
import { createDefaultRegistry } from '../src/core/WorldRegistry';

const consts = createDefaultRegistry().constants();
const hex = (b: number[]) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const prog = (src: string, slot: 'firmware' | 'program' = 'firmware'): Program => {
  const r = compile(src, CHASSIS_MK1, consts, { slot });
  expect(r.errors).toEqual([]);
  return r.program!;
};
const bytesOf = (src: string) => hex(prog(src).code);

describe('machine code (SPEC §5.7.1)', () => {
  it('has fixed opcode numbers: MOV 01 … RET 11, WAIT 12 and LDF 13 (M14 reused two freed numbers), LOG 19, BRK 1A, END 1C', () => {
    const base = OPCODES.filter((op) => !(op in EXT_OPCODE_NUMBERS));
    expect(Object.fromEntries(base.map((op) => [op, OPCODE_NUMBERS[op]]))).toEqual({
      MOV: 0x01, PUSH: 0x02, POP: 0x03, ADD: 0x04, SUB: 0x05, MUL: 0x06, DIV: 0x07, MOD: 0x08,
      JMP: 0x09, JEQ: 0x0a, JNE: 0x0b, JLT: 0x0c, JGT: 0x0d, JLE: 0x0e, JGE: 0x0f, CALL: 0x10, RET: 0x11,
      WAIT: 0x12, LDF: 0x13, LOG: 0x19, BRK: 0x1a, END: 0x1c, LDB: 0x1d, STB: 0x1e,
    });
  });

  it('gives every instruction exactly one opcode; LDB 1D, STB 1E, 1F is the extension prefix', () => {
    for (const op of OPCODES) expect((OPCODE_NUMBERS[op] === undefined) !== (EXT_OPCODE_NUMBERS[op] === undefined)).toBe(true);
    const base = Object.values(OPCODE_NUMBERS);
    expect(Math.max(...base)).toBe(0x1e);
    expect([OPCODE_NUMBERS.LDB, OPCODE_NUMBERS.STB]).toEqual([0x1d, 0x1e]);
    expect(Object.keys(EXT_OPCODE_NUMBERS)).toEqual(['AND', 'OR', 'SHL', 'SHR']); // M14: SEND, ERASE (05, 06) and LDF (07) left
    expect(EXT_PREFIX).toBe(0x1f);
    expect([EXT_OPCODE_NUMBERS.AND, EXT_OPCODE_NUMBERS.OR, EXT_OPCODE_NUMBERS.SHL, EXT_OPCODE_NUMBERS.SHR]).toEqual([1, 2, 3, 4]);
    expect(opcodeHex('AND')).toBe('1F 01');
    expect(opcodeHex('ADD')).toBe('04');
  });

  it('encodes bit instructions with a 2-byte opcode and decodes them back', () => {
    const src = 'AND r0 3\nOR r1 @POST\nSHL r2 r0\nSHR r3 -1';
    expect(bytesOf(src)).toBe('1F 01 10 03 1F 02 11 74 1F 03 12 10 1F 04 13 18 FF'.replace('74', hex([0x40 | PORT_CODES.indexOf('POST')])));
    const p = prog(src);
    expect(p.instrs.map((i) => i.size)).toEqual([4, 4, 4, 5]);
    expect(p.code.length).toBe(17);
    const back = decodeProgram(p.code, p.codeBytes);
    expect(back.map((i) => i.op)).toEqual(['AND', 'OR', 'SHL', 'SHR']);
    expect(back.map((i) => i.addr)).toEqual([0, 4, 8, 12]);
    expect(back[3].args).toEqual([{ k: 'reg', i: 3 }, { k: 'imm', v: -1 }]);
  });

  it('counts the 2-byte opcode for label addresses', () => {
    const p = prog('AND r0 1\nhere: JMP here');
    expect(bytesOf('AND r0 1\nhere: JMP here')).toBe('1F 01 10 01 09 00 04');
    expect(p.instrs[1].addr).toBe(4);
  });

  it('rejects an unknown extended opcode', () => {
    expect(() => decodeProgram([0x1f, 0x7f])).toThrow(/Unknown opcode/);
  });

  it('gives every port a unique fixed number 0–63', () => {
    const live = PORT_CODES.filter((n) => n !== '');
    expect(new Set(live).size).toBe(live.length);
    expect(PORT_CODES.length).toBeLessThanOrEqual(64);
    expect([...live].sort()).toEqual(PORTS.map((p) => p.name).sort());
    // Retired ports keep their numbers: the old status beacon was 0x21/0x22.
    expect([PORT_CODES[33], PORT_CODES[34], PORT_CODES[35]]).toEqual(['', '', 'IND1']);
    expect(PORT_CODES[0]).toBe('BAT');
  });

  it('encodes the SPEC example: JLE @BAT 20 home with home at 0x2A', () => {
    const pad = Array.from({ length: 14 }, () => 'MOV r0 r1').join('\n'); // 14 × 3 B = 0x2A
    const p = prog(`JLE @BAT 20 home\n${pad}\nhome: RET`);
    expect(p.labels.HOME).toBe(0x2a + 6);
    expect(hex(encodeInstr({ op: 'JLE', args: [{ k: 'port', name: 'BAT' }, { k: 'imm', v: 20 }, { k: 'label', target: 0x2a, name: 'HOME' }] }))).toBe('0E 40 18 14 00 2A');
  });

  it('uses the operand byte modes: short imm, register, port, 8/16/32-bit immediates', () => {
    expect(bytesOf('MOV r0 15')).toBe('01 10 0F');
    expect(bytesOf('MOV r3 r1')).toBe('01 13 11');
    expect(bytesOf('MOV @POST -1')).toBe(`01 ${(0x40 | PORT_CODES.indexOf('POST')).toString(16).toUpperCase()} 18 FF`);
    expect(bytesOf('MOV r0 300')).toBe('01 10 19 01 2C');
    expect(bytesOf('MOV r0 -32768')).toBe('01 10 19 80 00');
    expect(bytesOf('MOV r0 100000')).toBe('01 10 1A 00 01 86 A0');
    expect(bytesOf('MOV r0 -100000')).toBe('01 10 1A FF FE 79 60');
  });

  it('counts optional operands in the top bits of the opcode byte', () => {
    expect(bytesOf('LOG 2')).toBe('19 02');
    expect(bytesOf('LOG 2 r0')).toBe('39 02 10');
    expect(bytesOf('f: CALL f 1 2 r0')).toBe('70 00 00 01 02 10');
    const step = romLabels().STEP; // a ROM routine is a label at 0xF000 and up
    expect(bytesOf('CALL STEP 1 2')).toBe(`50 ${hex([step >> 8, step & 255])} 01 02`);
    expect(hex(prog('END', 'program').code)).toBe('1C');
    expect(hex(prog('END 1', 'program').code)).toBe('3C 01');
    expect(decodeProgram([0x19, 0x02, 0x39, 0x02, 0x10]).map((d) => d.args.length)).toEqual([1, 2]);
  });

  it('limits CALL to 7 arguments (3 bits in the opcode byte)', () => {
    const r = compile('f: CALL f 1 2 3 4 5 6 7 8', CHASSIS_MK1, consts);
    expect(r.errors[0].message).toMatch(/at most 7 args/);
    expect(compile('f: CALL f 1 2 3 4 5 6 7', CHASSIS_MK1, consts).errors).toEqual([]);
  });

  it('labels are byte addresses; each slot starts at 0x000', () => {
    const p = prog('MOV r0 1\nloop: ADD r0 300\nJMP loop');
    expect(p.labels.LOOP).toBe(3);
    expect(p.instrs.map((i) => i.addr)).toEqual([0, 3, 8]);
    expect(p.lineToIp).toEqual({ 1: 0, 2: 3, 3: 8 });
    expect(formatAddr(0x2a, 'firmware')).toBe('fw:0x02A');
    expect(formatAddr(0x10, 'program')).toBe('prog:0x010');
  });

  const shipped: [string, string, 'firmware' | 'program'][] = [
    ['DEFAULT_FIRMWARE', DEFAULT_FIRMWARE, 'firmware'],
    ['FACTORY_IDLE', FACTORY_IDLE, 'firmware'],
    ...Object.entries(TEMPLATES).map(([n, s]): [string, string, 'firmware'] => [`firmware template ${n}`, s, 'firmware']),
    ...Object.entries(PROGRAM_TEMPLATES).map(([n, s]): [string, string, 'program'] => [`program ${n}`, s, 'program']),
  ];
  it.each(shipped)('decodes %s back to the compiled instructions, sizes = instrBytes', (_name, src, slot) => {
    const r = compile(src, CHASSIS_MK1, consts, { slot });
    expect(r.errors).toEqual([]);
    const p = r.program!;
    expect(p.code.length).toBe(r.flashUsed);
    for (const ins of p.instrs) expect(ins.size).toBe(r.lineBytes[ins.line]);
    const strip = (args: Program['instrs'][number]['args']) => args.map((a) => (a.k === 'label' ? { k: 'label', target: a.target } : a));
    expect(decodeProgram(p.code, p.codeBytes).map((d) => ({ op: d.op, args: strip(d.args), addr: d.addr, size: d.size }))).toEqual(
      p.instrs.map((i) => ({ op: i.op, args: strip(i.args), addr: i.addr, size: i.size })),
    );
  });

  it('rejects invalid machine code', () => {
    expect(() => decodeProgram([0x00])).toThrow(/Unknown opcode/);
    expect(() => decodeProgram([0x01, 0x10])).toThrow(/Truncated/);
    expect(() => decodeProgram([0x01, 0x10, 0x30])).toThrow(/Invalid operand/);
  });
});

describe('byte addresses in the VM', () => {
  it('CALL pushes the byte address after the CALL; RET returns there', () => {
    const e = new SimulationEngine({ seed: 3 });
    const u = e.spawnUnit('t');
    e.upload(u, 'MOV r0 300\nCALL f\nCALL SLEEP 100\nf: BRK\nRET', { factory: true });
    e.advanceTick();
    expect(u.vm.callStack).toEqual([5 + 3]);
    expect(u.vm.nextIp).toBe(5 + 3 + 5 + 1); // after the BRK (CALL SLEEP 100: opcode, label, 100)
    expect(u.vm.nextLine).toBe(5);
  });
});

describe('save v11', () => {
  it('converts v10 instruction-index IPs and return addresses to byte addresses', () => {
    const src = 'MOV r0 300\nloop: CALL f\nMOV @TIMER 2\nWAIT @TIMER\nJMP loop\nf: ADD r0 1\nMOV @TIMER 1\nWAIT @TIMER\nRET';
    const make = () => {
      const e = new SimulationEngine({ seed: 5 });
      e.upload(e.spawnUnit('t'), src, { factory: true });
      return e;
    };
    const a = make();
    for (let i = 0; i < 30; i++) a.advanceTick();
    const b0 = make();
    for (let i = 0; i < 13; i++) b0.advanceTick();
    const u0 = b0.units[0];
    expect(u0.vm.callStack.length).toBe(1); // saved inside f
    // Rewrite the snapshot the way v10 stored it: instruction indices.
    const snap = JSON.parse(JSON.stringify(serialize(b0)));
    const idx = (addr: number) => u0.vm.program!.indexAt.get(addr) ?? u0.vm.program!.instrs.length;
    snap.version = 10;
    snap.units[0].vm.ip = idx(snap.units[0].vm.ip);
    snap.units[0].vm.callStack = snap.units[0].vm.callStack.map(idx);
    expect(snap.units[0].vm.callStack).toEqual([2]);
    const b = deserialize(snap);
    expect(b.units[0].vm.callStack).toEqual(u0.vm.callStack);
    for (let i = 0; i < 17; i++) b.advanceTick();
    expect(serialize(b)).toEqual(serialize(a));
  });
});

describe('listing (SPEC §5.7.1)', async () => {
  const { buildListing, listingText } = await import('../src/ui/listing');
  it('shows address | hex | source per slot, continues long instructions, skips comments', () => {
    const src = '; demo\nCONST BIG 100000\nstart: MOV r0 BIG ; 7 B\nhome:\n  JLE @BAT 20 home\nEND 1';
    const res = compile(src, CHASSIS_MK1, consts, { slot: 'program' });
    const l = buildListing(src, res, 'program');
    expect(l.ok).toBe(true);
    expect(l.bytes).toBe(7 + 6 + 2);
    expect(listingText(l)).toBe(
      [
        '                              CONST BIG 100000',
        'prog:0x000 01 10 1A 00 01 86  start: MOV r0 BIG',
        'prog:0x006 A0',
        'prog:0x007                    home:',
        'prog:0x007 0E 40 18 14 00 07  JLE @BAT 20 home',
        'prog:0x00D 3C 01              END 1',
      ].join('\n'),
    );
  });

  it('still lists a slot with errors, with estimated sizes and unknown bytes', () => {
    const src = 'MOV r0 1\nFOO r1\nJMP nowhere';
    const res = compile(src, CHASSIS_MK1, consts);
    const l = buildListing(src, res, 'firmware');
    expect(l.ok).toBe(false);
    expect(l.rows.map((r) => [r.addr, r.size, !!r.error])).toEqual([
      [0, 3, false],
      [3, 2, true],
      [5, 3, true],
    ]);
    expect(listingText(l).split('\n')[2]).toBe('fw:0x005   ?? ?? ??           JMP nowhere');
  });
});
