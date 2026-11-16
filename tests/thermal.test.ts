import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { ambientTemp, solarGain } from '../src/core/Environment';
import { fw, HANG, reg, rover, sleep, sreg, until } from './helpers/rover';

const B = BALANCE;
const IDLE = `START:${HANG}`;

describe('thermal model (SPEC §3.3.4)', () => {
  it('ambient is linear in the light: night -80 °C, full sun +20 °C', () => {
    expect(ambientTemp(0)).toBe(B.ambientNightC);
    expect(ambientTemp(100)).toBe(B.ambientDayC);
    expect(ambientTemp(40)).toBe(B.heaterSetpointC);
  });

  it('a new rover starts at the ambient; it cools slowly after sunset and the heaters hold -40 °C', () => {
    const { e, u } = rover(`START:\n1$:     MOV  @#TEMP, R2\n        MOV  @#HEATER, R3\n        ${sleep(1)}\n        BR   1$`);
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
    expect(sreg(u, 2)).toBe(B.heaterSetpointC); // TEMP, signed
    expect(reg(u, 3)).toBe(1); // HEATER
  });

  it('heaters cost heaterPerTick on top of the idle drain', () => {
    const { e, u } = rover(IDLE);
    until(e, () => u.heater === 1);
    const before = u.energy;
    for (let i = 0; i < 100; i++) e.advanceTick();
    expect(before - u.energy).toBe(100 * (B.idleDrainPerTick + B.heaterPerTick));
  });

  it('heaters stop once the morning sun warms the ambient above the setpoint', () => {
    const { e, u } = rover(IDLE);
    until(e, () => u.heater === 1);
    until(e, () => e.sun.elevation > 0);
    until(e, () => u.heater === 0);
    expect(ambientTemp(e.sun.light)).toBeGreaterThanOrEqual(B.heaterSetpointC);
    expect(e.sun.elevation).toBeGreaterThan(0);
  });

  it('a rover without power gets as cold as the night; powered again, the heaters warm it', () => {
    const { e, u } = rover(IDLE);
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
    const { e, u } = rover(IDLE);
    for (let i = 0; i < 50; i++) e.advanceTick();
    u.temp = 10;
    e.director.triggerNow('ECLIPSE');
    for (let i = 0; i < 150; i++) e.advanceTick();
    expect(u.temp).toBeLessThan(-15);
  });
});

describe('dust on the solar array (SPEC §3.3.4)', () => {
  const OPEN = `START:  MOV  #1, @#SOLOPN\n1$:     MOV  @#SUNAZ, @#SOLANG\n        MOV  @#SOLDST, R2\n        ${sleep(10)}\n        BR   1$`;

  it('builds up 1 % per dustTicks while the array is open, and scales charging', () => {
    const { e, u } = rover(OPEN);
    for (let i = 0; i < 4 * B.dustTicks + 30; i++) e.advanceTick();
    expect(u.solarDust).toBe(4);
    until(e, () => reg(u, 2) === u.solarDust, 20);
    u.solarDust = 50;
    e.advanceTick();
    const clean = Math.floor((solarGain(u.solarAngle, e.sun) * u.solarHealth * u.chassis.solarPercent) / 10_000);
    expect(clean).toBeGreaterThan(10);
    expect(u.lastSolarGain).toBe(Math.floor((solarGain(u.solarAngle, e.sun) * 100 * 100 * 50) / 1_000_000));
    expect(u.lastSolarGain).toBeLessThanOrEqual(Math.ceil(clean / 2));
  });

  it('a stowed array collects none; folding the array shakes off half', () => {
    const { e, u } = rover(IDLE);
    for (let i = 0; i < 3 * B.dustTicks; i++) e.advanceTick();
    expect(u.solarDust).toBe(0);
    const r = rover(fw('MOV  #1, @#SOLOPN', sleep(40), 'CLR  @#SOLOPN'));
    r.u.solarDust = 31;
    for (let i = 0; i < 75; i++) r.e.advanceTick();
    expect(r.u.solarStowed).toBe(true);
    expect(r.u.solarDust).toBe(31 - Math.ceil((31 * B.dustShedPercent) / 100));
  });

  it('a dust squall dusts an open array; admin repair cleans it', () => {
    const { e, u } = rover(fw('MOV  #1, @#SOLOPN'));
    for (let i = 0; i < 25; i++) e.advanceTick();
    e.director.triggerNow('DUST_SQUALL');
    for (let i = 0; i < 70; i++) e.advanceTick();
    expect(u.solarDust).toBeGreaterThanOrEqual(25);
    e.admin.forceRepair(u);
    expect(u.solarDust).toBe(0);
  });
});
