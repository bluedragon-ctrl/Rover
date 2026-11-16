import { describe, expect, it } from 'vitest';
import { FRAMES, HOST_PROGRAM, LAMP, TinyHost } from '../examples/host';

describe('examples/host.ts: hosting the CPU in your own machine', () => {
  it('runs the README program: a device register, a host clock, TRAP served by the host', () => {
    const h = new TinyHost();
    expect(h.load(HOST_PROGRAM).errors).toEqual([]);
    for (let i = 0; i < 40 && !h.cpu.halted; i++) h.frame(100);
    expect(h.cpu.halted).toBe(true);
    expect(h.printed).toEqual([4, 8, 12, 16]); // octal 20 = 16
    expect(h.lamp).toBe(16);
    expect(h.read(FRAMES, false)).toBe(h.frames);
  });

  it('a write to a read-only register is a bus error (trap to 4)', () => {
    const h = new TinyHost();
    h.load(`START: MOV #ERR, @#4\n MOV #340, @#6\n MOV #1, @#FRAMES\n HALT\nERR: MOV #7, @#LAMP\n HALT`);
    h.frame(100);
    expect(h.lamp).toBe(7);
    expect(LAMP).toBe(0o170000);
  });
});
