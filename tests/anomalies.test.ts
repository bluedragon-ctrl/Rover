import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { productFrameBytes, type ReceivedProduct } from '../src/core/downlink';
import { productPayload } from '../src/core/imaging';
import { iangle, isAnomaly } from '../src/core/photos';
import { deserialize, migrate, serialize } from '../src/core/SaveManager';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { Layer } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { T } from '../src/core/WorldRegistry';

const SEED = 5;

function run(e: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    for (const u of e.units) u.antennaAngle = u.antennaTarget = e.env.orbitAzimuth(e.tick + 1);
    e.advanceTick();
  }
}

function rover(src: string): { e: SimulationEngine; u: Unit } {
  const e = new SimulationEngine({ seed: SEED });
  const u = e.spawnUnit('t');
  for (let y = -4; y <= 4; y++)
    for (let x = -4; x <= 4; x++) {
      e.world.setTile(x, y, Layer.TERRAIN, T.FLAT_SAND);
      e.world.setTile(x, y, Layer.OBSTACLE, 0);
      e.world.setTile(x, y, Layer.ITEM, 0);
    }
  u.antennaHealth = 0;
  e.upload(u, src, { factory: true });
  return { e, u };
}

/** First tile (x, 1..) east of the rover whose cliff is (or is not) an anomaly. */
function cliffTile(anomaly: boolean, from = 0): number {
  for (let y = from; ; y++) if (isAnomaly(SEED, T.CLIFF_WALL, 2, y, BALANCE.anomalyOneIn) === anomaly) return y;
}

/** A delivered, lit photo in the gallery (as mission control would hold it). */
function delivered(e: SimulationEngine, over: Partial<ReceivedProduct> = {}): ReceivedProduct {
  const g: ReceivedProduct = { type: 1, seq: e.gallery.length, subject: T.CLIFF_WALL, x: 0, y: 0, sx: 2, sy: 0, tick: e.gallery.length, credits: 1, lit: true, unitId: 1, arrived: 9, received: productFrameBytes(1), ...over };
  e.gallery.push(g);
  return g;
}

describe('anomalies (SPEC §3.8.5)', () => {
  it('about 1 in 40 cliff walls and samples, seeded per tile; never other subjects', () => {
    let n = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (isAnomaly(SEED, T.CLIFF_WALL, x, y, 40)) n++;
    expect(n).toBeGreaterThan(200);
    expect(n).toBeLessThan(300);
    for (const t of [0, T.IRON_ORE, T.SILICON_ORE, T.ROVER, T.FLAT_SAND]) {
      let any = false;
      for (let x = 0; x < 200; x++) any ||= isAnomaly(SEED, t, x, 0, 40);
      expect(any).toBe(false);
    }
    const tile = cliffTile(true);
    expect(isAnomaly(SEED, T.SAMPLE, 2, tile, 40)).toBe(true); // same tile rule for samples
    expect(isAnomaly(SEED + 1, T.CLIFF_WALL, 2, tile, 40)).not.toBe(undefined);
  });

  it('iangle: integer angle in 1/1024 turns', () => {
    expect([iangle(1, 0), iangle(0, 1), iangle(-1, 0), iangle(0, -1), iangle(5, 5), iangle(-5, -5)]).toEqual([0, 256, 512, 768, 128, 640]);
    for (let a = 0; a < 360; a += 7) {
      const r = (a * Math.PI) / 180;
      const got = iangle(Math.round(Math.cos(r) * 1000), Math.round(Math.sin(r) * 1000));
      const want = (a * 1024) / 360;
      expect(Math.min(Math.abs(got - want), 1024 - Math.abs(got - want))).toBeLessThan(3);
    }
  });

  it('SNAP of an anomaly tile marks the descriptor and shows a different scene', () => {
    const { e, u } = rover('SNAP EAST\nSEND\nSLEEP 1000');
    const y = cliffTile(true);
    // Put the rover next to the anomaly cliff.
    u.y = y;
    for (let x = -1; x <= 3; x++) e.world.setTile(x, y, Layer.OBSTACLE, 0);
    e.world.setTile(2, y, Layer.OBSTACLE, T.CLIFF_WALL);
    run(e, 15);
    const p = u.link.products[0];
    expect(p).toMatchObject({ subject: T.CLIFF_WALL, sx: 2, sy: y, anomaly: true });
    const plain = productPayload(SEED, { ...p, anomaly: undefined });
    expect(productPayload(SEED, p)).not.toEqual(plain);
    expect(productPayload(SEED, p)).toEqual(productPayload(SEED, { ...p })); // deterministic

    const n = rover('SNAP EAST\nSEND\nSLEEP 1000');
    const y2 = cliffTile(false);
    n.u.y = y2;
    for (let x = -1; x <= 3; x++) n.e.world.setTile(x, y2, Layer.OBSTACLE, 0);
    n.e.world.setTile(2, y2, Layer.OBSTACLE, T.CLIFF_WALL);
    run(n.e, 15);
    expect(n.u.link.products[0].anomaly).toBeUndefined();
  });

  it('flagging: +20 once per tile, already catalogued pays nothing, wrong −5 never below 0', () => {
    const { e } = rover('SLEEP 1000');
    e.credits = 7;
    const hit = delivered(e, { anomaly: true, sx: 2, sy: 3 });
    expect(e.flagAnomaly(hit)).toBeNull();
    expect(hit.flag).toBe('hit');
    expect(e.credits).toBe(27);
    expect(e.stats.anomaliesFound).toBe(1);
    expect(e.flagAnomaly(hit)).toBe('already flagged');
    expect(e.credits).toBe(27);

    const again = delivered(e, { anomaly: true, sx: 2, sy: 3, type: 3, received: productFrameBytes(3) });
    expect(e.flagAnomaly(again)).toBeNull();
    expect(again.flag).toBe('known');
    expect(e.credits).toBe(27);
    expect(e.stats.anomaliesFound).toBe(1);

    const miss = delivered(e);
    expect(e.flagAnomaly(miss)).toBeNull();
    expect(miss.flag).toBe('miss');
    expect(e.credits).toBe(22);
    e.credits = 3;
    expect(e.flagAnomaly(delivered(e))).toBeNull();
    expect(e.credits).toBe(0);
  });

  it('only complete, lit photos can be flagged', () => {
    const { e } = rover('SLEEP 1000');
    e.credits = 50;
    expect(e.flagAnomaly(delivered(e, { anomaly: true, received: 100 }))).toBe('photo not complete');
    expect(e.flagAnomaly(delivered(e, { anomaly: true, lit: false }))).toBe('dark photo');
    expect(e.flagAnomaly(delivered(e, { type: 0, received: 18 }))).toBe('only photos can be flagged');
    expect(e.credits).toBe(50);
    expect(e.stats.anomaliesFound).toBe(0);
  });

  it('goal Anomaly hunter: one correct flag, 30 credits', () => {
    const { e } = rover('SLEEP 1000');
    e.flagAnomaly(delivered(e, { anomaly: true }));
    run(e, 10); // goals are checked every 10 ticks
    expect(e.director.completed.has('anomaly_hunter')).toBe(true);
    expect(e.credits).toBe(BALANCE.anomalyFlagCredits + 30);
  });

  it('flags and catalogued tiles survive save and load; v8 saves migrate', () => {
    const { e } = rover('SLEEP 1000');
    const g = delivered(e, { anomaly: true, sx: 4, sy: 4 });
    e.flagAnomaly(g);
    const l = deserialize(JSON.parse(JSON.stringify(serialize(e))));
    expect(l.anomalyTiles).toEqual(['4,4']);
    expect(l.gallery.at(-1)).toMatchObject({ flag: 'hit', anomaly: true });
    expect(l.stats.anomaliesFound).toBe(1);

    const v8 = serialize(rover('SLEEP 10').e) as unknown as Record<string, any>;
    v8.version = 8;
    delete v8.anomalyTiles;
    delete v8.stats.anomaliesFound;
    expect(migrate(v8).anomalyTiles).toEqual([]);
    expect(deserialize(v8).stats.anomaliesFound).toBe(0);
  });
});
