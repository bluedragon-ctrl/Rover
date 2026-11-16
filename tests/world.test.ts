import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { CHUNK, ChunkedWorld, worldToChunk } from '../src/core/ChunkedWorld';
import { MapGenerator } from '../src/core/MapGenerator';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer, Status } from '../src/core/types';
import { ALLIN_EXPLORER } from '../src/core/programs';
import { fw, reg, rover, run } from './helpers/rover';
import { T } from '../src/core/WorldRegistry';

describe('chunk math', () => {
  it('maps negative coordinates with floor division', () => {
    expect(worldToChunk(-1, -16)).toEqual({ cx: -1, cy: -1, lx: 15, ly: 0 });
    expect(worldToChunk(16, 15)).toEqual({ cx: 1, cy: 0, lx: 0, ly: 15 });
  });
});

describe('generation', () => {
  it('is independent of generation order and deterministic', () => {
    const a = new ChunkedWorld(new MapGenerator(42));
    const b = new ChunkedWorld(new MapGenerator(42));
    a.getChunk(3, -2);
    a.getChunk(2, -2);
    b.getChunk(2, -2);
    for (let y = -40; y < -16; y++) for (let x = 30; x < 64; x++) for (let l = 0; l < 3; l++) expect(a.getTile(x, y, l)).toBe(b.getTile(x, y, l));
  });

  it('differs between seeds', () => {
    const a = new MapGenerator(1);
    const b = new MapGenerator(2);
    let diff = 0;
    for (let x = 0; x < 200; x++) if (a.tileAt(x, 50).terrain !== b.tileAt(x, 50).terrain || a.tileAt(x, 50).obstacle !== b.tileAt(x, 50).obstacle) diff++;
    expect(diff).toBeGreaterThan(0);
  });

  it('keeps a clear landing zone', () => {
    const g = new MapGenerator(7);
    const r = BALANCE.landingZoneRadius;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) expect(g.tileAt(x, y)).toEqual({ terrain: T.FLAT_SAND, obstacle: 0, item: 0 });
  });

  it('produces a mix of features', () => {
    const g = new MapGenerator(99);
    const seen = new Set<number>();
    for (let y = -150; y < 150; y += 1) for (let x = -150; x < 150; x += 3) {
      const t = g.tileAt(x, y);
      seen.add(t.terrain).add(t.obstacle).add(t.item);
    }
    for (const id of [T.FLAT_SAND, T.ROUGH_GRAVEL, T.ACID_VENT, T.CLIFF_WALL, T.IRON_ORE, T.SILICON_ORE, T.SAMPLE]) expect(seen).toContain(id);
  });

  it('evicts only clean, stale chunks and regenerates them identically', () => {
    const w = new ChunkedWorld(new MapGenerator(5));
    const before = w.getTile(100, 100, 0);
    w.setTile(0, 0, Layer.ITEM, T.SAMPLE);
    w.now = 10_000;
    w.evictStale(600);
    expect(w.hasChunk(0, 0)).toBe(true);
    expect(w.hasChunk(Math.floor(100 / CHUNK), Math.floor(100 / CHUNK))).toBe(false);
    expect(w.getTile(100, 100, 0)).toBe(before);
  });
});

const step = (dir: string, n: number, dst: string) => `MOV  #${dir}, R0\n        MOV  #${n}., R1\n        JSR  PC, STEP\n        MOV  R0, ${dst}`;
const scan = (dir: string, hit: string, dist: string) => `MOV  #${dir}, R0\n        JSR  PC, SCAN\n        MOV  @#RADHIT, ${hit}\n        MOV  @#RADDST, ${dist}`;

describe('engine hardware', () => {
  const wall = (e: SimulationEngine) => e.world.setTile(3, 0, Layer.OBSTACLE, T.CLIFF_WALL);

  it('STEP moves tile by tile and stops at walls with E.BLK', () => {
    const { e, u } = rover(fw(step('EAST', 5, 'R2')), { seed: 3, setup: wall });
    run(e, 40);
    expect([u.x, u.y]).toEqual([2, 0]);
    expect(reg(u, 2)).toBe(Status.ERR_BLOCKED);
    expect(u.energy).toBeLessThan(BALANCE.batteryCapacity - 2 * 40);
  });

  it('SCAN reports the first obstacle and its distance', () => {
    const { e, u } = rover(fw(scan('EAST', 'R2', 'R3'), scan('WEST', 'R4', 'R5')), { seed: 3, setup: wall });
    run(e, 8);
    expect([reg(u, 2), reg(u, 3)]).toEqual([T.CLIFF_WALL, 3]);
    expect(reg(u, 4)).toBe(0);
  });

  it('SCAN sees other rovers', () => {
    const { e, u } = rover(fw(scan('NORTH', 'R2', 'R3')), { seed: 3, setup: (e) => e.spawnUnit('b', 0, 2) });
    run(e, 6); // boot, then the sweep takes a tick
    expect([reg(u, 2), reg(u, 3)]).toEqual([T.ROVER, 2]);
  });

  it('acid vents damage hull and abort the move with E.HAZ', () => {
    const { e, u } = rover(fw(step('NORTH', 3, 'R2')), { seed: 3, setup: (e) => e.world.setTile(0, 1, Layer.TERRAIN, T.ACID_VENT) });
    run(e, 20);
    expect([u.x, u.y]).toEqual([0, 1]);
    expect(u.hull).toBe(90);
    expect(reg(u, 2)).toBe(Status.ERR_HAZARD);
  });

  it('powers off when the battery is empty and admin can recover', () => {
    const { e, u } = rover('START:  INC  R0\n        BR   START', { seed: 3 });
    u.energy = 5;
    run(e, 5);
    expect(u.cpu.state).toBe(CpuState.POWER_OFF);
    e.admin.forceCharge(u);
    e.advanceTick();
    expect(u.cpu.state).toBe(CpuState.RUNNING);
  });

  it('is deterministic: same seed and firmware give the same run', () => {
    const once = () => {
      const e = new SimulationEngine({ seed: 11 });
      const u = e.spawnUnit('t');
      e.upload(u, ALLIN_EXPLORER, { factory: true });
      run(e, 2000);
      return [u.x, u.y, u.energy, u.hull];
    };
    expect(once()).toEqual(once());
  });
});

describe('all-in-one firmware', () => {
  it('the Explorer explores for 5000 ticks without faulting', () => {
    const e = new SimulationEngine({ seed: 12345 });
    const u = e.spawnUnit('t');
    expect(e.upload(u, ALLIN_EXPLORER, { factory: true }).errors).toEqual([]);
    const visited = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      e.advanceTick();
      expect(u.cpu.state === CpuState.FAULT).toBe(false);
      visited.add(`${u.x},${u.y}`);
    }
    expect(visited.size).toBeGreaterThan(30);
  });
});
