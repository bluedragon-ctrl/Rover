import { describe, expect, it } from 'vitest';
import { CHASSIS_MK1 } from '../src/core/balance';
import { deserialize, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Layer, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { UPGRADE_BY_ID } from '../src/core/upgrades';
import { T } from '../src/core/WorldRegistry';

/** Keep the dish on the orbiter before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

function rover(src = 'CALL SLEEP 1000', link = false): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: 5 });
  const u = e.spawnUnit('t');
  for (let y = -4; y <= 4; y++)
    for (let x = -4; x <= 4; x++) {
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      e.world.setTile(x, y, Layer.ITEM, 0);
    }
  if (!link) u.antennaHealth = 0;
  e.upload(u, src, { factory: true });
  return { e, u };
}

/** Ticks until a 258 B photo has left the recorder. */
function photoTicks(upgrades: string[]): number {
  const { e, u } = rover('CALL SLEEP 1000', true);
  for (const id of upgrades) e.installUpgrade(u, id);
  run(e, 20); // boot frame out of the way
  e.recordProduct(u, { type: 1, subject: T.CLIFF_WALL, x: 0, y: 0, sx: 1, sy: 0, lit: true, credits: 0 });
  let t = 0;
  while (u.link.products.length && t < 2000) {
    run(e, 1);
    t++;
  }
  return t;
}

describe('M9 upgrades (SPEC §3.8.6)', () => {
  it('Mk-I chassis: 2 B/tick link, 32 B log FIFO, 1024 B recorder, camera modes 1–2', () => {
    expect(CHASSIS_MK1).toMatchObject({ linkBytesPerTick: 2, logFifoBytes: 32, recorderBytes: 1024, cameraModes: [1, 2] });
  });

  it('recorder 2 KB / 4 KB raise @REC_FREE; 4 KB needs 2 KB first', () => {
    const { e, u } = rover('MOV r0 @REC_FREE\nCALL SLEEP 1000');
    e.credits = 1000;
    expect(e.upgradeBlocker(u, 'REC_4K')).toBe('needs Recorder 2 KB');
    e.installUpgrade(u, 'REC_2K');
    expect(u.chassis.recorderBytes).toBe(2048);
    expect(e.upgradeBlocker(u, 'REC_4K')).toBeNull();
    e.installUpgrade(u, 'REC_4K');
    e.upload(u, 'MOV r0 @REC_FREE\nCALL SLEEP 1000', { factory: true });
    e.advanceTick();
    expect(u.vm.regs[0]).toBe(4096);
    expect(CHASSIS_MK1.recorderBytes).toBe(1024); // shared chassis untouched
  });

  it('trace buffer: log FIFO 64 B', () => {
    const { e, u } = rover();
    e.installUpgrade(u, 'TRACE_64');
    e.upload(u, 'MOV r0 @LOG_FREE\nCALL SLEEP 1000', { factory: true });
    e.advanceTick();
    expect(u.vm.regs[0]).toBe(64 - 4); // two boot frames (one per upload) wait: no link
  });

  it('high-gain amplifier: the same photo goes down in two thirds of the time', () => {
    const base = photoTicks([]);
    const fast = photoTicks(['LINK_3']);
    expect(base).toBeGreaterThan(100);
    expect(fast).toBeLessThan(base);
    expect(Math.abs(fast * 3 - base * 2)).toBeLessThanOrEqual(6);
  });

  it('camera modes 3–5 are accepted only once their upgrade is installed', () => {
    const src = 'CALL SNAP NORTH 3\nMOV r0 @STATUS\nCALL SEND 0\nCALL SNAP NORTH 4\nMOV r1 @STATUS\nCALL SEND 0\nCALL SNAP NORTH 5\nMOV r2 @STATUS\nCALL SEND 0\nCALL SLEEP 1000';
    const before = rover(src);
    run(before.e, 10);
    expect([0, 1, 2].map((i) => before.u.vm.regs[i])).toEqual([Status.ERR_INVALID, Status.ERR_INVALID, Status.ERR_INVALID]);

    const after = rover();
    for (const id of ['REC_2K', 'REC_4K', 'CAM_COLOUR', 'CAM_HIRES', 'CAM_RGB']) after.e.installUpgrade(after.u, id);
    expect(after.u.chassis.cameraModes).toEqual([1, 2, 3, 4, 5]);
    after.e.upload(after.u, src, { factory: true });
    run(after.e, 40);
    expect([0, 1, 2].map((i) => after.u.vm.regs[i])).toEqual([Status.OK, Status.OK, Status.OK]);
    expect(after.u.link.products.map((p) => p.type)).toEqual([3, 4, 5]);
    expect(after.u.link.recUsed).toBe(514 + 1026 + 1026);
    expect(after.u.img.length).toBe(1024); // image memory grew with the camera upgrades
  });

  it('prerequisites: hi-res needs the 2 KB recorder, the colour sensor needs the filter wheel too', () => {
    const { e, u } = rover();
    e.credits = 1000;
    expect(e.upgradeBlocker(u, 'CAM_HIRES')).toBe('needs Recorder 2 KB');
    expect(e.upgradeBlocker(u, 'CAM_RGB')).toBe('needs Colour filter wheel');
    e.installUpgrade(u, 'CAM_COLOUR');
    expect(e.upgradeBlocker(u, 'CAM_RGB')).toBe('needs Recorder 2 KB');
    e.installUpgrade(u, 'REC_2K');
    expect(e.upgradeBlocker(u, 'CAM_RGB')).toBeNull();
    expect(UPGRADE_BY_ID.CAM_RGB.cost).toBe(100);
  });

  it('upgraded chassis survives save and load', () => {
    const { e, u } = rover();
    for (const id of ['REC_2K', 'LINK_3', 'TRACE_64', 'CAM_COLOUR']) e.installUpgrade(u, id);
    const l = deserialize(serialize(e));
    expect(l.units[0].chassis).toMatchObject({ recorderBytes: 2048, linkBytesPerTick: 3, logFifoBytes: 64, cameraModes: [1, 2, 3] });
  });
});
