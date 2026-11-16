/**
 * Disassembler: words back to assembly text. Addresses and values are octal; branch and
 * PC-relative targets are shown as absolute addresses (or a name, if `nameOf` knows one).
 */

import { decodeOp, octal } from './isa';

export interface Disassembled {
  address: number;
  /** The instruction words (1–3). */
  words: number[];
  /** e.g. `MOV #3, @#176406`. Unknown opcodes come out as `.WORD 000007`. */
  text: string;
}

export interface DisassembleOptions {
  /** A name for an address (labels, device registers), shown instead of the number. */
  nameOf?: (addr: number) => string | undefined;
}

const REG = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'SP', 'PC'];

/**
 * Disassemble the instruction at `address`. `read` returns the word at an even address
 * (anything for addresses that don't exist; the result is just text).
 */
export function disassemble(read: (addr: number) => number, address: number, opts: DisassembleOptions = {}): Disassembled {
  const words: number[] = [];
  let pc = address & 0xffff;
  const next = (): number => {
    const w = read(pc) & 0xffff;
    words.push(w);
    pc = (pc + 2) & 0xffff;
    return w;
  };
  const name = (a: number): string => opts.nameOf?.(a & 0xffff) ?? octal(a & 0xffff);
  const operand = (spec: number): string => {
    const mode = (spec >> 3) & 7;
    const r = spec & 7;
    const R = REG[r];
    if (r === 7) {
      switch (mode) {
        case 2: return `#${octal(next())}`;
        case 3: return `@#${name(next())}`;
        case 6: { const x = next(); return name(x + pc); }
        case 7: { const x = next(); return `@${name(x + pc)}`; }
      }
    }
    switch (mode) {
      case 0: return R;
      case 1: return `(${R})`;
      case 2: return `(${R})+`;
      case 3: return `@(${R})+`;
      case 4: return `-(${R})`;
      case 5: return `@-(${R})`;
      case 6: return `${octal(next())}(${R})`;
      default: return `@${octal(next())}(${R})`;
    }
  };

  const w = next();
  const op = decodeOp(w);
  let text: string;
  if (!op) {
    text = ccCombination(w) ?? `.WORD ${octal(w)}`;
  } else {
    switch (op.format) {
      case 'double': { const s = operand((w >> 6) & 0o77); text = `${op.name} ${s}, ${operand(w & 0o77)}`; break; }
      case 'single': text = `${op.name} ${operand(w & 0o77)}`; break;
      case 'jsr': text = `JSR ${REG[(w >> 6) & 7]}, ${operand(w & 0o77)}`; break;
      case 'xor': text = `XOR ${REG[(w >> 6) & 7]}, ${operand(w & 0o77)}`; break;
      case 'regsrc': text = `${op.name} ${operand(w & 0o77)}, ${REG[(w >> 6) & 7]}`; break;
      case 'rts': text = `RTS ${REG[w & 7]}`; break;
      case 'branch': {
        const off = w & 0o377;
        const target = pc + 2 * (off & 0o200 ? off - 0o400 : off);
        text = `${op.name} ${name(target)}`;
        break;
      }
      case 'sob': text = `SOB ${REG[(w >> 6) & 7]}, ${name(pc - 2 * (w & 0o77))}`; break;
      case 'trap': text = (w & 0o377) ? `${op.name} ${octal(w & 0o377, 3)}` : op.name; break;
      default: text = op.name;
    }
  }
  return { address: address & 0xffff, words, text };
}

/** `CLC!CLV`-style names for combined flag operations (000241–000277). */
function ccCombination(w: number): string | null {
  if (w < 0o000240 || w >= 0o000300) return null;
  const set = (w & 0o20) !== 0;
  const parts: string[] = [];
  const names = set ? ['SEC', 'SEV', 'SEZ', 'SEN'] : ['CLC', 'CLV', 'CLZ', 'CLN'];
  for (let i = 0; i < 4; i++) if (w & (1 << i)) parts.push(names[i]);
  return parts.length ? parts.join('!') : 'NOP';
}
