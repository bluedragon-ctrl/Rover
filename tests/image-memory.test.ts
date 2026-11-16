import { describe, expect, it } from 'vitest';
import { BALANCE } from '../src/core/balance';
import { Level } from '../src/core/downlink';
import { productFrame } from '../src/core/imaging';
import { photoBytes } from '../src/core/photos';
import { PDP_PROGRAM_TEMPLATES } from '../src/core/programs-pdp11';
import { deserialize, serialize } from '../src/core/SaveManager';
import type { SimulationEngine } from '../src/core/SimulationEngine';
import { CpuState, Layer } from '../src/core/types';
import type { Unit } from '../src/core/Unit';
import { T } from '../src/core/WorldRegistry';
import { hexDump } from '../src/ui/GalleryPanel';
import { toolchain } from '../src/ui/toolchain';
import { factory, fw, HANG, rover as base, run } from './helpers/rover';

function until(e: SimulationEngine, cond: () => boolean, max = 5000): void {
  for (let i = 0; i < max && !cond(); i++) run(e, 1, true);
  expect(cond()).toBe(true);
}

/** Rover on cleared flat sand, a cliff two tiles north. */
function rover(firmware: string, link = true): { e: SimulationEngine; u: Unit } {
  return base(firmware, { seed: 5, flat: true, setup: (e, u) => {
    e.world.setTile(0, 2, Layer.OBSTACLE, T.CLIFF_WALL);
    if (!link) u.antennaHealth = 0;
  } });
}

const snap = (mode: string) => `MOV  #NORTH, R0\n        MOV  #${mode}, R1\n        JSR  PC, SNAP`;
const send = 'CLR  R0\n        JSR  PC, SNDIMG';
const edit = 'MOVB #-1, @#IMGBAS';

describe('Darkroom: first-edit bonus per camera mode (M12 slice 3)', () => {
  // Edit one byte, or none, after each SNAP: mode 1, 1 again, raw 1, then mode 2.
  const src = fw(snap('F.M1'), edit, send, snap('F.M1'), edit, send, snap('F.M1'), send, snap('F.M2'), edit, send);

  it('pays +editFirstBonus once per photo type for lit edited photos and completes Darkroom', () => {
    const { e } = rover(src);
    const c0 = e.credits;
    until(e, () => e.gallery.length === 4, 6000);
    run(e, 20); // goals are checked every 10 ticks
    const P = BALANCE.photoCredits, S = BALANCE.photoFirstBonus, X = BALANCE.editFirstBonus;
    expect(e.gallery.map((g) => [g.type, g.level])).toEqual([[1, Level.EDITED], [1, Level.EDITED], [1, undefined], [2, Level.EDITED]]);
    expect(e.gallery.map((g) => g.credits)).toEqual([P + S + X, P, P, P + X]);
    expect(e.editedTypes).toEqual([1, 2]);
    expect(e.stats.photosEdited).toBe(3);
    expect(e.director.completed.has('darkroom')).toBe(true);
    const darkroom = 15;
    expect(e.credits - c0).toBeGreaterThanOrEqual(P * 4 + S + X * 2 + darkroom);
  });

  it('dark and drawn pictures earn no edit bonus', () => {
    const { e } = rover(fw('JSR  PC, ERASE', edit, 'MOV  #1, R0', 'JSR  PC, SNDIMG'));
    until(e, () => e.gallery.length === 1, 3000);
    expect(e.gallery[0]).toMatchObject({ level: Level.DRAWN, credits: 0 });
    expect(e.editedTypes).toEqual([]);
    expect(e.stats.photosEdited).toBe(0);
  });

  it('saves the credited modes', () => {
    const { e } = rover(src);
    until(e, () => e.editedTypes.length === 1, 4000);
    const back = deserialize(JSON.parse(JSON.stringify(serialize(e))));
    expect(back.editedTypes).toEqual([1]);
    expect(back.stats.photosEdited).toBe(1);
  });
});

describe('image memory (SPEC §3.8.7)', () => {
  it('Mk-I has 1 KB at IMGBAS (modes 1 and 2), zero at first', () => {
    const { u } = rover(`START:${HANG}`);
    expect(u.img).toHaveLength(photoBytes(1));
    expect([...u.img].every((b) => b === 0)).toBe(true);
  });

  it('is non-volatile: survives a reboot and power-off; grows with camera upgrades', () => {
    const { e, u } = rover(fw('MOVB #77, @#IMGBAS+3'));
    run(e, 6);
    expect(u.img[3]).toBe(0o77);
    e.upload(u, `START:${HANG}`, factory);
    run(e, 6);
    expect(u.img[3]).toBe(0o77);
    u.capture = { type: 1, subject: 0, x: 0, y: 0, noise: { tick: 0, seq: 0 } };
    u.energy = 1;
    run(e, 3);
    expect(u.cpu.state).toBe(CpuState.POWER_OFF);
    expect(u.img[3]).toBe(0o77);
    expect(u.capture).not.toBeNull();

    const g = rover(fw('MOVB #77, @#IMGBAS+3'));
    run(g.e, 6);
    for (const id of ['REC_4K', 'CAM_HIRES']) g.e.installUpgrade(g.u, id);
    expect(g.u.imageMemory()).toHaveLength(photoBytes(4));
    expect(g.u.img[3]).toBe(0o77);
  });
});

describe('Code tab helpers', () => {
  it('warns about SNAP without SNDIMG, unless one of the two slots sends', () => {
    const { e, u } = rover(`START:${HANG}`);
    const tc = toolchain(e);
    const b = (src: string, slot: 'firmware' | 'program' = 'program') => tc.build(u, src, slot);
    expect(tc.snapsWithoutSend(b(`START:  ${snap('F.M1')}\n        HALT`), null)).toBe(true);
    expect(tc.snapsWithoutSend(b(`START:  ${snap('F.M1')}\n        ${send}\n        HALT`), null)).toBe(false);
    expect(tc.snapsWithoutSend(b(`START:  ${snap('F.M1')}\n        HALT`), b(`START:  ${send}${HANG}`, 'firmware'))).toBe(false);
    for (const [name, src] of Object.entries(PDP_PROGRAM_TEMPLATES)) if (name !== 'Image: Memory map') expect(tc.snapsWithoutSend(b(src), null), name).toBe(false);
  });

  it('hex view: header decoded with its level, payload rows by image memory address', () => {
    const { e } = rover(fw('MOVB #253, @#IMGBAS+21', 'MOV  #1, R0', 'JSR  PC, SNDIMG'));
    until(e, () => e.gallery.length === 1);
    const frame = productFrame(e.seed, e.gallery[0]);
    const lines = hexDump(frame, frame.length).split('\n');
    expect(lines[0]).toBe('header  8C  photo · drawn');
    expect(lines[2]).toBe('000     00 00 00 00 00 00 00 00  00 00 00 00 00 00 00 00');
    expect(lines[3]).toBe('010     00 AB 00 00 00 00 00 00  00 00 00 00 00 00 00 00');
    expect(lines).toHaveLength(2 + photoBytes(1) / 16);
    expect(hexDump(frame.slice(0, 20), frame.length).split('\n').at(-1)).toBe(`        … ${frame.length - 20} B not received yet`);
  });
});
