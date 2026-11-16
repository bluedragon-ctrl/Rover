import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { ProductType, type ProductDesc } from '../src/core/downlink';
import { productFrame, productPayload } from '../src/core/imaging';
import { decodePhoto, PHOTO_FORMATS, PHOTO_FORMATS_2X, photoBytes, photoPayload, type PhotoShot } from '../src/core/photos';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Layer, Status } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { T } from '../src/core/WorldRegistry';
import { fw, HANG, reg } from './helpers/rover';

const IDLE = `START:${HANG}`;
/** `JSR PC, SNAP` in `dir` with `mode`; R0 (the result) to `dst`. */
const snap = (dir: string, mode: string, dst = 'R5') => `MOV  #${dir}, R0\n        MOV  #${mode}, R1\n        JSR  PC, SNAP\n        MOV  R0, ${dst}`;
const send = 'CLR  R0\n        JSR  PC, SNDIMG';
/** The capture as a product descriptor (what a raw photo regenerates from). */
const asProduct = (u: Unit): ProductDesc => ({ ...u.capture!, seq: 0, tick: 0, credits: 0 });

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
  if (!opts.link) u.antennaHealth = 0; // keep messages in the recorder
  e.upload(u, src, { factory: true });
  return { e, u };
}

const shot = (over: Partial<PhotoShot> = {}): PhotoShot => ({ type: 1, subject: T.CLIFF_WALL, sx: 3, sy: 4, lit: true, tick: 50, seq: 0, ...over });

describe('SNAP (the camera block, ROM SNAP)', () => {
  it('photographs the first obstacle within 2 tiles into image memory; 10 ticks, 200 energy, no turn', () => {
    const { e, u } = rover(fw(snap('EAST', 'F.M1', 'R2')));
    e.world.setTile(2, 0, Layer.OBSTACLE, T.CLIFF_WALL);
    u.heading = 0;
    for (let i = 0; i < 10 && u.action?.kind !== 'TOOL'; i++) e.advanceTick();
    expect(u.action?.kind).toBe('TOOL');
    const spent = BALANCE.batteryCapacity - u.energy;
    expect(spent).toBeGreaterThanOrEqual(BALANCE.snapEnergy);
    expect(spent).toBeLessThan(BALANCE.snapEnergy + 20);
    for (let i = 0; i < BALANCE.snapTicks - 1; i++) e.advanceTick();
    expect(u.capture).toBeNull();
    expect([...u.img].every((b) => b === 0)).toBe(true);
    e.advanceTick(); // the exposure ends and fills image memory
    expect(u.capture).toMatchObject({ type: ProductType.PHOTO_GREY, subject: T.CLIFF_WALL, sx: 2, sy: 0, x: 0, y: 0, lit: true, x2: true });
    expect(productPayload(e.seed, asProduct(u))).toEqual([...u.img.subarray(0, photoBytes(1))]);
    e.advanceTick();
    expect(reg(u, 2)).toBe(Status.OK);
    expect(u.heading).toBe(0); // mast camera: the rover does not turn
    expect(e.stats.photosTaken).toBe(1);
  });

  it('items and rovers are subjects; with nothing within reach, a landscape', () => {
    const take = (dir: string, mode: string) => {
      const r = rover(fw(snap(dir, mode)));
      // NORTH is +y, SOUTH −y (DIR_VEC)
      r.e.world.setTile(0, -2, Layer.ITEM, T.SAMPLE);
      r.e.world.setTile(0, 1, Layer.TERRAIN, T.ROUGH_GRAVEL);
      r.e.world.setTile(0, 3, Layer.OBSTACLE, T.CLIFF_WALL); // 3 tiles away: out of reach
      r.e.spawnUnit('other', -2, 0); // a rover two tiles west
      run(r.e, 20);
      return r.u.capture!;
    };
    expect([take('SOUTH', 'F.M1'), take('WEST', 'F.M2'), take('NORTH', 'F.M1')].map((p) => [p.type, p.subject, p.sx, p.sy])).toEqual([
      [1, T.SAMPLE, 0, -2],
      [2, T.ROVER, -2, 0],
      [1, 0, 0, 0],
    ]);
    const land = take('NORTH', 'F.M1').horizon!;
    expect(land.h).toHaveLength(16);
    expect(land.d[7]).toBe(3); // the cliff 3 tiles north, straight ahead
    expect(land.h[7]).toBe(256); // a cliff 3 tiles tall, 3 tiles away, fills the sky
    expect(land.t[7]).toBe(T.CLIFF_WALL);
    expect(take('SOUTH', 'F.M1').horizon).toBeUndefined();
  });

  it('E.INV for a bad direction or a mode not installed, E.LOWP without the energy', () => {
    const { e, u } = rover(fw(snap('4', 'F.M1', 'R2'), snap('NORTH', 'F.M3', 'R3'), snap('NORTH', 'F.M1', 'R4')));
    run(e, 20);
    expect([reg(u, 2), reg(u, 3), reg(u, 4)]).toEqual([Status.ERR_INVALID, Status.ERR_INVALID, Status.OK]);
    expect(u.capture).not.toBeNull(); // in image memory until SNDIMG sends it

    const lp = rover(fw(snap('NORTH', 'F.M1', 'R2')));
    lp.u.energy = 150;
    run(lp.e, 6);
    expect(reg(lp.u, 2)).toBe(Status.ERR_LOW_POWER);
    expect(lp.u.capture).toBeNull();
  });

  it('needs light: daylight, or the headlight on and facing the subject', () => {
    const day = rover(fw(snap('NORTH', 'F.M1')));
    run(day.e, 20);
    expect(day.e.sun.light).toBeGreaterThanOrEqual(BALANCE.snapMinSunLight);
    expect(day.u.capture!.lit).toBe(true);

    const night = (src: string) => {
      const r = rover(src, { tick: 1300 });
      expect(r.e.sun.light).toBe(0);
      run(r.e, 20);
      return r.u.capture!.lit;
    };
    expect(night(fw(snap('NORTH', 'F.M1')))).toBe(false);
    expect(night(fw('MOV  #1, @#LIGHT', 'MOV  #EAST, @#HDG', snap('EAST', 'F.M1')))).toBe(true);
    expect(night(fw('MOV  #1, @#LIGHT', 'MOV  #EAST, @#HDG', snap('NORTH', 'F.M1')))).toBe(false);
  });
});

describe('photo generator', () => {
  it('produces each format at its SPEC size, integer bytes, deterministic', () => {
    for (const [type, bytes] of [[1, 1024], [2, 1024], [3, 2048], [4, 4096], [5, 4096]]) {
      const p = photoPayload(7, shot({ type }));
      expect(p).toHaveLength(bytes);
      expect(photoBytes(type)).toBe(bytes);
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

  it('packs little-endian (the first pixel in the low bits) row by row and decodes partial photos', () => {
    const p = photoPayload(2, shot({ type: 1 }));
    const full = decodePhoto(1, p)!;
    expect(full.pixelsReceived).toBe(4096);
    // pixel 0 = bits 1..0 of byte 0, pixel 1 = bits 3..2
    expect(full.rgb[0]).toBe(((p[0] & 3) * 255) / 3);
    expect(full.rgb[3]).toBe((((p[0] >> 2) & 3) * 255) / 3);
    // 4 bpp: pixel 0 in the low nibble
    const c = photoPayload(2, shot({ type: 3 }));
    expect(decodePhoto(3, c)!.rgb.slice(0, 3)).toEqual(decodePhoto(3, [c[0] & 15])!.rgb.slice(0, 3));
    const part = decodePhoto(1, p.slice(0, 100))!;
    expect(part.pixelsReceived).toBe(400);
    expect(Array.from(part.rgb.slice(0, 1200))).toEqual(Array.from(full.rgb.slice(0, 1200)));
    const f = productFrame(2, { type: 1, seq: 4, subject: T.CLIFF_WALL, x: 0, y: 0, sx: 3, sy: 4, lit: true, tick: 50, credits: 0, x2: true });
    expect(f.slice(0, 2)).toEqual([0x88, 4]);
    expect(f.slice(2)).toEqual(photoPayload(2, shot({ seq: 4 })));
  });
});

describe('landscape photos', () => {
  it('sun in view only when facing it and above the horizon; open view has no ridges', () => {
    const { e, u } = rover(IDLE);
    const az = e.sun.azimuth; // morning: sun in the east
    const toward = Math.round(az / 90) % 4;
    const v = e.horizonView(u, toward);
    expect(v.sunU).toBeGreaterThanOrEqual(0);
    expect(v.sunV).toBeLessThan(448);
    expect(e.horizonView(u, (toward + 2) % 4).sunU).toBe(-1);
    const night = rover(IDLE, { tick: 1300 });
    for (let d = 0; d < 4; d++) expect(night.e.horizonView(night.u, d).sunU).toBe(-1);
  });

  it('nearer cliffs stand taller; landscapes render deterministically in every format', () => {
    const { e, u } = rover(IDLE);
    for (let x = -4; x <= 4; x++) e.world.setTile(x, 8, Layer.OBSTACLE, T.CLIFF_WALL);
    const far = e.horizonView(u, 0);
    for (let x = -4; x <= 4; x++) e.world.setTile(x, 4, Layer.OBSTACLE, T.CLIFF_WALL);
    const near = e.horizonView(u, 0);
    expect(far.h[7]).toBe(96); // 768 / 8
    expect(near.h[7]).toBe(192);
    for (const type of [1, 2, 3, 4, 5]) {
      const p = photoPayload(1, shot({ type, subject: 0, horizon: near }));
      expect(p).toHaveLength(photoBytes(type));
      expect(photoPayload(1, shot({ type, subject: 0, horizon: near }))).toEqual(p);
    }
  });
});

describe('photo delivery and credits', () => {
  it('lit photo 1 credit, +5 for the first of a subject type; dark photos 0; Photographer', () => {
    const { e } = rover(fw(snap('NORTH', 'F.M1'), send, snap('NORTH', 'F.M1'), send, snap('EAST', 'F.M2'), send, snap('SOUTH', 'F.M1'), send), { link: true });
    e.world.setTile(0, 2, Layer.OBSTACLE, T.CLIFF_WALL);
    e.world.setTile(2, 0, Layer.OBSTACLE, T.CLIFF_WALL);
    e.world.setTile(0, -1, Layer.ITEM, T.SAMPLE);
    const c0 = e.credits;
    run(e, 2000);
    expect(e.gallery.map((g) => [g.subject, g.credits])).toEqual([
      [T.CLIFF_WALL, 6],
      [T.CLIFF_WALL, 1],
      [T.CLIFF_WALL, 1],
      [T.SAMPLE, 6],
    ]);
    expect(e.stats.photosDelivered).toBe(4);
    expect(e.photoSubjects).toEqual([T.CLIFF_WALL, T.SAMPLE]);
    expect(e.director.completed.has('photographer')).toBe(true);
    expect(e.credits - c0).toBeGreaterThanOrEqual(14);

    const dark = rover(fw(snap('NORTH', 'F.M1'), send), { link: true, tick: 1300 });
    run(dark.e, 600);
    expect(dark.e.gallery.map((g) => [g.lit, g.credits])).toEqual([[false, 0]]);
  });
});

describe('M15 doubled camera formats (PHOTO_FORMATS_2X)', () => {
  it('double every side, keep powers of two, the M9 formats stay for the preview pages', () => {
    for (const m of [1, 2, 3, 4, 5]) {
      expect(PHOTO_FORMATS_2X[m].w).toBe(2 * PHOTO_FORMATS[m].w);
      expect(PHOTO_FORMATS_2X[m].h).toBe(2 * PHOTO_FORMATS[m].h);
      expect(photoBytes(m, PHOTO_FORMATS_2X)).toBe(4 * photoBytes(m, PHOTO_FORMATS));
      const shot = { type: m, subject: T.CLIFF_WALL, sx: 3, sy: 4, lit: true, tick: 50, seq: 0, anomaly: true };
      const a = photoPayload(5, shot, PHOTO_FORMATS_2X);
      expect(a).toHaveLength(photoBytes(m, PHOTO_FORMATS_2X));
      expect(photoPayload(5, shot, PHOTO_FORMATS_2X)).toEqual(a); // deterministic
      expect(decodePhoto(m, a, PHOTO_FORMATS_2X)!.w).toBe(PHOTO_FORMATS_2X[m].w);
    }
    expect([1, 2, 3, 4, 5].map((m) => photoBytes(m, PHOTO_FORMATS))).toEqual([256, 256, 512, 1024, 1024]);
  });
});
