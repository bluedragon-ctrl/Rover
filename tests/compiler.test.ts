import { describe, expect, it } from 'vitest';
import { CHASSIS_MK1 } from '../src/core/balance';
import { compile, immBytes } from '../src/core/vm/Compiler';
import { DEMO_EXPLORER, TEMPLATES } from '../src/core/programs';
import { createDefaultRegistry } from '../src/core/WorldRegistry';

const c = (src: string) => compile(src, CHASSIS_MK1, createDefaultRegistry().constants());

describe('Compiler', () => {
  it('compiles the demo firmware within the Flash budget', () => {
    const r = c(DEMO_EXPLORER);
    expect(r.errors).toEqual([]);
    expect(r.flashUsed).toBeLessThanOrEqual(CHASSIS_MK1.flashBytes);
  });

  it('does not count comments, label definitions, ALIAS and CONST against Flash', () => {
    const r = c('; hi\nALIAS r0 x\nCONST N 3\n\nstart:\nMOV x N ; set\nJMP start');
    expect(r.errors).toEqual([]);
    expect(r.flashUsed).toBe(3 + 3); // MOV reg short-imm, JMP label
    expect(r.lineBytes).toEqual({ 6: 3, 7: 3 });
    expect(r.program!.labels.START).toBe(0);
  });

  it('resolves constants, hex, negatives and tile names', () => {
    const r = c('MOV r0 0x10\nMOV r1 -5\nMOV r2 EAST\nMOV r3 IRON_ORE');
    expect(r.program!.instrs.map((i) => i.args[1])).toEqual([
      { k: 'imm', v: 16 },
      { k: 'imm', v: -5 },
      { k: 'imm', v: 1 },
      { k: 'imm', v: 11 },
    ]);
  });

  it('is case-insensitive and accepts commas and -> sugar', () => {
    const r = c('Loop: scan north -> R0, r1\njmp LOOP');
    expect(r.errors).toEqual([]);
  });

  it('rejects registers beyond the chassis', () => {
    expect(c('MOV r4 1').errors[0].message).toMatch(/r4 does not exist/);
  });

  it('rejects writes to read-only ports and unknown ports', () => {
    expect(c('MOV @BAT 5').errors[0].message).toMatch(/read-only/);
    expect(c('MOV r0 @NOPE').errors[0].message).toMatch(/Unknown port/);
  });

  it('reports unknown labels, names and bad arity with line numbers', () => {
    const r = c('MOV r0 1\nJMP nowhere\nADD r0\nFOO r1');
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });

  it('sizes operands like machine code', () => {
    const size = (line: string) => c(`x: ${line}`).flashUsed;
    expect(size('RET')).toBe(1);
    expect(size('MOV r0 r1')).toBe(3);
    expect(size('MOV @LIGHT_COLOR RED')).toBe(3); // port 1, constant 1 = short immediate
    expect(size('MOV r0 15')).toBe(3);
    expect(size('MOV r0 16')).toBe(4);
    expect(size('MOV r0 -1')).toBe(4);
    expect(size('MOV r0 1000')).toBe(5);
    expect(size('MOV r0 100000')).toBe(7);
    expect(size('JLE @BAT 20 x')).toBe(6);
    expect(size('CALL x 1 r0')).toBe(1 + 2 + 1 + 1);
    expect(c('CONST BIG 300\nMOV r0 BIG').flashUsed).toBe(5); // a constant costs its value
    expect([0, 15, 16, -1, 127, -128, 128, -129, 32767, -32768, 32768].map(immBytes)).toEqual([1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 5]);
  });

  it('estimates the size of lines with errors', () => {
    const r = c('MOV r0 nowhere\nJMP missing\nFOO r1 5');
    expect(r.errors.length).toBe(3);
    expect(r.lineBytes).toEqual({ 1: 4, 2: 3, 3: 3 });
  });

  it('enforces the Flash limit in bytes and points at the first line that does not fit', () => {
    const fits = Array.from({ length: 32 }, () => 'ADD r0 100').join('\n'); // 4 B each
    expect(c(fits).flashUsed).toBe(128);
    expect(c(fits).errors).toEqual([]);
    const r = c(fits + '\nRET');
    expect(r.errors).toEqual([{ line: 33, message: 'Program is 129 bytes; Rover Mk-I has 128 bytes of Flash' }]);
  });

  it('ships every template within the Mk-I Flash', () => {
    for (const [name, src] of Object.entries(TEMPLATES)) {
      const r = c(src);
      expect(r.errors, name).toEqual([]);
      expect(r.flashUsed, name).toBeLessThanOrEqual(CHASSIS_MK1.flashBytes);
    }
  });

  it('rejects name clashes', () => {
    expect(c('ALIAS r0 north').errors.length).toBe(1);
    expect(c('CONST a 1\nCONST A 2').errors.length).toBe(1);
  });

  it('allows labels on the same line as an instruction', () => {
    const r = c('a: MOV r0 1\nb: JMP a');
    expect(r.program!.labels).toEqual({ A: 0, B: 1 });
  });
});
