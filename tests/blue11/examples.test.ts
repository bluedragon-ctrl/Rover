import { describe, expect, it } from 'vitest';
import { assemble, SimpleMachine } from '../../src/blue11';
import { EXAMPLES, SIM_SYMBOLS } from '../../src/simulator/examples';
import { uncommentedLines } from '../helpers/comments';

describe('simulator examples', () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))('%s assembles and runs', (_name, ex) => {
    const asm = assemble(ex.source, { symbols: SIM_SYMBOLS });
    expect(asm.errors).toEqual([]);
    const m = new SimpleMachine({ eis: ex.eis });
    m.boot(asm);
    for (const ch of ex.input ?? '') m.type(ch);
    const r = m.run(2_000_000);
    expect(r.reason).toBe('halt');
    expect(m.output).toBe(ex.expect);
  });

  it.each(EXAMPLES.map((e) => [e.name, e] as const))('%s has a comment on every instruction', (_name, ex) => {
    expect(uncommentedLines(ex.source)).toEqual([]);
  });

  it('the addressing-modes tour ends with the documented registers', () => {
    const ex = EXAMPLES.find((e) => e.name.startsWith('Addressing'))!;
    const asm = assemble(ex.source, { symbols: SIM_SYMBOLS });
    const m = new SimpleMachine();
    m.boot(asm);
    m.run(1000);
    const tab = asm.symbols.get('TAB')!;
    expect(m.cpu.r.slice(0, 6)).toEqual([7, tab, tab, 7, 1, 7]);
  });
});
