import { describe, expect, it } from 'vitest';
import { assemble, disassemble, INSTRUCTIONS, octal, SimpleMachine } from '../../src/blue11';
import { runAsm, words } from './helpers';

const err = (src: string, opts = {}): string => {
  const a = assemble(src, opts);
  expect(a.ok).toBe(false);
  return a.errors[0].message;
};

describe('blue11 assembler: encoding', () => {
  it('the listing example of BLUE11_CPU.md §3.5', () => {
    const syms = { DRVCS: 0o176400, DRVDIR: 0o176404, DRVCNT: 0o176406, GO: 1 };
    const a = assemble(`
        CLR  R1
        MOV  #3, @#DRVCNT
        MOV  R1, @#DRVDIR
        MOV  #GO, @#DRVCS
2$:     TSTB @#DRVCS
        BMI  3$
        WAIT
        BR   2$
3$:     HALT`, { origin: 0o2000, symbols: syms });
    expect(a.errors).toEqual([]);
    const w: string[] = [];
    for (let i = 0; i < a.bytes.length; i += 2) w.push(octal(a.bytes[i] | (a.bytes[i + 1] << 8)));
    expect(w.slice(0, 15)).toEqual([
      '005001', '012737', '000003', '176406', '010137', '176404', '012737', '000001', '176400',
      '105737', '176400', '100402', '000001', '000773', '000000',
    ]);
    expect(a.listing).toContain('002002  012737 000003 176406');
  });

  it('every mode encodes as documented', () => {
    expect(words('MOV R1, R2')).toEqual([0o010102]);
    expect(words('MOV (R1), (R2)+')).toEqual([0o011122]);
    expect(words('MOV @(R1)+, -(SP)')).toEqual([0o013146]);
    expect(words('MOV @-(R1), 4(R2)')).toEqual([0o015162, 4]);
    expect(words('MOV @6(R1), @(R2)')).toEqual([0o017172, 6, 0]);
    expect(words('MOV @R1, R2')).toEqual([0o011102]);
  });

  it('relative addressing is PC-relative', () => {
    // at 1000: MOV X, R0 = 016700 <off>; off = X - 1004
    expect(words(' MOV X, R0\nX: .WORD 0')).toEqual([0o016700, 0, 0]);
    expect(words(' MOV @X, R0\n HALT\nX: .WORD 0')).toEqual([0o017700, 2, 0, 0]);
  });

  it('every instruction in the table assembles and disassembles to itself', () => {
    for (const op of INSTRUCTIONS) {
      let line: string;
      switch (op.format) {
        case 'double': line = `${op.name} R1, (R2)+`; break;
        case 'single': line = op.name === 'JMP' ? 'JMP (R3)' : `${op.name} -(R3)`; break;
        case 'jsr': line = 'JSR R5, @(R4)+'; break;
        case 'rts': line = 'RTS R5'; break;
        case 'xor': line = 'XOR R1, R2'; break;
        case 'regsrc': line = `${op.name} R1, R2`; break;
        case 'branch': line = `${op.name} .`; break;
        case 'sob': line = 'SOB R1, .'; break;
        case 'trap': line = `${op.name} 7`; break;
        default: line = op.name;
      }
      const w = words(line);
      const d = disassemble((a) => w[(a - 0o1000) / 2] ?? 0, 0o1000);
      expect(d.words.length, line).toBe(w.length);
      const expected = op.name === 'BHIS' ? 'BCC' : op.name === 'BLO' ? 'BCS' : op.name;
      expect(d.text.split(' ')[0], line).toBe(expected);
      // Reassemble the disassembly: same words.
      expect(words(d.text.replace(/\b0*(\d+)\b/g, '$1')), d.text).toEqual(w);
    }
  });
});

describe('blue11 assembler: numbers, expressions, symbols', () => {
  it('octal by default, a trailing dot for decimal, ^D ^O ^B, characters', () => {
    expect(words('.WORD 20, 20., ^D20, ^O20, ^B101, \'A, "AB')).toEqual([16, 20, 20, 16, 5, 65, 0x4241]);
    expect(err('.WORD 19')).toMatch(/not octal.*19\./);
  });

  it('expressions run left to right; < > groups', () => {
    expect(words('.WORD 2+3*4, 2+<3*4>, 10-1&6, 1!2, ^C0, -1')).toEqual([20, 14, 6, 3, 0xffff, 0xffff]);
  });

  it('symbols, register symbols, the location counter', () => {
    const a = assemble(`
N = 5
DIR = %1
        MOV #N, DIR
HERE:   .WORD .
        . = . + 10
END:    .WORD END-HERE`);
    expect(a.errors).toEqual([]);
    expect(a.symbols.get('N')).toBe(5);
    expect(a.symbols.has('DIR')).toBe(false);
    const w = words('N = 5\nDIR = %1\n MOV #N, DIR');
    expect(w).toEqual([0o012701, 5]);
    expect(a.symbols.get('END')! - a.symbols.get('HERE')!).toBe(0o12);
  });

  it('forward references', () => {
    expect(words(' MOV #LATER, R0\nLATER = 7')).toEqual([0o012700, 7]);
  });

  it('local labels belong to the routine between two labels', () => {
    const a = assemble(`
A:      BR 1$
1$:     BR A
B:      BR 1$
1$:     HALT`);
    expect(a.errors).toEqual([]);
    expect(words('A: BR 1$\n1$: BR A\nB: BR 1$\n1$: HALT')).toEqual([0o000400, 0o000776, 0o000400, 0]);
  });

  it('predefined symbols, case-insensitive', () => {
    expect(words('mov @#bat, r0', { symbols: { BAT: 0o177000 } })).toEqual([0o013700, 0o177000]);
  });

  it('DEC names: at most 6 characters, no "_"; long names on request', () => {
    expect(err('TOOLONG: HALT')).toMatch(/at most 6 characters/);
    expect(err('A_B = 1')).toMatch(/"_"/);
    expect(err(' MOV #ERR_BLOCKED, R0', { symbols: { ERR_BLOCKED: 1 } })).toMatch(/"_"/);
    expect(assemble('ERR_BLOCKED = 1\nLONGLABEL: MOV #ERR_BLOCKED, R0', { names: 'long' }).ok).toBe(true);
  });
});

describe('blue11 assembler: directives', () => {
  it('.BYTE, .ASCII, .ASCIZ, .EVEN, .BLKW, .BLKB', () => {
    const a = assemble(`
        .BYTE 1, 377, -1
        .ASCII /AB;C/<15><12>  ; a comment
        .ASCIZ "x"
        .EVEN
        .BLKW 2
        .BLKB 3
        .EVEN
W:      .WORD 1`);
    expect(a.errors).toEqual([]);
    expect([...a.bytes.slice(0, 12)]).toEqual([1, 255, 255, 65, 66, 59, 67, 13, 10, 120, 0, 0]);
    expect(a.symbols.get('W')).toBe(0o1000 + 12 + 4 + 4);
  });

  it('.END sets the start address and stops', () => {
    const a = assemble(' .WORD 0\nGO: HALT\n .END GO\n garbage here');
    expect(a.ok).toBe(true);
    expect(a.start).toBe(0o1002);
  });

  it('the source line map', () => {
    const a = assemble('; comment\n CLR R0\n\n MOV #1, R1\n HALT');
    expect([...a.lineAt]).toEqual([[0o1000, 2], [0o1002, 4], [0o1006, 5]]);
  });
});

describe('blue11 assembler: errors are values with line and column', () => {
  it('reports them', () => {
    const a = assemble(' CLR R0\n FOO R1\n MOV R1\n BR NOWHR');
    expect(a.errors.map((e) => [e.line, e.message])).toEqual([
      [2, 'unknown instruction FOO'],
      [3, 'MOV takes two operands: src, dst'],
      [4, 'undefined symbol NOWHR'],
    ]);
    expect(a.errors[2].column).toBe(5);
  });

  it('branch range, odd addresses, duplicates, registers as values', () => {
    const far = assemble(' BR X\n .BLKW 200\nX: HALT');
    expect(far.errors.map((e) => e.message)).toEqual(['branch target too far (128 words; the limit is −128…127, use JMP)']);
    expect(err(' .BYTE 1\n CLR R0')).toMatch(/odd address/);
    expect(err('A: HALT\nA: HALT')).toMatch(/defined twice/);
    expect(err(' MOV #R1, R0')).toMatch(/register/);
    expect(err(' JMP R1')).toMatch(/not a register/);
    expect(err(' SOB R1, X\n HALT\nX: HALT')).toMatch(/backwards/);
    expect(err('.BYTE 400')).toMatch(/byte/);
  });
});

describe('blue11 disassembler', () => {
  it('shows targets as absolute addresses or names', () => {
    const w = words(' BR X\n MOV @#X, R0\n JSR PC, X\nX: HALT');
    const read = (a: number): number => w[(a - 0o1000) / 2] ?? 0;
    expect(disassemble(read, 0o1000).text).toBe('BR 001012');
    expect(disassemble(read, 0o1002).text).toBe('MOV @#001012, R0');
    expect(disassemble(read, 0o1006, { nameOf: (a) => (a === 0o1012 ? 'X' : undefined) }).text).toBe('JSR PC, X');
    expect(disassemble(() => 0o000243, 0).text).toBe('CLC!CLV');
    expect(disassemble(() => 0o000007, 0).text).toBe('.WORD 000007');
  });
});

describe('blue11 programs from the design (BLUE11_CPU.md §9)', () => {
  const MUL16 = `
MUL16:  MOV  R2, -(SP)
        CLR  R2
1$:     TST  R1
        BEQ  3$
        CLC
        ROR  R1
        BCC  2$
        ADD  R0, R2
2$:     ASL  R0
        BR   1$
3$:     MOV  R2, R0
        MOV  (SP)+, R2
        RTS  PC`;
  const DIV16 = `
DIV16:  TST  R1
        BNE  1$
        SEC
        RTS  PC
1$:     MOV  R2, -(SP)
        MOV  R3, -(SP)
        MOV  R1, R2
        CLR  R1
        MOV  #16., R3
2$:     ASL  R0
        ROL  R1
        BCS  4$
        CMP  R1, R2
        BLO  3$
4$:     SUB  R2, R1
        INC  R0
3$:     SOB  R3, 2$
        MOV  (SP)+, R3
        MOV  (SP)+, R2
        CLC
        RTS  PC`;

  it.each([[7, 9], [123, 100], [0, 55], [255, 255], [1000, 65]])('MUL16 %i × %i', (a, b) => {
    const { cpu } = runAsm(` MOV #${a}., R0\n MOV #${b}., R1\n MOV #77, R2\n JSR PC, MUL16\n HALT\n${MUL16}`);
    expect(cpu.r[0]).toBe((a * b) & 0xffff);
    expect(cpu.r[2]).toBe(0o77);
  });

  it.each([[100, 7], [65535, 10], [5, 9], [40000, 1], [65535, 65535]])('DIV16 %i / %i', (a, b) => {
    const { cpu } = runAsm(` MOV #${a}., R0\n MOV #${b}., R1\n JSR PC, DIV16\n HALT\n${DIV16}`);
    expect(cpu.r[0]).toBe(Math.floor(a / b));
    expect(cpu.r[1]).toBe(a % b);
    expect(cpu.c).toBe(false);
  });

  it('DIV16 by zero sets C', () => {
    const { cpu } = runAsm(` MOV #5, R0\n CLR R1\n JSR PC, DIV16\n HALT\n${DIV16}`);
    expect(cpu.c).toBe(true);
    expect(cpu.r[0]).toBe(5);
  });

  it('MUL16 × 100. costs about 65 cycles (§9.1)', () => {
    const a = runAsm(` MOV #3, R0\n MOV #100., R1\n JSR PC, MUL16\n HALT\n${MUL16}`);
    const cycles = a.result.cycles - 2 - 2 - 1; // the two MOVs and HALT
    expect(cycles).toBeGreaterThan(50);
    expect(cycles).toBeLessThan(90);
  });

  it('hello world on the console', () => {
    const { m } = runAsm(`
        MOV #MSG, R1
1$:     MOVB (R1)+, R0
        BEQ 3$
2$:     TSTB @#177564         ; transmitter ready?
        BPL 2$
        MOVB R0, @#177566
        BR 1$
3$:     HALT
MSG:    .ASCIZ /HELLO, WORLD/`);
    expect(m.output).toBe('HELLO, WORLD');
  });

  it('echoes keyboard input with interrupts', () => {
    const a = assemble(`
        MOV #RX, @#60
        MOV #200, @#62
        MOV #100, @#177560    ; receiver interrupts on
1$:     WAIT
        BR 1$
RX:     MOVB @#177562, @#177566
        RTI`);
    const m = new SimpleMachine();
    m.boot(a);
    m.run(100);
    m.type('h'); m.type('i');
    m.run(1000);
    expect(m.output).toBe('hi');
  });
});
