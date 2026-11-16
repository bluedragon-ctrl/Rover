import { describe, expect, it } from 'vitest';
import { PDP_DEFAULT_FIRMWARE, PDP_FIRMWARE_TEMPLATES, PDP_FIRST_STEPS, PDP_IMAGE_NEGATIVE, PDP_PROGRAM_TEMPLATES } from '../src/core/programs-pdp11';
import { SimulationEngine } from '../src/core/SimulationEngine';
import { oct6, pdpListing, pdpRegions, toolchain } from '../src/ui/toolchain';

// M15 slice 5: the Code tab's view of the PDP-11 core (headless parts).

function setup() {
  const e = new SimulationEngine({ seed: 1, cpu: 'pdp11' });
  const u = e.spawnUnit('t');
  return { e, u, tc: toolchain(e) };
}

describe('PDP-11 toolchain for the Code tab', () => {
  it('picks MACRO-11 templates and octal addresses for a PDP-11 engine', () => {
    const { tc } = setup();
    expect(tc.pdp).toBe(true);
    expect(tc.templates('program')).toBe(PDP_PROGRAM_TEMPLATES);
    expect(tc.templates('firmware')).toBe(PDP_FIRMWARE_TEMPLATES);
    expect(tc.addr(0o2000, 'program')).toBe('002000');
    expect(toolchain(new SimulationEngine({ seed: 1 })).pdp).toBe(false);
  });

  it('builds every template; sizes fit the regions', () => {
    const { u, tc } = setup();
    const r = pdpRegions(u);
    expect(r).toEqual({ fw: 0o1600, prog: 2048 - 2 - 0o2000 });
    for (const [slot, set] of [['program', PDP_PROGRAM_TEMPLATES], ['firmware', PDP_FIRMWARE_TEMPLATES]] as const)
      for (const [name, src] of Object.entries(set)) {
        const b = tc.build(u, src, slot);
        expect(b.errors, name).toEqual([]);
        expect(b.bytes, name).toBeLessThanOrEqual(slot === 'program' ? r.prog : r.fw);
      }
  });

  it('maps instruction addresses to source lines', () => {
    const { u, tc } = setup();
    const b = tc.build(u, PDP_FIRST_STEPS, 'program');
    const start = b.pdp!.asm.symbols.get('START')!;
    const line = PDP_FIRST_STEPS.split('\n').findIndex((l) => l.startsWith('START:')) + 1;
    expect(b.lineAt(start)).toBe(line);
    expect(b.lineAt(0o177776)).toBe(0);
  });

  it('reports errors and warnings with their lines', () => {
    const { u, tc } = setup();
    const b = tc.build(u, 'START:  MOV #1, NOPE\n        HALT', 'program');
    expect(b.ok).toBe(false);
    expect(b.errors[0]).toMatchObject({ line: 1 });
    const w = tc.build(u, 'START:  HALT\nNOP=5', 'program');
    expect(w.ok).toBe(true);
    expect(w.warnings[0]).toMatchObject({ line: 2 });
  });

  it('the listing splits address, octal words and source, and marks errors', () => {
    const { u, tc } = setup();
    const b = tc.build(u, 'START:  MOV #3, R1\nLOOP:   BR LOOP\nD:      .WORD 7\n        CLR Q\n', 'program');
    const rows = pdpListing(b);
    expect(rows[0]).toMatchObject({ line: 1, addr: '002000', code: ['012701', '000003'], kind: 'instr' });
    expect(rows[0].source).toMatch(/^START:\s+MOV #3, R1/);
    expect(rows[1]).toMatchObject({ addr: '002004', code: ['000777'], kind: 'instr' });
    expect(rows[2]).toMatchObject({ addr: '002006', code: ['000007'], kind: 'data' });
    expect(rows.find((r) => r.line === 4)?.error).toMatch(/undefined symbol Q/);
  });

  it('knows which firmware runs a program and which code photographs without sending', () => {
    const { u, tc } = setup();
    expect(tc.runsProgram(tc.build(u, PDP_DEFAULT_FIRMWARE, 'firmware'))).toBe(true);
    expect(tc.runsProgram(tc.build(u, PDP_FIRMWARE_TEMPLATES['All-in-one Explorer (no program)'], 'firmware'))).toBe(false);
    const snapOnly = tc.build(u, 'START:  CLR R0\n        MOV #F.M1, R1\n        JSR PC, SNAP   ; SNDIMG in a comment does not count\n        HALT', 'program');
    expect(tc.snapsWithoutSend(snapOnly, null)).toBe(true);
    expect(tc.snapsWithoutSend(tc.build(u, PDP_IMAGE_NEGATIVE, 'program'), null)).toBe(false);
  });

  it('formats words as six octal digits', () => {
    expect(oct6(0)).toBe('000000');
    expect(oct6(-1)).toBe('177777');
  });
});
