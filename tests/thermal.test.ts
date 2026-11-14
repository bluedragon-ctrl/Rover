import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { ambientTemp, solarGain } from '../src/core/Environment';
import { migrate, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import type { Unit } from '../src/core/Unit';

const B = BALANCE;

function rover(firmware: string, seed = 7): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed });
  const u = e.spawnUnit('t');
  expect(e.upload(u, firmware, { factory: true }).errors).toEqual([]);
  return { e, u };
}

function until(e: SimulationEngine, cond: () => boolean, max = 5000): void {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    e.advanceTick();
  }
  throw new Error('condition never held');
}

describe('thermal model (SPEC §3.3.4)', () => {
  it('ambient is linear in the light: night -80 °C, full sun +20 °C', () => {
    expect(ambientTemp(0)).toBe(B.ambientNightC);
    expect(ambientTemp(100)).toBe(B.ambientDayC);
    expect(ambientTemp(40)).toBe(B.heaterSetpointC);
  });

  it('a new rover starts at the ambient; it cools slowly after sunset and the heaters hold -40 °C', () => {
    const { e, u } = rover('MOV r0 @TEMP\nMOV r1 @HEATER\nSLEEP 1');
    expect(u.temp).toBe(ambientTemp(e.sun.light));
    until(e, () => e.sun.elevation <= 0);
    u.temp = 10; // a warm rover at nightfall (thermal inertia: no jump to the ambient)
    for (let i = 0; i < 40; i++) e.advanceTick();
    expect(u.temp).toBe(0); // 1 °C per thermalTicksPerDeg = 4 ticks
    expect(u.heater).toBe(0);
    until(e, () => u.heater === 1);
    expect(u.temp).toBe(B.heaterSetpointC);
    for (let i = 0; i < 200; i++) e.advanceTick();
    expect(u.temp).toBe(B.heaterSetpointC);
    expect(u.vm.regs[0]).toBe(B.heaterSetpointC); // @TEMP
    expect(u.vm.regs[1]).toBe(1); // @HEATER
  });

  it('heaters cost heaterPerTick on top of the idle drain', () => {
    const { e, u } = rover('SLEEP 30000');
    until(e, () => u.heater === 1);
    const before = u.energy;
    for (let i = 0; i < 100; i++) e.advanceTick();
    expect(before - u.energy).toBe(100 * (B.idleDrainPerTick + B.heaterPerTick));
  });

  it('heaters stop once the morning sun warms the ambient above the setpoint', () => {
    const { e, u } = rover('SLEEP 30000');
    until(e, () => u.heater === 1);
    until(e, () => e.sun.elevation > 0);
    until(e, () => u.heater === 0);
    expect(ambientTemp(e.sun.light)).toBeGreaterThanOrEqual(B.heaterSetpointC);
    expect(e.sun.elevation).toBeGreaterThan(0);
  });

  it('a rover without power gets as cold as the night; powered again, the heaters warm it', () => {
    const { e, u } = rover('SLEEP 30000');
    until(e, () => e.sun.elevation <= 0);
    u.energy = 1;
    e.advanceTick();
    expect(u.powered).toBe(false);
    until(e, () => u.temp === B.ambientNightC);
    expect(u.heater).toBe(0);
    e.admin.forceCharge(u); // cold boot at night
    e.advanceTick();
    expect(u.heater).toBe(1);
    const cold = u.temp;
    for (let i = 0; i < 40; i++) e.advanceTick();
    expect(u.temp - cold).toBe(10); // warming 1 °C per 4 ticks toward -40
  });

  it('an eclipse cools the rover', () => {
    const { e, u } = rover('SLEEP 30000');
    for (let i = 0; i < 50; i++) e.advanceTick();
    u.temp = 10;
    e.director.triggerNow('ECLIPSE');
    for (let i = 0; i < 150; i++) e.advanceTick();
    expect(u.temp).toBeLessThan(-15);
  });
});

describe('dust on the solar array (SPEC §3.3.4)', () => {
  const OPEN = 'MOV @SOLAR_OPEN 1\nloop: MOV @SOLAR_ANGLE @SUN_AZIMUTH\nMOV r0 @SOLAR_DUST\nSLEEP 10\nJMP loop';

  it('builds up 1 % per dustTicks while the array is open, and scales charging', () => {
    const { e, u } = rover(OPEN);
    for (let i = 0; i < 4 * B.dustTicks + 30; i++) e.advanceTick();
    expect(u.solarDust).toBe(4);
    until(e, () => u.vm.regs[0] === u.solarDust, 20);
    u.solarDust = 50;
    e.advanceTick();
    const clean = Math.floor((solarGain(u.solarAngle, e.sun) * u.solarHealth * u.chassis.solarPercent) / 10_000);
    expect(clean).toBeGreaterThan(10);
    expect(u.lastSolarGain).toBe(Math.floor((solarGain(u.solarAngle, e.sun) * 100 * 100 * 50) / 1_000_000));
    expect(u.lastSolarGain).toBeLessThanOrEqual(Math.ceil(clean / 2));
  });

  it('a stowed array collects none; folding the array shakes off half', () => {
    const { e, u } = rover('SLEEP 30000');
    for (let i = 0; i < 3 * B.dustTicks; i++) e.advanceTick();
    expect(u.solarDust).toBe(0);
    const r = rover('MOV @SOLAR_OPEN 1\nSLEEP 40\nMOV @SOLAR_OPEN 0\nSLEEP 30000');
    r.u.solarDust = 31;
    for (let i = 0; i < 70; i++) r.e.advanceTick();
    expect(r.u.solarStowed).toBe(true);
    expect(r.u.solarDust).toBe(31 - Math.ceil((31 * B.dustShedPercent) / 100));
  });

  it('a dust squall dusts an open array; admin repair cleans it', () => {
    const { e, u } = rover('MOV @SOLAR_OPEN 1\nSLEEP 30000');
    for (let i = 0; i < 25; i++) e.advanceTick();
    e.director.triggerNow('DUST_SQUALL');
    for (let i = 0; i < 70; i++) e.advanceTick();
    expect(u.solarDust).toBeGreaterThanOrEqual(25);
    e.admin.forceRepair(u);
    expect(u.solarDust).toBe(0);
  });
});

describe('save v16 migration', () => {
  it('v15 saves get a clean array, nothing armed and the ambient temperature', () => {
    const { e } = rover('SLEEP 100');
    for (let i = 0; i < 10; i++) e.advanceTick();
    const v15 = JSON.parse(JSON.stringify(serialize(e)));
    v15.version = 15;
    for (const u of v15.units) for (const k of ['wdt', 'preempt', 'thermal', 'dust']) delete u[k];
    const m = migrate(v15).units[0];
    expect(m.wdt).toBe(0);
    expect(m.preempt).toEqual([0, 0, 0]);
    expect(m.dust).toBe(0);
    expect(m.thermal).toEqual([ambientTemp(e.env.sun(e.tick).light), 0]);
  });
});
