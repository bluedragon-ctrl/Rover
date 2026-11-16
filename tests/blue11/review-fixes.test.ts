import { describe, expect, it } from 'vitest';
import { assemble, disassemble, SimpleMachine } from '../../src/blue11';
import { o, runAsm, words } from './helpers';

const err = (src: string): string => assemble(src).errors.map((e) => e.message).join('\n');

describe('blue11 library: review fixes', () => {
  it('a byte write to the high byte of a device register leaves its low byte alone', () => {
    const m = new SimpleMachine();
    const csrs = { RCSR: o('177560'), XCSR: o('177564'), LKS: o('177546') };
    for (const a of Object.values(csrs)) {
      expect(m.write(a, 0o300, false)).toBe(true); // interrupts on (LKS keeps DONE)
      expect(m.write(a + 1, 0o377, true)).toBe(true); // MOVB to the high byte
    }
    expect(m.read(csrs.RCSR, false) & 0o100).toBe(0o100);
    expect(m.read(csrs.XCSR, false) & 0o100).toBe(0o100);
    expect(m.read(csrs.LKS, false) & 0o300).toBe(0o300);
    expect(m.write(o('177567'), 0o101, true)).toBe(true); // XBUF high byte: prints nothing
    expect(m.output).toBe('');
    // Odd bytes of addresses nobody answers still fault.
    expect(m.write(o('177571'), 0, true)).toBe(false);
  });

  it('host word access at the top of RAM stays inside it', () => {
    const m = new SimpleMachine({ memory: 0o1001 });
    m.write(0o1000, 0o177777, false);
    expect(m.read(0o1000, true)).toBe(0o377);
    expect(Number.isNaN(m.read(0o1000, false))).toBe(false);
    expect(m.read(0o777, false)).toBe(m.read(0o776, false));
  });

  it('SOB refuses offset 0 (a jump to the next instruction)', () => {
    expect(err(' SOB R1, X\nX: HALT')).toMatch(/backwards/);
    expect(words(' SOB R1, .')).toEqual([0o077101]);
  });

  it('WAIT with only keyboard interrupts sleeps out the budget in one go', () => {
    const src = ` MOV #2000, SP\n MOV #100, @#177560\n WAIT\n HALT`;
    const { m, result } = runAsm(src, { budget: 50000 });
    expect(result.reason).toBe('wait');
    expect(result.cycles).toBe(50000);
    expect(m.cycles).toBe(50000);
  });

  it('CLC!CLV-style combinations assemble and round-trip through the disassembler', () => {
    expect(words(' CLC!CLV')).toEqual([0o000243]);
    expect(words(' SEN ! SEZ ; comment')).toEqual([0o000274]);
    for (let w = 0o000241; w < 0o000300; w++) {
      if (w === 0o000260) continue;
      const text = disassemble(() => w, 0).text;
      expect(words(` ${text}`), text).toEqual([w]);
    }
    expect(err(' CLC!SEV')).toMatch(/cannot be combined/);
    expect(err(' CLC!HALT')).toMatch(/only flag operations/);
    expect(err(' CLC!CLV R0')).toMatch(/no operands/);
    expect(words(' MOV #1!2, R0')).toEqual([0o012700, 3]);
  });
});
