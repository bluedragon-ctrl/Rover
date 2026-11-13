import { describe, expect, it } from 'vitest';
import { CHASSIS_MK1 } from '../src/core/balance';
import { BootReason, encodeLog, hex, SYSTEM_TAG } from '../src/core/downlink';
import { DEFAULT_FIRMWARE, FIRMWARE_FAULT_PROTECTION, PROGRAM_TEMPLATES } from '../src/core/programs';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Preempt, ProgState, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { builtinConstants, compile } from '../src/core/vm/Compiler';
import { createDefaultRegistry } from '../src/core/WorldRegistry';

const factory = { factory: true };
const consts = createDefaultRegistry().constants();

/** Keep the dish on the orbiter before every tick, so frames reach mission control. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

function rover(firmware: string, program?: string, seed = 7): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  expect(e.upload(u, firmware, factory).errors).toEqual([]);
  if (program !== undefined) expect(e.uploadProgram(u, program, factory).errors).toEqual([]);
  return { e, u };
}

function until(e: SimulationEngine, cond: () => boolean, max = 3000): number {
  for (let i = 0; i < max; i++) {
    if (cond()) return i;
    run(e, 1);
  }
  throw new Error('condition never held');
}

/** Boot frames mission control received with this reason. */
const boots = (e: SimulationEngine, reason: number) => e.received.filter((f) => hex(f.bytes) === hex(encodeLog(SYSTEM_TAG, reason))).length;

describe('compiler: fault-protection ports are firmware-only', () => {
  const c = (src: string, slot: 'firmware' | 'program') => compile(src, CHASSIS_MK1, consts, { slot });

  it('a program may read @WDT, @PREEMPT, @BAT_ALARM, @PREEMPTED but not write the first three', () => {
    for (const p of ['WDT', 'PREEMPT', 'BAT_ALARM']) {
      expect(c(`MOV @${p} 5`, 'firmware').errors).toEqual([]);
      expect(c(`MOV @${p} 5`, 'program').errors[0].message).toBe(`Only the firmware may write @${p}`);
      expect(c(`MOV r0 @${p}`, 'program').errors).toEqual([]);
    }
    expect(c('MOV r0 @PREEMPTED', 'program').errors).toEqual([]);
    expect(c('MOV @PREEMPTED 1', 'firmware').errors.length).toBe(1); // read-only
    expect([builtinConstants().PRE_ALERT, builtinConstants().PRE_DAMAGE, builtinConstants().PRE_LOW_BAT, builtinConstants().ERR_PREEMPTED]).toEqual([1, 2, 4, 9]);
    expect(c('MOV @PREEMPT PRE_ALERT\nMOV @PREEMPT PRE_DAMAGE\nMOV @PREEMPT PRE_LOW_BAT', 'firmware').errors).toEqual([]);
    expect(c('JEQ @STATUS ERR_PREEMPTED x\nx: END', 'program').errors).toEqual([]);
  });
});

describe('watchdog @WDT (SPEC §3.9.5)', () => {
  it('is not armed after boot: old firmware that never kicks it runs on', () => {
    const { e, u } = rover('loop: JMP loop');
    run(e, 2000);
    expect(u.wdt).toBe(0);
    expect(boots(e, BootReason.WDT_TIMEOUT)).toBe(0);
  });

  it('reboots a hung firmware n ticks after the last kick, with boot reason 5, and disarms', () => {
    const { e, u } = rover('MOV r0 @TICK\nMOV @WDT 30\nhang: JMP hang');
    run(e, 1);
    expect(u.wdt).toBe(30);
    const armedAt = e.tick;
    until(e, () => u.vm.regs[0] !== armedAt && u.vm.regs[0] !== 0, 100); // rebooted and ran again
    expect(e.tick - armedAt).toBe(30);
    run(e, 40);
    expect(boots(e, BootReason.WDT_TIMEOUT)).toBeGreaterThanOrEqual(1);
    expect(BootReason.WDT_TIMEOUT).toBe(5);
  });

  it('a firmware that keeps kicking is never reset; writing 0 does not disarm it', () => {
    const { e, u } = rover('loop: MOV @WDT 30\nMOV @WDT 0\nSLEEP 20\nJMP loop');
    run(e, 1000);
    expect(boots(e, BootReason.WDT_TIMEOUT)).toBe(0);
    expect(u.wdt).toBeGreaterThan(0); // the 0 write was ignored
  });

  it('a hard reboot disarms it; a kick with a smaller value shortens it', () => {
    const { e, u } = rover('MOV @WDT 500\nSLEEP 5\nMOV @WDT 10\nSLEEP 1000');
    run(e, 1);
    expect(u.wdt).toBe(500);
    run(e, 6);
    expect(u.wdt).toBeLessThanOrEqual(10);
    until(e, () => boots(e, BootReason.WDT_TIMEOUT) > 0, 200);
    e.upload(u, 'SLEEP 1000', factory); // hard reboot
    expect(u.wdt).toBe(0);
  });

  it('BRK freezes it, like a debugger', () => {
    const { e, u } = rover('MOV @WDT 20\nBRK\nSLEEP 1000');
    run(e, 200);
    expect(u.vm.state).toBe(CpuState.HALTED);
    expect(u.wdt).toBe(20);
    expect(boots(e, BootReason.WDT_TIMEOUT)).toBe(0);
  });

  it('keeps counting through a program slice: a program that blocks too long starves the firmware', () => {
    const { e, u } = rover('loop: MOV @WDT 100\nRUN 10\nJMP loop', 'SLEEP 300\nEND');
    const t = until(e, () => boots(e, BootReason.WDT_TIMEOUT) > 0, 400);
    expect(t).toBeGreaterThan(100);
    expect(u.prog.state).not.toBe(CpuState.FAULT); // the reboot restarted the program
  });

  it('the default firmware arms it and keeps it fed through charging, idling and slices', () => {
    const { e, u } = rover(DEFAULT_FIRMWARE, PROGRAM_TEMPLATES['Weather station']);
    run(e, 6000); // 2.5 sols: nights, charging, SLEEP 100 inside slices
    expect(u.wdt).toBeGreaterThan(0);
    expect(boots(e, BootReason.WDT_TIMEOUT)).toBe(0);
    expect(u.powered).toBe(true);
  });
});

describe('fault protection @PREEMPT (SPEC §3.9.2)', () => {
  /**
   * Firmware: arm `mask`, run long slices, note @PREEMPTED in r0 and count slices in r1. It
   * RUNs again in the same tick, and RUN clears @PREEMPTED: so the tests look at r0.
   */
  const fw = (mask: string, extra = '') => `${extra}\nMOV @PREEMPT ${mask}\nloop: RUN 500\nMOV r0 @PREEMPTED\nADD r1 1\nJEQ @PROG_STATE PROG_READY loop\nSLEEP 1000`;

  it('PRE_ALERT: an announced event ends the slice at once and aborts the program\'s SLEEP', () => {
    const { e, u } = rover(fw('PRE_ALERT'), 'SLEEP 400\nMOV r1 @STATUS\nMOV r2 7\nEND 1');
    run(e, 20);
    expect(u.slice).toBeGreaterThan(0);
    expect(u.prog.state).toBe(CpuState.BLOCKED);
    e.director.triggerNow('PARTIAL_ECLIPSE'); // announced next tick
    run(e, 1);
    expect(u.vm.regs[0]).toBe(Preempt.PRE_ALERT); // the firmware got control in that tick
    expect(u.vm.regs[1]).toBe(1); // ...came back from RUN once...
    expect(u.slice).toBeGreaterThan(0); // ...and started a second slice
    expect(u.prog.status).toBe(Status.ERR_PREEMPTED);
    expect(u.prog.state).toBe(CpuState.RUNNING); // the SLEEP is gone
    until(e, () => u.progState === ProgState.PROG_DONE, 5); // resumed after the SLEEP
    expect(u.prog.regs[1]).toBe(Status.ERR_PREEMPTED);
    expect(u.prog.regs[2]).toBe(7);
    run(e, 1);
    expect(u.vm.regs[0]).toBe(0); // the second slice ended normally (END): nothing preempted it
  });

  it('without @PREEMPT the slice is cooperative: the SLEEP runs to the end', () => {
    const { e, u } = rover(fw('0'), 'SLEEP 400\nEND 1');
    run(e, 20);
    e.director.triggerNow('PARTIAL_ECLIPSE');
    run(e, 100);
    expect(u.slice).toBeGreaterThan(0);
    expect(u.preempted).toBe(0);
    expect(u.prog.state).toBe(CpuState.BLOCKED);
  });

  it('PRE_LOW_BAT: battery below @BAT_ALARM stops a long drive between tiles; the rover stays where it was', () => {
    const { e, u } = rover(fw('PRE_LOW_BAT', 'MOV @BAT_ALARM 50'), 'STEP EAST 2\nEND 1');
    u.energy = 50_000 + 10; // just above the alarm: the first tile's 40 energy crosses it
    run(e, 2); // tick 1: firmware RUNs; tick 2: the program starts the STEP (pays the tile)
    expect(u.action?.kind).toBe('STEP');
    run(e, 1); // tick 3: 49 % < 50 %: preempted before the rover arrives
    expect(u.vm.regs[0]).toBe(Preempt.PRE_LOW_BAT);
    expect(u.prog.status).toBe(Status.ERR_PREEMPTED);
    expect(u.action?.kind).not.toBe('STEP');
    expect(u.x).toBe(0); // the move was aborted before it arrived
    run(e, 20); // still below the alarm: every new slice ends at once, the program never runs
    expect(u.x).toBe(0);
    expect(u.progState).not.toBe(ProgState.PROG_DONE);
  });

  it('PRE_DAMAGE: a squall hit ends the slice', () => {
    const { e, u } = rover(fw('PRE_DAMAGE'), 'SLEEP 1000');
    run(e, 5);
    e.director.triggerNow('SQUALL');
    until(e, () => u.vm.regs[0] !== 0, 300);
    expect(u.vm.regs[0]).toBe(Preempt.PRE_DAMAGE);
    expect(u.hull + u.antennaHealth + u.solarHealth).toBeLessThan(300);
  });

  it('a reboot switches fault protection off', () => {
    const { e, u } = rover('MOV @PREEMPT 7\nMOV @BAT_ALARM 40\nSLEEP 1000');
    run(e, 2);
    expect([u.preemptMask, u.batAlarm]).toEqual([7, 40]);
    e.upload(u, 'SLEEP 1000', factory);
    expect([u.preemptMask, u.batAlarm, u.preempted]).toEqual([0, 0, 0]);
  });

  it('the Fault protection firmware stops the Weather station for an alert and logs why', () => {
    const { e, u } = rover(FIRMWARE_FAULT_PROTECTION, PROGRAM_TEMPLATES['Weather station']);
    run(e, 30);
    e.director.triggerNow('PARTIAL_ECLIPSE');
    until(e, () => u.preempted !== 0, 50);
    expect(u.preempted).toBe(Preempt.PRE_ALERT);
    until(e, () => e.received.some((f) => hex(f.bytes) === hex(encodeLog(12, Preempt.PRE_ALERT))), 200); // T_PREEMPT = 1
  });
});

describe('save v16', () => {
  it('round-trips an armed watchdog, fault protection and the thermal state at night', () => {
    const make = () => rover(FIRMWARE_FAULT_PROTECTION, PROGRAM_TEMPLATES['Weather station'], 3).e;
    const a = make();
    run(a, 2600);
    const b0 = make();
    run(b0, 1700); // night: heaters on
    const u = b0.units[0];
    expect(u.heater).toBe(1);
    expect(u.wdt).toBeGreaterThan(0);
    expect(u.preemptMask).not.toBe(0);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, 900);
    expect(serialize(b)).toEqual(serialize(a));
  });
});
