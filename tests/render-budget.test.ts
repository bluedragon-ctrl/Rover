import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CHUNK } from '../src/core/ChunkedWorld';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { ChunkPool } from '../src/render/ChunkPool';
import { FrameStats, percentile } from '../src/render/FrameStats';
import { TileLighting } from '../src/render/TileLighting';

/**
 * Renderer geometry baseline (runs headless: geometry only, no WebGL). Budgets are ~1.5×
 * the measured numbers, so a shape change that blows up vertex counts fails here first.
 */
describe('render geometry budget', () => {
  function measure(revealAll: boolean) {
    const eng = new SimulationEngine({ seed: 1 });
    const pool = new ChunkPool(eng, new THREE.Group(), new TileLighting());
    pool.setRevealAll(revealAll);
    pool.maxBuildsPerFrame = 1000;
    pool.buildBudgetMs = Infinity;
    const t0 = performance.now();
    pool.update(CHUNK * 4 + 8, CHUNK * 4 + 8, 2); // 5×5 chunks, mostly unmapped
    const ms = performance.now() - t0;
    let hidden = 0;
    for (const e of (pool as unknown as { entries: Map<string, { lines: THREE.LineSegments }> }).entries.values())
      for (let i = 3, a = e.lines.geometry.getAttribute('col').array; i < a.length; i += 4) hidden += a[i] ? 1 : 0;
    return { chunks: pool.size, lineVerts: pool.lineVertices, fillTris: pool.fillTriangles, hidden, ms };
  }

  it('stays within the line/fill budget for a 5×5 chunk view', () => {
    const fog = measure(false);
    const all = measure(true);
    // Baseline (seed 1, M8): 25 chunks, 204k line verts with fog (179k of them hidden
    // real geometry, the rest survey crosses), 72k fill tris, ~4 ms per chunk build.
    expect(fog.chunks).toBe(25);
    const perChunk = fog.lineVerts / fog.chunks;
    expect(perChunk).toBeLessThan(12000);
    expect(fog.fillTris / fog.chunks).toBeLessThan(4500);
    // Unmapped tiles carry their real geometry (hidden) plus the survey cross.
    expect(fog.hidden).toBeGreaterThan(0);
    expect(fog.lineVerts).toBeGreaterThan(all.lineVerts);
    expect(all.hidden).toBe(0);
    expect(fog.lineVerts).toBeLessThan(all.lineVerts * 1.3);
  });

  it('spreads chunk rebuilds over frames within the time budget', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const pool = new ChunkPool(eng, new THREE.Group(), new TileLighting());
    pool.buildBudgetMs = 0; // one chunk per frame
    pool.update(8, 8, 2);
    expect(pool.lastBuilds).toBe(1);
    expect(pool.size).toBe(1);
    for (let i = 0; i < 30 && pool.size < 25; i++) pool.update(8, 8, 2);
    expect(pool.size).toBe(25);
  });
});

describe('FrameStats', () => {
  it('averages a rolling window and reports hitches', () => {
    const s = new FrameStats(4);
    for (const ms of [16, 16, 16, 50, 16, 16]) s.push(ms, 2);
    expect(s.samples).toBe(4);
    expect(s.avgMs).toBeCloseTo((50 + 16 * 3) / 4);
    expect(s.worstMs).toBe(50);
    expect(s.p95Ms).toBe(50);
    expect(s.cpuMs).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
  });
});

describe('chunk fog updates', () => {
  /** Visible line segments of a chunk mesh as sorted strings (flag 0 only). */
  function visibleSegs(geo: THREE.BufferGeometry): string[] {
    const p = geo.getAttribute('position').array;
    const c = geo.getAttribute('col').array;
    const out: string[] = [];
    for (let v = 0; v < p.length / 3; v += 2) {
      if (c[v * 4 + 3] !== 0) continue;
      out.push([...p.slice(v * 3, v * 3 + 6)].map((n) => n.toFixed(3)).join(','));
    }
    return out.sort();
  }

  it('patches newly mapped tiles in place instead of rebuilding, with the same visible result', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const pool = new ChunkPool(eng, new THREE.Group(), new TileLighting());
    pool.update(8, 8, 0); // chunk (0, 0)
    expect(pool.lastBuilds).toBe(1);
    const entry = (pool as unknown as { entries: Map<string, { lines: THREE.LineSegments; fills: THREE.Mesh }> }).entries.values().next().value!;
    // Map a strip of tiles that are still unmapped.
    const chunk = eng.world.getChunk(0, 0);
    let mapped = 0;
    for (let y = 0; y < CHUNK; y++)
      for (let x = 0; x < CHUNK; x++)
        if (!eng.world.isMapped(x, y) && mapped < 20) {
          eng.world.revealTile(x, y);
          mapped++;
        }
    expect(mapped).toBeGreaterThan(0);
    pool.update(8, 8, 0);
    expect(pool.lastBuilds).toBe(0);
    expect(pool.lastPatches).toBe(1);
    const fresh = pool.buildGeometry(chunk);
    expect(visibleSegs(entry.lines.geometry)).toEqual(visibleSegs(fresh.lines));
    const fillVisible = (g: THREE.BufferGeometry) => [...(g.getAttribute('col').array as Uint16Array)].filter((_, i) => i % 4 === 3 && _ === 0).length;
    expect(fillVisible(entry.fills.geometry)).toBe(fillVisible(fresh.fills));
    // A real tile change still rebuilds.
    eng.world.setTile(3, 3, 1, 0);
    eng.world.setTile(3, 3, 2, 0);
    eng.world.setTile(3, 3, 0, eng.world.getTile(3, 3, 0) === 1 ? 2 : 1);
    pool.update(8, 8, 0);
    expect(pool.lastBuilds).toBe(1);
  });

  it('rebuilds when reveal-all is toggled', () => {
    const eng = new SimulationEngine({ seed: 1 });
    const pool = new ChunkPool(eng, new THREE.Group(), new TileLighting());
    pool.update(8, 8, 0);
    pool.setRevealAll(true);
    pool.update(8, 8, 0);
    expect(pool.lastBuilds).toBe(1);
  });
});
