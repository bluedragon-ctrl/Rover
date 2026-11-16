import { describe, expect, it } from 'vitest';
import { CHASSIS_MK1 } from '../src/core/balance';
import { deserialize, serialize } from '../src/core/SaveManager';
import { Layer, Status } from '../src/core/types';
import { UPGRADE_BY_ID } from '../src/core/upgrades';
import { T } from '../src/core/WorldRegistry';
import { fw, HANG, reg, rover, run, sleep } from './helpers/rover';

const IDLE = `START:${HANG}`;
const snap = (mode: string, dst: string) => `MOV  #NORTH, R0\n        MOV  #${mode}, R1\n        JSR  PC, SNAP\n        MOV  R0, ${dst}`;

/** Ticks from the start until a lit 64x64 photo (SNAP, SNDIMG) is in the Gallery. */
function photoTicks(upgrades: string[]): number {
  const { e, u } = rover(fw(snap('F.M1', 'R2'), 'CLR  R0', 'JSR  PC, SNDIMG'), { seed: 5, flat: true, setup: (e2, r) => {
    e2.world.setTile(0, 2, Layer.OBSTACLE, T.CLIFF_WALL);
    r.headlight = 1;
  } });
  for (const id of upgrades) e.installUpgrade(u, id);
  let t = 0;
  while (!e.gallery.length && t < 3000) {
    run(e, 1, true);
    t++;
  }
  return t;
}

describe('M9 upgrades (SPEC §3.8.6)', () => {
  it('Mk-I chassis: 4 B/tick link, 2 KB recorder, camera modes 1–2, 64 cycles a tick', () => {
    expect(CHASSIS_MK1).toMatchObject({ linkBytesPerTick: 4, recorderBytes: 2048, cameraModes: [1, 2], cyclesPerTick: 64 });
  });

  it('recorder 4 KB / 8 KB raise RECFRE; 8 KB needs 4 KB first', () => {
    const { e, u } = rover(IDLE, { seed: 5 });
    e.credits = 1000;
    expect(e.upgradeBlocker(u, 'REC_8K')).toBe('needs Recorder 4 KB');
    e.installUpgrade(u, 'REC_4K');
    expect(u.chassis.recorderBytes).toBe(4096);
    expect(e.upgradeBlocker(u, 'REC_8K')).toBeNull();
    e.installUpgrade(u, 'REC_8K');
    e.upload(u, `START:\n1$:     MOV  @#RECFRE, R2\n        ${sleep(1)}\n        BR   1$`, { factory: true });
    run(e, 6);
    expect(reg(u, 2)).toBe(8192);
    expect(CHASSIS_MK1.recorderBytes).toBe(2048); // shared chassis untouched
  });

  it('high-gain amplifier: the same photo goes down in about two thirds of the time', () => {
    const base = photoTicks([]);
    const fast = photoTicks(['LINK_6']);
    expect(base).toBeGreaterThan(200);
    expect(base).toBeLessThan(3000);
    expect(fast).toBeLessThan(base * 0.8);
  });

  it('camera modes 3–5 are accepted only once their upgrade is installed', () => {
    const src = fw(snap('F.M3', 'R2'), snap('F.M4', 'R3'), snap('F.M5', 'R4'));
    const before = rover(src, { seed: 5 });
    run(before.e, 10);
    expect([2, 3, 4].map((i) => reg(before.u, i))).toEqual([Status.ERR_INVALID, Status.ERR_INVALID, Status.ERR_INVALID]);

    const after = rover(IDLE, { seed: 5 });
    for (const id of ['REC_4K', 'CAM_COLOUR', 'CAM_HIRES', 'CAM_RGB']) after.e.installUpgrade(after.u, id);
    expect(after.u.chassis.cameraModes).toEqual([1, 2, 3, 4, 5]);
    after.e.upload(after.u, src, { factory: true });
    run(after.e, 45);
    expect([2, 3, 4].map((i) => reg(after.u, i))).toEqual([Status.OK, Status.OK, Status.OK]);
    expect(after.u.capture?.type).toBe(5);
    expect(after.u.img.length).toBe(4096); // image memory grew with the camera upgrades
  });

  it('prerequisites: hi-res needs the 4 KB recorder, the colour sensor needs the filter wheel too', () => {
    const { e, u } = rover(IDLE, { seed: 5 });
    e.credits = 1000;
    expect(e.upgradeBlocker(u, 'CAM_HIRES')).toBe('needs Recorder 4 KB');
    expect(e.upgradeBlocker(u, 'CAM_RGB')).toBe('needs Colour filter wheel');
    e.installUpgrade(u, 'CAM_COLOUR');
    expect(e.upgradeBlocker(u, 'CAM_RGB')).toBe('needs Recorder 4 KB');
    e.installUpgrade(u, 'REC_4K');
    expect(e.upgradeBlocker(u, 'CAM_RGB')).toBeNull();
    expect(UPGRADE_BY_ID.CAM_RGB.cost).toBe(100);
  });

  it('upgraded chassis survives save and load', () => {
    const { e, u } = rover(IDLE, { seed: 5 });
    for (const id of ['REC_4K', 'LINK_6', 'CAM_COLOUR']) e.installUpgrade(u, id);
    const l = deserialize(serialize(e));
    expect(l.units[0].chassis).toMatchObject({ recorderBytes: 4096, linkBytesPerTick: 6, cameraModes: [1, 2, 3] });
  });
});
