import { describe, expect, it } from 'vitest';
import { CHASSIS_MK1 } from '../src/core/balance';
import { compile } from '../src/core/vm/Compiler';
import { DEMO_EXPLORER } from '../src/core/programs';
import { createDefaultRegistry } from '../src/core/WorldRegistry';

const c = (src: string) => compile(src, CHASSIS_MK1, createDefaultRegistry().constants());

describe('Compiler', () => {
  it('compiles the demo firmware within the Flash budget', () => {
    const r = c(DEMO_EXPLORER);
    expect(r.errors).toEqual([]);
    expect(r.flashUsed).toBeLessThanOrEqual(CHASSIS_MK1.flashLines);
  });

  it('does not count comments, labels, ALIAS and CONST against Flash', () => {
    const r = c('; hi\nALIAS r0 x\nCONST N 3\n\nstart:\nMOV x N ; set\nJMP start');
    expect(r.errors).toEqual([]);
    expect(r.flashUsed).toBe(2);
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

  it('enforces the Flash limit', () => {
    const src = Array.from({ length: 33 }, () => 'ADD r0 1').join('\n');
    expect(c(src).errors[0].message).toMatch(/33 Flash lines/);
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
