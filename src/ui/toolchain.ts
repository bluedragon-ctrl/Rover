/**
 * What the Code tab, Comms and the debugger need to know about the rover's computer: the
 * editor language, assembling a slot, templates, region sizes, the listing and the address
 * format. No DOM.
 */
import type { Extension } from '@codemirror/state';
import { PDP11 } from '../core/balance';
import type { ImageResult } from '../core/machine/RoverMachine';
import { PDP_FIRMWARE_TEMPLATES, PDP_PROGRAM_TEMPLATES } from '../core/programs-pdp11';
import type { SimulationEngine, Slot } from '../core/SimulationEngine';
import type { Unit } from '../core/Unit';
import { macro11, macro11Highlight } from '../pdp11/codemirror';

export interface Diag {
  line: number;
  message: string;
}

/** A slot's source assembled for the rover. */
export interface SlotBuild {
  ok: boolean;
  errors: Diag[];
  warnings: Diag[];
  /** Image size in bytes (an estimate when it does not assemble). */
  bytes: number;
  /** Source line of the instruction at an address (0 if none). */
  lineAt: (addr: number) => number;
  /** The assembler's result. */
  pdp: ImageResult;
}

/** One row of the listing pane. */
export interface ListingRowView {
  line: number;
  /** Address column, '' for rows without one. */
  addr: string;
  /** Machine code column (hex bytes or octal words). */
  code: string[];
  source: string;
  kind: 'instr' | 'data' | 'label' | 'directive';
  error?: string;
}

/** Octal word, six digits. */
export const oct6 = (v: number): string => (v & 0xffff).toString(8).padStart(6, '0');

/** The program's core region ends below its first stack word (its return address). */
export const pdpRegions = (u: Unit): { fw: number; prog: number } => ({
  fw: PDP11.programBase - PDP11.firmwareBase,
  prog: u.machine.coreBytes - 2 - PDP11.programBase,
});

const stripComments = (src: string): string => src.replace(/;[^\n]*/g, '');
const usesName = (src: string, re: RegExp): boolean => re.test(stripComments(src));

export interface Toolchain {
  readonly language: Extension[];
  build(u: Unit, source: string, slot: Slot): SlotBuild;
  templates(slot: Slot): Record<string, string>;
  /** Address as the listing and dumps write it. */
  addr(addr: number, slot: Slot): string;
  /** Does this firmware run the program at all? */
  runsProgram(b: SlotBuild): boolean;
  /** Does `b` take photos that neither slot ever sends? */
  snapsWithoutSend(b: SlotBuild | null, other: SlotBuild | null): boolean;
}

function pdpBuild(e: SimulationEngine, u: Unit, source: string, slot: Slot): SlotBuild {
  const r = e.assembleFor(u, source, slot);
  const lines = r.asm.lineAt;
  return {
    ok: !!r.image,
    errors: r.errors.map((x) => ({ line: x.line, message: x.message })),
    warnings: r.asm.warnings.map((x) => ({ line: x.line, message: x.message })),
    bytes: r.asm.bytes.length,
    lineAt: (addr) => lines.get(addr) ?? 0,
    pdp: r,
  };
}

/**
 * The MACRO-11 listing, row by row: `addr  words  source` in fixed columns (address 0–5,
 * words from 8, source from 30), as `src/pdp11/assembler.ts` writes it.
 */
export function pdpListing(b: SlotBuild): ListingRowView[] {
  const asm = b.pdp.asm;
  const errs = new Map<number, string>();
  for (const e of b.errors) if (!errs.has(e.line)) errs.set(e.line, e.message);
  const codeLines = new Set(asm.lines.filter((l) => l.code).map((l) => l.line));
  const seen = new Set<number>();
  return asm.listingRows.map((r) => {
    const t = r.text;
    const addr = t.slice(0, 6).trim();
    const words = t.slice(8, 30).trim();
    const source = t.slice(30);
    const kind: ListingRowView['kind'] = !addr ? 'directive' : words ? (codeLines.has(r.line) ? 'instr' : 'data') : 'label';
    const first = !seen.has(r.line);
    seen.add(r.line);
    return { line: r.line, addr, code: words ? words.split(/\s+/) : [], source, kind, error: first ? errs.get(r.line) : undefined };
  });
}

export function toolchain(e: SimulationEngine): Toolchain {
  return {
    language: [macro11, macro11Highlight],
    build: (u, src, slot) => pdpBuild(e, u, src, slot),
    templates: (slot) => (slot === 'program' ? PDP_PROGRAM_TEMPLATES : PDP_FIRMWARE_TEMPLATES),
    addr: (a) => oct6(a),
    // The gate: `PRGCS` (GO) directly or the ROM's RUN driver.
    runsProgram: (b) => usesName(b.pdp.image?.source ?? '', /\b(RUN|PRGCS)\b/i),
    snapsWithoutSend: (b, other) => {
      const src = (x: SlotBuild | null) => (x?.pdp.image?.source ? stripComments(x.pdp.image.source) : '');
      const a = src(b);
      if (!/\bSNAP\b/i.test(a)) return false;
      return !/\b(SNDIMG|RECBUF)\b/i.test(a + src(other));
    },
  };
}

/** The builds of the code on the rover, redone only when an upload changed it. */
export class RoverBuilds {
  private key = '\u0000';
  private builds: Record<Slot, SlotBuild | null> = { firmware: null, program: null };

  constructor(readonly tc: Toolchain) {}

  /** Both slots as uploaded (program null while there is none), and whether they changed. */
  get(u: Unit): { b: Record<Slot, SlotBuild | null>; changed: boolean } {
    const key = `${u.id}\u0000${u.sourceCode}\u0000${u.programSource}`;
    if (key === this.key) return { b: this.builds, changed: false };
    this.key = key;
    this.builds = { firmware: this.tc.build(u, u.sourceCode, 'firmware'), program: u.programSource ? this.tc.build(u, u.programSource, 'program') : null };
    return { b: this.builds, changed: true };
  }

  /** Source line of an address in a slot's uploaded code (0 if none). */
  lineAt(u: Unit, slot: Slot, addr: number): number {
    return this.get(u).b[slot]?.lineAt(addr) ?? 0;
  }
}
