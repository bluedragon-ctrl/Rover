import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Status } from '../src/core/types';

function setup(src: string) {
  const eng = new SimulationEngine({ seed: 1 });
  const u = eng.spawnUnit('t');
  const r = eng.upload(u, src);
  expect(r.errors).toEqual([]);
  return { eng, u };
}

describe('RoverVM', () => {
  it('runs up to cyclesPerTick compute instructions per tick', () => {
    const { eng, u } = setup('ADD r0 1');
    eng.advanceTick();
    expect(u.vm.regs[0]).toBe(4);
  });

  it('wraps to line 0 at end of program', () => {
    const { eng, u } = setup('ADD r0 1\nADD r1 1');
    eng.advanceTick();
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([2, 2]);
  });

  it('does arithmetic with 32-bit wrap and Euclidean MOD', () => {
    const { eng, u } = setup('MOV r0 -1\nMOD r0 4\nMOV r1 2147483647\nADD r1 1');
    eng.advanceTick();
    expect(u.vm.regs[0]).toBe(3);
    expect(u.vm.regs[1]).toBe(-2147483648);
  });

  it('DIV truncates and divide-by-zero sets ERR_INVALID', () => {
    const { eng, u } = setup('MOV r0 -7\nDIV r0 2\nMOV r1 5\nDIV r1 0');
    eng.advanceTick();
    expect(u.vm.regs[0]).toBe(-3);
    expect(u.vm.regs[1]).toBe(0);
    expect(u.vm.status).toBe(Status.ERR_INVALID);
  });

  it('handles conditional jumps', () => {
    const { eng, u } = setup('top: JGE r0 3 done\nADD r0 1\nJMP top\ndone: MOV r1 r0\nSLEEP 1000');
    for (let i = 0; i < 5; i++) eng.advanceTick();
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([3, 3]);
    expect(eng.compileFor(u, 'JMP 0').errors[0].message).toMatch(/Unknown label/);
  });

  it('CALL pushes args, RET returns', () => {
    const { eng, u } = setup('CALL f 7 9\nMOV r3 1\nSLEEP 1000\nf: POP r0\nPOP r1\nRET');
    eng.advanceTick(); // CALL, POP, POP, RET
    eng.advanceTick(); // MOV r3, SLEEP
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[3]]).toEqual([9, 7, 1]);
    expect(u.vm.state).toBe(CpuState.BLOCKED);
  });

  it('faults on stack overflow and the watchdog reboots', () => {
    const { eng, u } = setup('ADD r1 1\nPUSH 1');
    for (let i = 0; i < 5; i++) eng.advanceTick();
    expect(u.vm.state).toBe(CpuState.FAULT);
    expect(u.vm.faultReason).toMatch(/overflow/);
    for (let i = 0; i < BALANCE.watchdogTicks; i++) eng.advanceTick();
    expect(u.vm.state).toBe(CpuState.RUNNING);
  });

  it('RET with empty call stack faults', () => {
    const { eng, u } = setup('RET');
    eng.advanceTick();
    expect(u.vm.state).toBe(CpuState.FAULT);
  });

  it('SLEEP blocks for exactly N ticks', () => {
    const { eng, u } = setup('SLEEP 3\nADD r0 1\nSLEEP 1000');
    eng.advanceTick(); // SLEEP issued at tick 1
    eng.advanceTick();
    eng.advanceTick();
    expect(u.vm.regs[0]).toBe(0);
    eng.advanceTick(); // tick 4: unblocked
    expect(u.vm.regs[0]).toBe(1);
  });

  it('writes ports with clamping', () => {
    const { eng, u } = setup('MOV @LIGHT_COLOR 99\nSLEEP 100');
    eng.advanceTick();
    expect(u.lightColor).toBe(4);
  });

  it('stepInstruction executes one instruction at a time, across blocked ticks', () => {
    const { eng, u } = setup('ADD r0 1\nSLEEP 5\nADD r0 10');
    eng.stepInstruction(u);
    expect(u.vm.regs[0]).toBe(1);
    eng.stepInstruction(u); // SLEEP
    const t = eng.tick;
    eng.stepInstruction(u); // waits out the sleep, then ADD
    expect(u.vm.regs[0]).toBe(11);
    expect(eng.tick - t).toBe(5);
  });

  it('upload performs a hard reboot but keeps physical state', () => {
    const { eng, u } = setup('MOV r0 5\nPUSH 1\nSLEEP 100');
    eng.advanceTick();
    u.energy = 1234;
    eng.upload(u, 'SLEEP 1');
    expect(u.vm.regs[0]).toBe(0);
    expect(u.vm.dataStack).toEqual([]);
    expect(u.energy).toBe(1234);
  });
});
