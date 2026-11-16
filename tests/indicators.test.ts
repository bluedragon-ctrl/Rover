import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../src/core/SaveManager';
import { LightColor } from '../src/core/types';
import { factory, fw, HANG, reg, rover, run } from './helpers/rover';

const IDLE = `START:${HANG}`;

describe('indicator lamps IND1–IND3', () => {
  it('are set by code with colour symbols, clamped, readable, and cost nothing', () => {
    const { e, u } = rover(fw('MOV  #RED, @#IND1', 'MOV  #99., @#IND2', 'MOV  #-5, @#IND3', 'MOV  @#IND1, R2'), { seed: 1 });
    const before = u.energy;
    run(e, 6);
    expect(u.indicators).toEqual([LightColor.RED, LightColor.AMBER, LightColor.AMBER]); // -5 is 177773: unsigned, clamped to 4
    expect(reg(u, 2)).toBe(LightColor.RED);
    // Only passive drain/charge happened: the same as an idle rover's ticks.
    const idle = rover(IDLE, { seed: 1 });
    run(idle.e, 6);
    expect(before - u.energy).toBe(before - idle.u.energy);
  });

  it('survive a reboot (physical state) and a save/load', () => {
    const { e, u } = rover(fw('MOV  #BLUE, @#IND2'), { seed: 1 });
    run(e, 6);
    e.upload(u, IDLE, factory);
    expect(u.indicators[1]).toBe(LightColor.BLUE);
    const l = deserialize(JSON.parse(JSON.stringify(serialize(e))));
    expect(l.units[0].indicators).toEqual([0, LightColor.BLUE, 0]);
  });
});

describe('DISP, the display on the cabin (SPEC §3.8.3)', () => {
  it('is a free 0–255 register (the low byte is kept) that survives reboots', () => {
    const { e, u } = rover(fw('MOV  #37, @#DISP', 'MOV  @#DISP, R2', 'MOV  #999., @#DISP', 'MOV  @#DISP, R3', 'MOV  #-5, @#DISP', 'MOV  @#DISP, R4', 'MOV  #245, @#DISP'), { seed: 2 });
    run(e, 6);
    expect([reg(u, 2), reg(u, 3), reg(u, 4)]).toEqual([0x1f, 999 & 0xff, 0xfb]);
    expect(u.post).toBe(0xa5);
    e.upload(u, IDLE, factory);
    expect(u.post).toBe(0xa5); // physical: survives the reboot
  });

  it('is saved', () => {
    const { e, u } = rover(IDLE, { seed: 2 });
    u.post = 0x42;
    expect(deserialize(JSON.parse(JSON.stringify(serialize(e)))).units[0].post).toBe(0x42);
  });
});
