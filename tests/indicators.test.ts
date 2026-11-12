import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { deserialize, migrate, SAVE_VERSION, serialize } from '../src/core/SaveManager';
import { LightColor } from '../src/core/types';

function setup(src: string) {
  const eng = new SimulationEngine({ seed: 1 });
  const u = eng.spawnUnit('t');
  const r = eng.upload(u, src, { factory: true });
  expect(r.errors).toEqual([]);
  return { eng, u };
}

describe('indicator lamps @IND1..@IND3', () => {
  it('are set by code with colour constants, clamped, readable, and cost nothing', () => {
    const { eng, u } = setup('MOV @IND1 RED\nMOV @IND2 99\nMOV @IND3 -5\nMOV r0 @IND1\nSLEEP 100');
    const before = u.energy;
    eng.advanceTick();
    expect(u.indicators).toEqual([LightColor.RED, LightColor.AMBER, LightColor.OFF]);
    expect(u.vm.regs[0]).toBe(LightColor.RED);
    // Only passive drain/charge happened: same as an idle rover's tick.
    const idle = setup('SLEEP 100');
    idle.eng.advanceTick();
    expect(before - u.energy).toBe(before - idle.u.energy);
  });

  it('survive a reboot (physical state) and a save/load', () => {
    const { eng, u } = setup('MOV @IND2 BLUE\nSLEEP 100');
    eng.advanceTick();
    eng.upload(u, 'SLEEP 100', { factory: true });
    expect(u.indicators[1]).toBe(LightColor.BLUE);
    const l = deserialize(JSON.parse(JSON.stringify(serialize(eng))));
    expect(l.units[0].indicators).toEqual([0, LightColor.BLUE, 0]);
  });

  it('v2 saves migrate with dark indicators', () => {
    const { eng } = setup('SLEEP 100');
    const v2 = serialize(eng) as unknown as Record<string, unknown>;
    v2.version = 2;
    for (const us of v2.units as Record<string, unknown>[]) delete us.indicators;
    expect(migrate(v2).version).toBe(SAVE_VERSION);
    expect(deserialize(v2).units[0].indicators).toEqual([0, 0, 0]);
  });
});
