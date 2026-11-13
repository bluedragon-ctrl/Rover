import { describe, expect, it } from 'vitest';
import { BALANCE, CHASSIS_MK1 } from '../src/core/balance';
import { productFrameBytes, ProductType } from '../src/core/downlink';
import { productFrame } from '../src/core/imaging';
import { decodePhoto, photoBytes, photoPayload, type PhotoShot } from '../src/core/photos';
import { deserialize, migrate, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Layer, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { compile } from '../src/core/vm/Compiler';
import { T } from '../src/core/WorldRegistry';

/** Keep the dish on the orbiter before every tick. */
function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

/** Rover at the origin on cleared flat sand; `tick` 0 = morning, ~1300 = night. */
function rover(src: string, opts: { seed?: number; tick?: number; link?: boolean } = {}): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: opts.seed ?? 5 });
  if (opts.tick) {
    e.tick = opts.tick;
    e.world.now = opts.tick;
    e.refreshDerived();
  }
  const u = e.spawnUnit('t');
  for (let y = -4; y <= 4; y++)
    for (let x = -4; x <= 4; x++) {
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      e.world.setTile(x, y, Layer.ITEM, 0);
    }
  if (!opts.link) u.antennaHealth = 0; // keep products in the recorder
  e.upload(u, src, { factory: true });
  return { e, u };
}

const shot = (over: Partial<PhotoShot> = {}): PhotoShot => ({ type: 1, subject: T.CLIFF_WALL, sx: 3, sy: 4, lit: true, tick: 50, seq: 0, ...over });

describe('SNAP instruction', () => {
  it('compiles as a hardware instruction with an optional mode', () => {
    const r = compile('SNAP NORTH\nSNAP EAST 2\nSNAP r0 r1', CHASSIS_MK1);
    expect(r.errors).toEqual([]);
    expect([r.lineBytes[1], r.lineBytes[2], r.lineBytes[3]]).toEqual([2, 3, 3]);
    expect(compile('SNAP', CHASSIS_MK1).errors).toHaveLength(1);
  });

  it('photographs the first obstacle within 2 tiles: 10 ticks, 200 energy, 258 B, no turn', () => {
    const { e, u } = rover('SNAP EAST\nMOV r0 @STATUS\nMOV r1 @REC_FREE\nSLEEP 1000');
    e.world.setTile(2, 0, Layer.OBSTACLE, T.CLIFF_WALL);
    u.heading = 0;
    e.advanceTick();
    expect(u.action?.kind).toBe('TOOL');
    const spent = BALANCE.batteryCapacity - u.energy;
    expect(spent).toBeGreaterThanOrEqual(BALANCE.snapEnergy);
    expect(spent).toBeLessThan(BALANCE.snapEnergy + 20);
    for (let i = 0; i < BALANCE.snapTicks - 1; i++) e.advanceTick();
    expect(u.link.products).toHaveLength(0);
    e.advanceTick();
    expect(u.link.products).toHaveLength(1);
    const p = u.link.products[0];
    expect(p).toMatchObject({ type: ProductType.PHOTO_GREY, subject: T.CLIFF_WALL, sx: 2, sy: 0, x: 0, y: 0, lit: true });
    e.advanceTick();
    expect(u.vm.regs[0]).toBe(Status.OK);
    expect(u.vm.regs[1]).toBe(CHASSIS_MK1.recorderBytes - 258);
    expect(u.heading).toBe(0); // mast camera: the rover does not turn
    expect(e.stats.photosTaken).toBe(1);
  });

  it('items and rovers are subjects; else the ground tile in front', () => {
    const { e, u } = rover('SNAP SOUTH\nSNAP WEST 2\nSNAP NORTH\nSLEEP 1000');
    // NORTH is +y, SOUTH −y (DIR_VEC)
    e.world.setTile(0, -2, Layer.ITEM, T.SAMPLE);
    e.world.setTile(0, 1, Layer.TERRAIN, T.ROUGH_GRAVEL);
    e.world.setTile(0, 3, Layer.OBSTACLE, T.CLIFF_WALL); // 3 tiles away: out of reach
    e.spawnUnit('other', -2, 0); // a rover two tiles west
    run(e, 40);
    expect(u.link.products.map((p) => [p.type, p.subject, p.sx, p.sy])).toEqual([
      [1, T.SAMPLE, 0, -2],
      [2, T.ROVER, -2, 0],
      [1, T.ROUGH_GRAVEL, 0, 1],
    ]);
  });

  it('ERR_INVALID for a bad direction or a mode not installed, ERR_FULL, ERR_LOW_POWER', () => {
    const { e, u } = rover('SNAP 4\nMOV r0 @STATUS\nSNAP NORTH 3\nMOV r1 @STATUS\nSNAP NORTH\nMOV r2 @STATUS\nSLEEP 1000');
    while (u.link.recFree(u.chassis.recorderBytes) >= 258) e.recordProduct(u, { type: 1, subject: T.FLAT_SAND, x: 0, y: 0, credits: 0 });
    run(e, 5);
    expect([u.vm.regs[0], u.vm.regs[1], u.vm.regs[2]]).toEqual([Status.ERR_INVALID, Status.ERR_INVALID, Status.ERR_FULL]);

    const lp = rover('SNAP NORTH\nMOV r0 @STATUS\nSLEEP 1000');
    lp.u.energy = 150;
    lp.e.advanceTick();
    lp.e.advanceTick();
    expect(lp.u.vm.regs[0]).toBe(Status.ERR_LOW_POWER);
    expect(lp.u.link.products).toHaveLength(0);
  });

  it('needs light: daylight, or the headlight on and facing the subject', () => {
    const day = rover('SNAP NORTH\nSLEEP 1000');
    run(day.e, 12);
    expect(day.e.sun.light).toBeGreaterThanOrEqual(BALANCE.snapMinSunLight);
    expect(day.u.link.products[0].lit).toBe(true);

    const night = (src: string) => {
      const r = rover(src, { tick: 1300 });
      expect(r.e.sun.light).toBe(0);
      run(r.e, 30);
      return r.u.link.products.map((p) => p.lit);
    };
    expect(night('SNAP NORTH\nSLEEP 1000')).toEqual([false]);
    expect(night('MOV @HEADLIGHT 1\nMOV @HEADING EAST\nSNAP EAST\nSNAP NORTH\nSLEEP 1000')).toEqual([true, false]);
  });
});

describe('photo generator', () => {
  it('produces each format at its SPEC size, integer bytes, deterministic', () => {
    for (const [type, bytes] of [[1, 256], [2, 256], [3, 512], [4, 1024], [5, 1024]]) {
      const p = photoPayload(7, shot({ type }));
      expect(p).toHaveLength(bytes);
      expect(photoBytes(type)).toBe(bytes);
      expect(productFrameBytes(type)).toBe(bytes + 2);
      for (const b of p) expect(Number.isInteger(b) && b >= 0 && b <= 255).toBe(true);
      expect(photoPayload(7, shot({ type }))).toEqual(p);
    }
  });

  it('every subject has a scene with real contrast when lit', () => {
    for (const subject of [T.FLAT_SAND, T.ROUGH_GRAVEL, T.ACID_VENT, T.CLIFF_WALL, T.IRON_ORE, T.SILICON_ORE, T.SAMPLE, T.REPAIR_KIT, T.SUPPLY_CRATE, T.ROVER]) {
      const ph = decodePhoto(1, photoPayload(3, shot({ subject })))!;
      const levels = new Set<number>();
      for (let i = 0; i < ph.w * ph.h; i++) levels.add(ph.rgb[i * 3]);
      expect(levels.size, `subject ${subject}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the same rock looks the same; another rock or subject differs; dark photos are noise', () => {
    const differ = (a: number[], b: number[]) => a.filter((v, i) => v !== b[i]).length / a.length;
    const a = photoPayload(1, shot());
    expect(differ(a, photoPayload(1, shot({ seq: 9, tick: 400 })))).toBeLessThan(0.35); // sensor noise only
    expect(differ(a, photoPayload(1, shot({ sx: 9 })))).toBeGreaterThan(0.4);
    expect(differ(a, photoPayload(1, shot({ subject: T.IRON_ORE })))).toBeGreaterThan(0.4);
    const dark1 = photoPayload(1, shot({ lit: false }));
    const dark2 = photoPayload(1, shot({ lit: false, seq: 1 }));
    expect(differ(dark1, dark2)).toBeGreaterThan(0.6); // noise dominates
  });

  it('packs MSB-first row by row and decodes partial photos', () => {
    const p = photoPayload(2, shot({ type: 1 }));
    const full = decodePhoto(1, p)!;
    expect(full.pixelsReceived).toBe(1024);
    // pixel 1 = bits 5..4 of byte 0
    expect(full.rgb[3]).toBe((((p[0] >> 4) & 3) * 255) / 3);
    const part = decodePhoto(1, p.slice(0, 100))!;
    expect(part.pixelsReceived).toBe(400);
    expect(Array.from(part.rgb.slice(0, 1200))).toEqual(Array.from(full.rgb.slice(0, 1200)));
    const f = productFrame(2, { type: 1, seq: 4, subject: T.CLIFF_WALL, x: 0, y: 0, sx: 3, sy: 4, lit: true, tick: 50, credits: 0 });
    expect(f.slice(0, 2)).toEqual([0x88, 4]);
    expect(f.slice(2)).toEqual(photoPayload(2, shot({ seq: 4 })));
  });
});

describe('photo delivery and credits', () => {
  it('lit photo 1 credit, +5 for the first of a subject type; dark photos 0; Photographer', () => {
    const { e, u } = rover('SLEEP 100000', { link: true });
    u.link.fifo = [];
    const add = (subject: number, lit: boolean) => e.recordProduct(u, { type: 1, subject, x: 0, y: 0, sx: 1, sy: 0, lit, credits: 0 });
    add(T.CLIFF_WALL, true);
    add(T.CLIFF_WALL, true);
    add(T.SAMPLE, false);
    expect(add(T.SAMPLE, true)).toBeNull(); // 4 × 258 B do not fit in 1024 B
    const c0 = e.credits;
    run(e, 70);
    expect(e.gallery).toHaveLength(1);
    expect(e.gallery[0].received).toBeGreaterThan(100);
    expect(e.gallery[0].received).toBeLessThan(258); // partial photo in the gallery
    run(e, 100);
    expect(add(T.SAMPLE, true)).not.toBeNull(); // the first one freed its space
    run(e, 600);
    expect(e.gallery.map((g) => g.credits)).toEqual([6, 1, 0, 6]);
    expect(e.stats.photosDelivered).toBe(3);
    expect(e.stats.scienceDelivered).toBe(4);
    expect(e.photoSubjects).toEqual([T.CLIFF_WALL, T.SAMPLE]);
    expect(e.director.completed.has('photographer')).toBe(true);
    expect(e.credits - c0).toBeGreaterThanOrEqual(13);
  });

  it('save mid-photo, load, continue == uninterrupted run', () => {
    const make = () => {
      const { e, u } = rover('loop: SNAP NORTH\nSNAP EAST 2\nSLEEP 50\nJMP loop', { seed: 9, link: true });
      u.antennaHealth = 75;
      e.world.setTile(1, 0, Layer.OBSTACLE, T.IRON_ORE);
      return e;
    };
    const a = make();
    run(a, 500);
    const b0 = make();
    run(b0, 211);
    expect(b0.units[0].link.recSent).toBeGreaterThan(0);
    const b = deserialize(JSON.parse(JSON.stringify(serialize(b0))));
    run(b, 289);
    expect(serialize(b)).toEqual(serialize(a));
    expect(a.stats.photosDelivered).toBeGreaterThanOrEqual(2);
    expect(a.photoSubjects.length).toBe(2);
  });

  it('migrates v7 saves: no photo subjects yet', () => {
    const { e } = rover('SLEEP 10');
    const v7 = serialize(e) as unknown as Record<string, any>;
    v7.version = 7;
    delete v7.photoSubjects;
    delete v7.stats.photosTaken;
    delete v7.stats.photosDelivered;
    const m = migrate(v7);
    expect(m.photoSubjects).toEqual([]);
    expect(m.stats.photosDelivered).toBe(0);
    expect(deserialize(v7).photoSubjects).toEqual([]);
  });
});
