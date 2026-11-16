import { describe, expect, it } from 'vitest';
import { assemble, BUS_ERROR, DeviceMachine, KW11L, SimpleMachine, type Cpu, type Device } from '../../src/blue11';
import { o, runAsm, words } from './helpers';

/** A test peripheral: a counter register and a timer that interrupts after `delay` cycles. */
class Timer implements Device {
  readonly size = 4;
  count = 0;
  resets: boolean[] = [];
  private cpu!: Cpu;
  private left = Infinity;
  constructor(readonly base: number, private readonly delay: number) {}
  attach(cpu: Cpu): void { this.cpu = cpu; }
  read(offset: number): number { return offset === 0 ? 0o1234 | (0o56 << 8) : BUS_ERROR; }
  write(offset: number, value: number, byte: boolean): boolean {
    if (offset !== 0 || byte) return false;
    this.count = value;
    this.left = this.delay; // start the timer
    return true;
  }
  reset(powerUp: boolean): void { this.resets.push(powerUp); this.left = Infinity; }
  advance(cycles: number): void {
    this.left -= cycles;
    if (this.left <= 0) { this.left = Infinity; this.cpu.interrupt(0o300, 5); }
  }
  nextEvent(): number { return this.left; }
  wakeIn(): number { return this.left; }
  canWake(): boolean { return this.left !== Infinity; }
}

const boot = (m: DeviceMachine, src: string) => {
  const a = assemble(src);
  if (!a.ok) throw new Error(a.errors.map((e) => e.message).join('\n'));
  m.boot(a);
  return a;
};

describe('blue11 DeviceMachine', () => {
  it('routes reads and writes to devices; byte reads take half the word', () => {
    const t = new Timer(o('170000'), 100);
    const m = new DeviceMachine().add(t);
    expect(m.read(o('170000'), false)).toBe(0o1234 | (0o56 << 8));
    expect(m.read(o('170000'), true)).toBe(0o1234 & 0xff);
    expect(m.read(o('170001'), true)).toBe(0o56);
    expect(m.read(o('170002'), false)).toBe(BUS_ERROR);
    expect(m.read(o('170004'), false)).toBe(BUS_ERROR);
    expect(m.write(o('170000'), 7, false)).toBe(true);
    expect(t.count).toBe(7);
  });

  it('refuses overlapping or misplaced devices', () => {
    const m = new DeviceMachine().add(new Timer(o('170000'), 1));
    expect(() => m.add(new Timer(o('170002'), 1))).toThrow(/overlaps another device/);
    expect(() => m.add(new Timer(o('150000'), 1))).toThrow(/overlaps RAM/);
    expect(() => m.add(new Timer(o('170001'), 1))).toThrow(/even/);
    expect(() => m.add(new Timer(o('177774'), 1))).toThrow(/PSW/);
  });

  it('a sleeping CPU wakes on a device interrupt; RESET and boot reach the devices', () => {
    const t = new Timer(o('170000'), 500);
    const m = new DeviceMachine().add(t);
    boot(m, `
        MOV #ISR, @#300
        MOV #240, @#302
        RESET
        MOV #5, @#170000   ; start the timer
        WAIT
        HALT
ISR:    INC R1
        RTI`);
    const r = m.run(10000);
    expect(r.reason).toBe('halt');
    expect(m.cpu.r[1]).toBe(1);
    expect(m.cycles).toBeGreaterThanOrEqual(500);
    expect(m.cycles).toBeLessThan(600);
    expect(t.resets).toEqual([true, false]);
  });

  it('WAIT with no device able to wake it stops at once', () => {
    const m = new DeviceMachine().add(new Timer(o('170000'), 500));
    boot(m, ' WAIT\n HALT');
    expect(m.run(10000)).toMatchObject({ reason: 'wait' });
    expect(m.cycles).toBeLessThan(10);
  });

  it('the line clock counts every tick missed in a long sleep once', () => {
    const k = new KW11L(10);
    const m = new SimpleMachine({ clockCycles: 10 });
    expect(m.clock.cycles).toBe(10);
    k.attach(m.cpu);
    k.write(0, 0, false); // clear DONE
    k.advance(9);
    expect(k.read() & 0o200).toBe(0);
    k.advance(25); // 3 ticks late
    expect(k.read() & 0o200).toBe(0o200);
    expect(k.nextEvent()).toBe(6);
  });
});

describe('blue11 Cpu.onInstruction', () => {
  it('sees every instruction once, with its address and first word', () => {
    const a = assemble(`
        MOV #3, R0
1$:     DEC R0
        BNE 1$
        HALT`);
    const m = new SimpleMachine();
    m.boot(a);
    const seen: Array<[number, number]> = [];
    m.cpu.onInstruction = (pc, op) => seen.push([pc, op]);
    const r = m.run(1000);
    expect(r.instructions).toBe(seen.length);
    expect(seen[0]).toEqual([0o1000, 0o012700]);
    expect(seen.filter(([pc]) => pc === 0o1004)).toHaveLength(3);
    expect(seen.at(-1)).toEqual([0o1010, 0]);
  });
});

describe('blue11 assembler ^X (opt-in)', () => {
  it('is an error by default, a hexadecimal number with hex: true', () => {
    expect(assemble(' .WORD ^XFF').errors[0].message).toMatch(/not standard syntax/);
    expect(words(' .WORD ^XFF, ^x1f+1', { hex: true })).toEqual([0xff, 0x20]);
    expect(words(' MOV #^X8000, R0', { hex: true })).toEqual([0o012700, 0x8000]);
    expect(assemble(' .WORD ^XG', { hex: true }).errors[0].message).toMatch(/hexadecimal digits/);
  });

  it('leaves standard programs alone', () => {
    const { cpu } = runAsm(' MOV #^D10, R0\n HALT', { asm: { hex: true } });
    expect(cpu.r[0]).toBe(10);
  });
});
