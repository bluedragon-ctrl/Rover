import { describe, expect, it } from 'vitest';
import { BootReason } from '../src/core/downlink';
import { PDP_DEFAULT_FIRMWARE, PDP_PROGRAM_TEMPLATES } from '../src/core/programs-pdp11';
import { MsgType } from '../src/core/messages';
import { deserialize, serialize } from '../src/core/SaveManager';
import type { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Preempt, ProgState } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { factory, fw, HANG, rover as base, run, sleep } from './helpers/rover';

const WEATHER = PDP_PROGRAM_TEMPLATES['Weather station'];

function rover(firmware: string, program?: string, seed = 7): { e: SimulationEngine; u: Unit } {
  return base(firmware, { seed, setup: (e, u) => {
    if (program !== undefined) expect(e.uploadProgram(u, program, factory).errors).toEqual([]);
  } });
}

function until(e: SimulationEngine, cond: () => boolean, max = 3000): number {
  for (let i = 0; i < max; i++) {
    if (cond()) return i;
    run(e, 1, true);
  }
  throw new Error('condition never held');
}

/** Count the watchdog-timeout reboots of a rover. */
function watch(u: Unit, e: SimulationEngine): () => number {
  let n = 0;
  e.events.on('LOG', (m) => {
    if (m.unitId === u.id && /Watchdog timeout/.test(m.message)) n++;
  });
  return () => n;
}

describe('watchdog WDT (SPEC §3.9.5)', () => {
  it('is not armed after boot: firmware that never kicks it runs on', () => {
    const { e, u } = rover('START:  BR   START');
    const timeouts = watch(u, e);
    run(e, 2000);
    expect(u.wdt).toBe(0);
    expect(timeouts()).toBe(0);
  });

  it('reboots a hung firmware n ticks after the last kick, with boot reason 5, and disarms', () => {
    const { e, u } = rover('START:  MOV  #30., @#WDT\n1$:     BR   1$');
    until(e, () => u.wdt === 30, 10);
    const armedAt = e.tick;
    until(e, () => u.bootReason === BootReason.WDT_TIMEOUT, 100);
    expect(e.tick - armedAt).toBe(30);
    expect(u.wdt).toBe(0); // disarmed by the reboot (until the firmware arms it again)
    expect(BootReason.WDT_TIMEOUT).toBe(5);
  });

  it('a firmware that keeps kicking is never reset; writing 0 does not disarm it', () => {
    const { e, u } = rover(`START:\n1$:     MOV  #30., @#WDT\n        CLR  @#WDT\n        ${sleep(20)}\n        BR   1$`);
    const timeouts = watch(u, e);
    run(e, 1000);
    expect(timeouts()).toBe(0);
    expect(u.wdt).toBeGreaterThan(0); // the 0 write was ignored
  });

  it('a hard reboot disarms it; a kick with a smaller value shortens it', () => {
    const { e, u } = rover(fw('MOV  #500., @#WDT', sleep(5), 'MOV  #10., @#WDT'));
    until(e, () => u.wdt === 500, 10);
    run(e, 8);
    expect(u.wdt).toBeLessThanOrEqual(10);
    expect(u.wdt).toBeGreaterThan(0);
    until(e, () => u.bootReason === BootReason.WDT_TIMEOUT, 20);
    e.upload(u, `START:${HANG}`, factory); // hard reboot
    expect(u.wdt).toBe(0);
  });

  it('BPT freezes it, like a debugger', () => {
    const { e, u } = rover(fw('MOV  #20., @#WDT', 'BPT'));
    const timeouts = watch(u, e);
    run(e, 200);
    expect(u.cpu.state).toBe(CpuState.HALTED);
    expect(u.wdt).toBe(20);
    expect(timeouts()).toBe(0);
  });

  it('keeps counting through a program run; limited runs bring the firmware back in time', () => {
    const prog = `START:  ${sleep(300)}\n        MOV  #1, R0\n        HALT`;
    const loop = (ticks: number) => `START:\n1$:     MOV  #100., @#WDT\n        MOV  #${ticks}., R0\n        JSR  PC, RUN\n        WAIT\n        BR   1$`;
    const { e, u } = rover(loop(10), prog);
    const timeouts = watch(u, e);
    until(e, () => u.progState === ProgState.PROG_DONE, 400);
    expect(timeouts()).toBe(0); // the slice timer brought the firmware back every 10 ticks
    // A run without a time limit (SLICE 0) trusts the program: then the watchdog catches it.
    const s = rover(loop(0), prog);
    const st = watch(s.u, s.e);
    const t = until(s.e, () => st() > 0, 400);
    expect(t).toBeGreaterThan(100);
    expect(s.u.progState).toBe(ProgState.PROG_READY); // the reboot made the program ready again
  });

  it('the default firmware arms it and keeps it fed through charging, idling and slices', () => {
    const { e, u } = rover(PDP_DEFAULT_FIRMWARE, WEATHER);
    const timeouts = watch(u, e);
    run(e, 6000); // 2.5 sols: nights, charging, sleeping programs
    expect(u.wdt).toBeGreaterThan(0);
    expect(timeouts()).toBe(0);
    expect(u.powered).toBe(true);
  });
});

describe('fault protection PREMPT (SPEC §3.9.2)', () => {
  it('a reboot switches fault protection off', () => {
    const { e, u } = rover(fw('MOV  #7, @#PREMPT', 'MOV  #40., @#BATALM'));
    run(e, 6);
    expect([u.preemptMask, u.batAlarm]).toEqual([7, 40]);
    e.upload(u, `START:${HANG}`, factory);
    expect([u.preemptMask, u.batAlarm, u.preempted]).toEqual([0, 0, 0]);
  });

  it('the default firmware stops the Weather station for an alert and logs why (L.PRE)', () => {
    const { e, u } = rover(PDP_DEFAULT_FIRMWARE, WEATHER);
    run(e, 30, true);
    e.director.triggerNow('PARTIAL_ECLIPSE');
    until(e, () => u.preempted !== 0, 50);
    expect(u.preempted).toBe(Preempt.PRE_ALERT);
    until(e, () => e.messages.some((m) => m.type === MsgType.LOG && m.body[0] === 12 && m.body[1] === Preempt.PRE_ALERT), 300); // L.PRE = 12
  });

  it('round-trips an armed watchdog, fault protection and the thermal state at night', () => {
    const make = () => rover(PDP_DEFAULT_FIRMWARE, WEATHER, 3).e;
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
