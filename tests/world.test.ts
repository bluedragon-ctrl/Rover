import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { CHUNK, ChunkedWorld, worldToChunk } from '../src/core/ChunkedWorld';
import { MapGenerator } from '../src/core/MapGenerator';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Dir, Layer, Status } from '../src/core/types';
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

describe('engine hardware', () => {
  function engineWithWall() {
    const eng = new SimulationEngine({ seed: 3 });
    eng.world.setTile(3, 0, Layer.OBSTACLE, T.CLIFF_WALL);
    return eng;
  }

  it('STEP moves tile by tile and stops at walls with ERR_BLOCKED', () => {
    const eng = engineWithWall();
    const u = eng.spawnUnit('t');
    eng.upload(u, 'CALL STEP EAST 5\nMOV r0 @STATUS\nCALL SLEEP 1000');
    for (let i = 0; i < 40; i++) eng.advanceTick();
    expect([u.x, u.y]).toEqual([2, 0]);
    expect(u.vm.regs[0]).toBe(Status.ERR_BLOCKED);
    expect(u.energy).toBeLessThan(BALANCE.batteryCapacity - 2 * 40);
  });

  it('SCAN reports the first obstacle and its distance', () => {
    const eng = engineWithWall();
    const u = eng.spawnUnit('t');
    eng.upload(u, 'CALL SCAN EAST\nMOV r0 @RADAR_HIT\nMOV r1 @RADAR_DIST\nCALL SCAN WEST\nMOV r2 @RADAR_HIT\nMOV r3 @RADAR_DIST\nCALL SLEEP 1000');
    for (let i = 0; i < 5; i++) eng.advanceTick();
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([T.CLIFF_WALL, 3]);
    expect(u.vm.regs[2]).toBe(0);
  });

  it('SCAN sees other rovers', () => {
    const eng = new SimulationEngine({ seed: 3 });
    const u = eng.spawnUnit('a');
    eng.spawnUnit('b', 0, 2);
    eng.upload(u, 'CALL SCAN NORTH\nMOV r0 @RADAR_HIT\nMOV r1 @RADAR_DIST\nCALL SLEEP 1000');
    eng.advanceTick();
    eng.advanceTick(); // the sweep takes a tick
    expect([u.vm.regs[0], u.vm.regs[1]]).toEqual([T.ROVER, 2]);
  });

  it('acid vents damage hull and abort the move with ERR_HAZARD', () => {
    const eng = new SimulationEngine({ seed: 3 });
    eng.world.setTile(0, 1, Layer.TERRAIN, T.ACID_VENT);
    const u = eng.spawnUnit('t');
    eng.upload(u, `CALL STEP ${Dir.NORTH} 3\nMOV r0 @STATUS\nCALL SLEEP 1000`);
    for (let i = 0; i < 20; i++) eng.advanceTick();
    expect([u.x, u.y]).toEqual([0, 1]);
    expect(u.hull).toBe(90);
    expect(u.vm.regs[0]).toBe(Status.ERR_HAZARD);
  });

  it('powers off when the battery is empty and admin can recover', () => {
    const eng = new SimulationEngine({ seed: 3 });
    const u = eng.spawnUnit('t');
    eng.upload(u, 'ADD r0 1');
    u.energy = 5;
    for (let i = 0; i < 5; i++) eng.advanceTick();
    expect(u.vm.state).toBe(CpuState.POWER_OFF);
    eng.admin.forceCharge(u);
    eng.advanceTick();
    expect(u.vm.state).toBe(CpuState.RUNNING);
  });

  it('is deterministic: same seed and program give the same run', () => {
    const run = () => {
      const eng = new SimulationEngine({ seed: 11 });
      const u = eng.spawnUnit('t');
      eng.upload(u, 'CALL SCAN r0\nMOV r1 @RADAR_HIT\nMOV r2 @RADAR_DIST\nJEQ r1 NONE go\nADD r0 1\nMOD r0 4\ngo: CALL STEP r0 2');
      for (let i = 0; i < 2000; i++) eng.advanceTick();
      return [u.x, u.y, u.energy, u.hull];
    };
    expect(run()).toEqual(run());
  });
});

describe('demo firmware', () => {
  it('explores for 5000 ticks without faulting', async () => {
    const { DEMO_EXPLORER } = await import('../src/core/programs');
    const eng = new SimulationEngine({ seed: 12345 });
    const u = eng.spawnUnit('t');
    expect(eng.upload(u, DEMO_EXPLORER, { factory: true }).errors).toEqual([]);
    const visited = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      eng.advanceTick();
      expect(u.vm.state === CpuState.FAULT).toBe(false);
      visited.add(`${u.x},${u.y}`);
    }
    expect(visited.size).toBeGreaterThan(30);
  });
});
