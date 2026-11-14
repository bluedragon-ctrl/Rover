import type { CompileResult, Slot } from '../core/vm/Compiler';
import { formatAddr } from '../core/vm/isa';

/** One row of the assembler listing (SPEC §5.7.1): address | hex | source. */
export interface ListingRow {
  /** 1-based source line. */
  line: number;
  /** Byte address (instructions, and labels: the address they name); null for directives. */
  addr: number | null;
  /** Machine code; null when the slot does not assemble (sizes are then estimates). */
  bytes: number[] | null;
  /** Number of bytes (also known for lines with errors, as an estimate). */
  size: number;
  /** Source text without the comment. */
  code: string;
  comment: string;
  /** 'data': a DATA line (M14); its bytes sit in the data section after the code. */
  kind: 'instr' | 'data' | 'label' | 'directive';
  error?: string;
}

export interface Listing {
  slot: Slot;
  rows: ListingRow[];
  /** Slot size in bytes. */
  bytes: number;
  ok: boolean;
}

/** Hex bytes per listing row; longer instructions continue on the next row. */
export const LISTING_BYTES_PER_ROW = 6;

/** `base`: code address of the first byte (ROM_BASE for the ROM listing, M14). */
export function buildListing(source: string, res: CompileResult, slot: Slot, base = 0): Listing {
  const rows: ListingRow[] = [];
  const prog = res.program;
  const errs = new Map<number, string>();
  for (const e of res.errors) if (!errs.has(e.line)) errs.set(e.line, e.message);
  let addr = 0;
  source.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    const semi = text.indexOf(';');
    const code = (semi >= 0 ? text.slice(0, semi) : text).trimEnd();
    const comment = semi >= 0 ? text.slice(semi) : '';
    const body = code.trim();
    const size = res.lineBytes[line] ?? 0;
    const error = errs.get(line);
    if (size) {
      // DATA lines (M14) carry their address in the data section after the code.
      const isData = /^(?:[A-Za-z_][A-Za-z0-9_]*:\s*)?DATA\b/i.test(body);
      const at = res.lineAddr?.[line] ?? addr;
      rows.push({ line, addr: base + at, bytes: prog ? prog.code.slice(at, at + size) : null, size, code, comment, kind: isData ? 'data' : 'instr', error });
      if (!isData) addr = at + size;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(body)) rows.push({ line, addr: base + addr, bytes: null, size: 0, code, comment, kind: 'label', error });
    else if (body) rows.push({ line, addr: null, bytes: null, size: 0, code, comment, kind: 'directive', error });
    else if (error) rows.push({ line, addr: null, bytes: null, size: 0, code, comment, kind: 'directive', error });
  });
  return { slot, rows, bytes: res.flashUsed, ok: !!prog };
}

/** Plain-text listing, like an assembler's .lst file (tests, copy & paste). */
export function listingText(l: Listing): string {
  const out: string[] = [];
  const w = LISTING_BYTES_PER_ROW * 3 - 1;
  for (const r of l.rows) {
    const a = r.addr === null ? ''.padEnd(10) : formatAddr(r.addr, l.slot).padEnd(10);
    const chunks = r.kind !== 'instr' && r.kind !== 'data' ? [''] : chunk(r.bytes ?? new Array(r.size).fill(-1));
    chunks.forEach((c, i) => {
      const hex = c.padEnd(w);
      if (i === 0) out.push(`${a} ${hex}  ${r.code.trim()}`.trimEnd());
      else out.push(`${formatAddr(r.addr! + i * LISTING_BYTES_PER_ROW, l.slot).padEnd(10)} ${c}`);
    });
  }
  return out.join('\n');
}

/** Hex strings of a byte run, LISTING_BYTES_PER_ROW per row ('??' for unknown bytes). */
export function chunk(bytes: readonly number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += LISTING_BYTES_PER_ROW)
    out.push(
      bytes
        .slice(i, i + LISTING_BYTES_PER_ROW)
        .map((b) => (b < 0 ? '??' : b.toString(16).toUpperCase().padStart(2, '0')))
        .join(' '),
    );
  return out.length ? out : [''];
}
