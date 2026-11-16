import { describe, expect, it } from 'vitest';
import { assemble } from '../../src/blue11';
import { runAsm, words } from './helpers';

const msgs = (src: string) => assemble(src).errors.map((e) => e.message);
const warns = (src: string) => assemble(src).warnings.map((e) => [e.line, e.message]);

describe('blue11 assembler: implicit .WORD', () => {
  it('an expression where the instruction goes is a word', () => {
    expect(words(' 1234')).toEqual([0o1234]);
    expect(words(" 'A, -1, <2+3>*2")).toEqual([0o101, 0o177777, 10]);
    expect(words('X = 7\n X, X+1')).toEqual([7, 8]);
    expect(words('T: .\n HALT')).toEqual([0o1000, 0]);
  });

  it('instruction names have their opcode as value', () => {
    expect(words(' MOV #NOP, R0')).toEqual([0o012700, 0o240]);
    expect(words('TBL: HALT\n WAIT\n CLC!CLV\n .WORD MOV+27')).toEqual([0, 1, 0o243, 0o10027]);
    // An instruction name first on the line is always the instruction.
    expect(msgs(' WAIT, 1')).toEqual(['WAIT takes no operands']);
    expect(words(' .WORD BR+2')).toEqual([0o000402]);
  });

  it('forward references and labels work as data lines', () => {
    const { cpu } = runAsm(`
        MOV PTR, R0
        MOV (R0), R1
        HALT
PTR:    DATA
DATA:   777`);
    expect(cpu.r[1]).toBe(0o777);
  });

  it('a typo stays an unknown instruction, data errors say what is wrong', () => {
    expect(msgs(' MOVV R0, R1')).toEqual(['unknown instruction MOVV']);
    expect(msgs(' FOO')).toEqual(['unknown instruction FOO (for data, use .WORD)']);
    expect(msgs(' FOO ; comment')).toEqual(['unknown instruction FOO (for data, use .WORD)']);
    expect(msgs(' FOO+1')).toEqual(['undefined symbol FOO']);
    expect(msgs(' 1, FOO')).toEqual(['undefined symbol FOO']);
    expect(msgs(' .BYTE 1\n 2')).toEqual([expect.stringMatching(/odd address/)]);
  });

  it('clears and sets still may not be mixed (the original assembler would quietly make it a set)', () => {
    expect(msgs(' CLC!SEV')).toEqual([expect.stringMatching(/cannot be combined/)]);
  });
});

describe('blue11 assembler warnings', () => {
  it('are separate from errors and do not stop the program', () => {
    const a = assemble('X = 200000\n MOV #X, R0\n HALT');
    expect(a.ok).toBe(true);
    expect(a.warnings.map((w) => w.message)).toEqual(["200000 doesn't fit 16 bits: X = 000000"]);
    expect(a.warnings[0].line).toBe(1);
  });

  it('a symbol named like an instruction', () => {
    expect(warns('HALT: BR HALT')).toEqual([[1, 'HALT is also an instruction; as a value it now means this label']]);
    expect(warns('NOP = 5')).toEqual([[1, 'NOP is also an instruction; as a value it now means this symbol']]);
    expect(words('NOP = 5\n MOV #NOP, R0\n NOP')).toEqual([0o012700, 5, 0o240]);
    expect(warns('1$: BR 1$\nLOOP: BR LOOP')).toEqual([]);
  });
});
