import { describe, expect, it } from 'vitest';
import { assemble } from '../../src/blue11';

/** README "Assembler compatibility": every claim there is checked here (from the abandoned PR 40). */
const ok = (src: string) => {
  const r = assemble(src);
  expect(r.errors, src).toEqual([]);
  return r;
};
const fails = (src: string, re: RegExp) => expect(assemble(src).errors[0]?.message ?? 'no error', src).toMatch(re);
const word = (src: string, at = 0) => {
  const r = ok(src);
  return r.bytes[at] | (r.bytes[at + 1] << 8);
};

describe('assembler compatibility', () => {
  it('statement format, case, operand spacing', () => {
    expect(ok('start: mov r0,r1 ; comment').bytes).toEqual(ok('START:  MOV  R0, R1').bytes);
  });

  it('numbers, radix prefixes, characters, complement', () => {
    expect(word(' .WORD 10')).toBe(8);
    expect(word(' .WORD 10.')).toBe(10);
    expect(word(' .WORD ^D10')).toBe(10);
    expect(word(' .WORD ^B101')).toBe(5);
    expect(word(' .WORD ^O17')).toBe(15);
    expect(word(" .WORD 'A")).toBe(65);
    expect(word(' .WORD "AB')).toBe(65 | (66 << 8));
    expect(word(' .WORD ^C0')).toBe(0xffff);
  });

  it('strict left-to-right evaluation, < > grouping, & and !', () => {
    expect(word(' .WORD 1+2*3')).toBe(9);
    expect(word(' .WORD 1+<2*3>')).toBe(7);
    expect(word(' .WORD 17&5!40')).toBe(0o45);
  });

  it('assignment, register symbols, the location counter, global forms', () => {
    expect(ok('N = 5\nN2 == 6\nX = %2\nA:: CLR X\n. = . + 10\nB: BR .+4').symbols.get('B')).toBe(0o1000 + 2 + 8);
  });

  it('local labels live between two ordinary labels', () => {
    ok('L: \n1$: BR 1$\nM:\n1$: BR 1$');
    fails('L: HALT\n1$: BR L\nM: BR 1$', /undefined symbol 1\$/);
  });

  it('.END expr sets the start and ends the source', () => {
    const r = ok('S: HALT\nT: HALT\n.END T\n THIS IS NOT ASSEMBLED');
    expect(r.start).toBe(r.symbols.get('T'));
  });

  it('differences: long names and values that do not fit are errors', () => {
    fails('COUNTER1: HALT', /at most 6 characters/);
    expect(assemble('COUNTER_1: HALT', { names: 'long' }).ok).toBe(true);
    fails(' .BYTE 400', /doesn't fit in a byte/);
    fails(' TRAP 400', /0–377/);
  });

  it('predefined symbols: not as a label; a direct assignment may reassign one', () => {
    expect(assemble('XCSR: HALT', { symbols: { XCSR: 0o177564 } }).errors[0]?.message).toMatch(/predefined symbol/);
    const r = assemble('XCSR = 1\n .WORD XCSR', { symbols: { XCSR: 0o177564 } });
    expect(r.ok).toBe(true);
    expect(r.bytes[0]).toBe(1);
  });

  it('not supported: an error, never silently ignored', () => {
    for (const d of ['.MACRO FOO', '.MCALL X', '.IRP', '.REPT 3', '.NARG', '.IF EQ 0', '.IIF EQ 0, HALT', '.PSECT', '.CSECT', '.ASECT', '.GLOBL X', '.LIMIT', '.RADIX 10', '.RAD50 /ABC/', '.REM', '.PRINT', '.FLT2 1.0'])
      expect(assemble(' ' + d).ok, d).toBe(false);
    fails(' .WORD ^RABC', /unknown \^R/);
  });

  it('listing control directives are accepted and ignored', () => {
    expect(ok(' .TITLE T\n .SBTTL S\n .IDENT /1/\n .ENABL LC\n .DSABL GBL\n .LIST\n .NLIST\n .PAGE\n HALT').bytes.length).toBe(2);
  });
});
