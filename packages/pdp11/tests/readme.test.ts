import { describe, expect, it } from 'vitest';
import { assemble, SimpleMachine } from '../src';

const README = (import.meta.glob('../README.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)['../README.md'];

describe('README', () => {
  it('the quick start program runs as documented', () => {
    const src = README.match(/const asm = assemble\(`([\s\S]*?)`, \{ symbols/)![1];
    const asm = assemble(src, { symbols: { XCSR: 0o177564, XBUF: 0o177566 } });
    expect(asm.errors).toEqual([]);
    const m = new SimpleMachine();
    m.boot(asm);
    expect(m.run(10_000).reason).toBe('halt');
    expect(m.output).toBe('HELLO');
  });
});
