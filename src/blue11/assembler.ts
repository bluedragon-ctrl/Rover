/**
 * The Blue-11 assembler (a subset of the original assembler syntax): one source file, absolute addresses, two passes.
 *
 * Syntax: `label: OPCODE src, dst ; comment`, `NAME = expr`, `NAME = %n` (register
 * symbol), `. = expr`. Numbers are octal; a trailing `.` makes them decimal; `^D` `^O`
 * `^B` name the radix; `'A` is a character, `"AB` two. Expressions run strictly left to
 * right with `< >` for grouping; operators `+ - * / & !`, unary `-`, `^C` (complement).
 * Local labels `1$`–`65535$` live between two ordinary labels.
 *
 * Errors are returned, never thrown.
 */

import { BY_NAME, octal, type OpInfo } from './isa';

export type NameStyle = 'dec' | 'long';

export interface AssembleOptions {
  /** Where the location counter starts. Default 001000. */
  origin?: number;
  /** Predefined symbols (device registers, constants), like DEC's system macro library. */
  symbols?: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
  /**
   * `dec` (default): names are 1–6 characters of letters, digits, `.` and `$`, as in
   * the original assembler (longer names are an error rather than silently cut to six).
   * `long`: any length, and `_` allowed.
   */
  names?: NameStyle;
  /**
   * Accept `^X` hexadecimal numbers (`^XFF`). Not standard syntax (which has only `^D` `^O` `^B`),
   * so off by default; for projects that want an easier mode. The disassembler and the
   * listing stay octal.
   */
  hex?: boolean;
}

export interface AsmError {
  line: number;
  column: number;
  message: string;
}

export interface AsmLine {
  /** 1-based source line. */
  line: number;
  address: number;
  /** Bytes this line produced (empty for labels, symbols, comments; `.BLKW` gives zeros). */
  bytes: number[];
  /** True for instructions (the debugger can stop on them). */
  code: boolean;
}

export interface AssembleResult {
  ok: boolean;
  errors: AsmError[];
  /** Lowest address written, and the bytes from there on (gaps are zero). */
  origin: number;
  bytes: Uint8Array;
  /** `.END expr`, else the first instruction, else the origin. */
  start: number;
  /** Every symbol and label (upper case) with its value; registers are not included. */
  symbols: Map<string, number>;
  /** Names defined as labels (as opposed to `=` symbols). */
  labels: Set<string>;
  lines: AsmLine[];
  /** Instruction address → source line. */
  lineAt: Map<number, number>;
  /** Listing in the traditional style: address, words in octal, source. */
  listing: string;
  /** The listing row by row, with the source line each row belongs to. */
  listingRows: Array<{ line: number; text: string }>;
  /** Things that assemble but are probably not meant (they don't affect `ok`). */
  warnings: AsmError[];
}

const REGISTERS: Record<string, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5, R6: 6, R7: 7, SP: 6, PC: 7 };
const IGNORED = new Set(['.TITLE', '.SBTTL', '.IDENT', '.ENABL', '.DSABL', '.LIST', '.NLIST', '.PAGE']);

class AsmFail {
  constructor(readonly message: string, readonly column = 0) {}
}

interface Operand {
  mode: number;
  reg: number;
  /** An extra word: its expression, and whether it is PC-relative. */
  extra?: { expr: string; relative: boolean; column: number };
}

interface Value {
  value: number;
  /** An undefined symbol was used (allowed in pass 1). */
  undef: boolean;
}

export function assemble(source: string, opts: AssembleOptions = {}): AssembleResult {
  return new Assembler(source, opts).run();
}

class Assembler {
  private readonly src: string[];
  private readonly style: NameStyle;
  private readonly predefined = new Map<string, number>();
  private readonly symbols = new Map<string, number>();
  private readonly regSymbols = new Map<string, number>();
  private readonly labels = new Set<string>();
  /** Bytes each line produced in pass 1, so a line with an error keeps its size in pass 2. */
  private pass1Size = new Map<number, number>();
  /** Labels defined so far in this pass (duplicates). */
  private definedThisPass = new Set<string>();
  private errors: AsmError[] = [];
  private warnings: AsmError[] = [];
  private pass = 1;
  private lc = 0;
  private scope = 0;
  private lineNo = 0;
  private mem = new Map<number, number>();
  private lines: AsmLine[] = [];
  private start: number | null = null;
  private firstCode: number | null = null;

  constructor(source: string, private readonly opts: AssembleOptions) {
    this.src = source.replace(/\r\n?/g, '\n').split('\n');
    this.style = opts.names ?? 'dec';
    const syms = opts.symbols;
    if (syms) {
      const entries = syms instanceof Map ? [...syms.entries()] : Object.entries(syms);
      for (const [k, v] of entries) this.predefined.set(k.toUpperCase(), v & 0xffff);
    }
  }

  run(): AssembleResult {
    for (this.pass = 1; this.pass <= 2; this.pass++) {
      this.lc = (this.opts.origin ?? 0o1000) & 0xffff;
      this.scope = 0;
      this.definedThisPass = new Set();
      this.errors = [];
      this.warnings = [];
      this.mem.clear();
      this.lines = [];
      this.start = null;
      this.firstCode = null;
      for (let i = 0; i < this.src.length; i++) {
        this.lineNo = i + 1;
        if (!this.line(this.src[i])) break; // .END
      }
    }
    const addrs = [...this.mem.keys()];
    const lo = addrs.length ? Math.min(...addrs) : (this.opts.origin ?? 0o1000);
    const hi = addrs.length ? Math.max(...addrs) + 1 : lo;
    const bytes = new Uint8Array(hi - lo);
    for (const [a, b] of this.mem) bytes[a - lo] = b;
    const lineAt = new Map<number, number>();
    for (const l of this.lines) if (l.code) lineAt.set(l.address, l.line);
    const errors = this.errors.sort((a, b) => a.line - b.line || a.column - b.column);
    const listingRows = this.listing();
    return {
      ok: errors.length === 0,
      errors,
      origin: lo,
      bytes,
      start: this.start ?? this.firstCode ?? lo,
      symbols: new Map([...this.symbols].filter(([k]) => !k.includes(':'))),
      labels: new Set([...this.labels].filter((k) => !k.includes(':'))),
      lines: this.lines,
      lineAt,
      listing: listingRows.map((r) => r.text).join('\n'),
      listingRows,
      warnings: this.warnings.sort((a, b) => a.line - b.line || a.column - b.column),
    };
  }

  private error(message: string, column = 0): void {
    if (this.pass !== 2) return;
    if (this.errors.some((e) => e.line === this.lineNo)) return; // one per line
    this.errors.push({ line: this.lineNo, column: column + 1, message });
  }

  // ------------------------------------------------------------------ lines

  /** Returns false at `.END`. */
  private line(raw: string): boolean {
    const text = stripComment(raw);
    let pos = 0;
    const skip = (): void => { while (pos < text.length && /\s/.test(text[pos])) pos++; };
    try {
      // Labels.
      for (;;) {
        skip();
        const m = /^([A-Za-z0-9.$_]+)\s*::?(?!=)/.exec(text.slice(pos));
        if (!m) break;
        this.defineLabel(m[1], pos);
        pos += m[0].length;
      }
      skip();
      const rest = text.slice(pos);
      if (rest === '') { this.record(this.lc, [], false); return true; }

      // Assignments: NAME = expr, NAME = %n, . = expr.
      const asg = /^([A-Za-z0-9.$_]+)\s*==?\s*(.*)$/.exec(rest);
      if (asg) {
        this.assign(asg[1], asg[2], pos, pos + rest.indexOf('=') + 1);
        this.record(this.lc, [], false);
        return true;
      }

      // Combined flag operations, as the disassembler writes them: CLC!CLV, SEN!SEZ.
      const cc = /^([A-Za-z]+(?:\s*!\s*[A-Za-z]+)+)\s*(.*)$/.exec(rest);
      if (cc) {
        this.instruction(this.flagCombination(cc[1], pos), cc[2], pos + rest.length - cc[2].length);
        return true;
      }
      const om = /^([A-Za-z.][A-Za-z0-9.$_]*)\s*(.*)$/.exec(rest);
      if (om && om[1].startsWith('.') && om[1] !== '.') return this.directive(om[1].toUpperCase(), om[2], pos + rest.length - om[2].length, pos);
      const op = om ? BY_NAME.get(om[1].toUpperCase()) : undefined;
      if (op) {
        this.instruction(op, om![2], pos + rest.length - om![2].length);
      } else if (dataLine(rest, om)) {
        // As the original assembler: an expression where the instruction goes is an implicit .WORD. A name
        // alone that is still undefined in pass 2 was more likely meant as an instruction.
        if (this.pass === 2 && om && om[2] === '' && !this.defined(om[1], pos)) {
          throw new AsmFail(`unknown instruction ${om[1]} (for data, use .WORD)`, pos);
        }
        return this.directive('.WORD', rest, pos, pos);
      } else if (om) {
        throw new AsmFail(`unknown instruction ${om[1]}`, pos);
      } else {
        throw new AsmFail(`can't read "${rest}"`, pos);
      }
    } catch (e) {
      if (!(e instanceof AsmFail)) throw e;
      this.error(e.message, e.column);
      const size = this.pass === 2 ? (this.pass1Size.get(this.lineNo) ?? 0) : 0;
      const here = this.lc;
      this.lc = (this.lc + size) & 0xffff; // keep later labels where pass 1 put them
      this.lines.push({ line: this.lineNo, address: here, bytes: [], code: false });
    }
    return true;
  }

  private warn(message: string, column = 0): void {
    if (this.pass !== 2) return;
    this.warnings.push({ line: this.lineNo, column: column + 1, message });
  }

  private record(address: number, bytes: number[], code: boolean): void {
    if (this.pass === 1 && bytes.length) this.pass1Size.set(this.lineNo, (this.pass1Size.get(this.lineNo) ?? 0) + bytes.length);
    this.lines.push({ line: this.lineNo, address, bytes, code });
    for (let i = 0; i < bytes.length; i++) {
      const a = (address + i) & 0xffff;
      if (this.pass === 2 && this.mem.has(a)) this.error(`address ${octal(a)} is written twice`);
      this.mem.set(a, bytes[i] & 0xff);
    }
    if (code && this.firstCode === null) this.firstCode = address;
  }

  private checkName(name: string, column: number): string {
    const up = name.toUpperCase();
    if (/^\d/.test(up)) throw new AsmFail(`a name can't start with a digit: ${name}`, column);
    if (this.style === 'dec') {
      if (up.includes('_')) throw new AsmFail(`"_" is not allowed in names: ${name}`, column);
      if (up.length > 6) throw new AsmFail(`names are at most 6 characters: ${name}`, column);
    }
    return up;
  }

  private defineLabel(name: string, column: number): void {
    let key: string;
    if (/^\d+\$$/.test(name)) {
      key = `${this.scope}:${name}`;
    } else {
      key = this.checkName(name, column);
      if (key in REGISTERS) throw new AsmFail(`${name} is a register`, column);
      this.scope++;
      this.labels.add(key);
    }
    this.defineSymbol(key, this.lc, column, true);
    if (!/^\d/.test(key) && BY_NAME.has(key)) this.warn(`${key} is also an instruction; as a value it now means this label`, column);
  }

  private defineSymbol(key: string, value: number, column: number, label: boolean): void {
    const prev = this.symbols.get(key);
    if (label) {
      if (this.definedThisPass.has(key)) throw new AsmFail(`${key.replace(/^\d+:/, '')} is defined twice`, column);
      this.definedThisPass.add(key);
      if (this.predefined.has(key)) throw new AsmFail(`${key} is a predefined symbol`, column);
    }
    if (this.pass === 2 && label && prev !== value) {
      throw new AsmFail(`${key} moved between passes (a size depends on a later symbol)`, column);
    }
    this.symbols.set(key, value & 0xffff);
  }

  private assign(name: string, exprText: string, column: number, exprCol: number): void {
    if (name === '.') {
      const v = this.expr(exprText, exprCol);
      if (v.undef) throw new AsmFail('the location counter can only move to a known address', exprCol);
      this.lc = v.value & 0xffff;
      return;
    }
    const key = this.checkName(name, column);
    if (key in REGISTERS) throw new AsmFail(`${name} is a register`, column);
    const t = exprText.trim();
    if (t.startsWith('%')) {
      const v = this.expr(t.slice(1), exprCol + 1);
      if (v.undef || v.value > 7) throw new AsmFail('a register symbol needs %0–%7', exprCol);
      this.regSymbols.set(key, v.value);
      return;
    }
    if (this.labels.has(key)) throw new AsmFail(`${name} is a label`, column);
    const v = this.expr(exprText, exprCol);
    if (!v.undef || this.pass === 1) this.symbols.set(key, v.value & 0xffff);
    if (!v.undef && (v.value < -0x8000 || v.value > 0xffff)) this.warn(`${v.value < 0 ? "-" : ""}${Math.abs(v.value).toString(8)} doesn't fit 16 bits: ${key} = ${octal(v.value & 0xffff)}`, exprCol);
    if (BY_NAME.has(key)) this.warn(`${key} is also an instruction; as a value it now means this symbol`, column);
  }

  // ------------------------------------------------------------------ directives

  private directive(name: string, args: string, col: number, nameCol: number): boolean {
    const here = this.lc;
    switch (name) {
      case '.WORD': {
        if (here & 1) throw new AsmFail('.WORD at an odd address (add .EVEN before it)', nameCol);
        const parts = args.trim() === '' ? [{ text: '0', column: col }] : splitArgs(args, col);
        const bytes: number[] = [];
        for (const p of parts) {
          const v = this.word(p.text, p.column);
          bytes.push(v & 0xff, v >> 8);
        }
        this.emit(bytes, false);
        return true;
      }
      case '.BYTE': {
        const parts = args.trim() === '' ? [{ text: '0', column: col }] : splitArgs(args, col);
        const bytes: number[] = [];
        for (const p of parts) {
          const v = this.expr(p.text, p.column);
          if (!v.undef && (v.value < -128 || v.value > 255)) throw new AsmFail(`${v.value} doesn't fit in a byte`, p.column);
          bytes.push(v.value & 0xff);
        }
        this.emit(bytes, false);
        return true;
      }
      case '.ASCII':
      case '.ASCIZ': {
        const bytes = this.ascii(args, col);
        if (name === '.ASCIZ') bytes.push(0);
        this.emit(bytes, false);
        return true;
      }
      case '.BLKW':
      case '.BLKB': {
        const v = args.trim() === '' ? { value: 1, undef: false } : this.expr(args, col);
        if (v.undef) throw new AsmFail(`${name} needs a size known at this point`, col);
        if (v.value < 0 || v.value > 0o77777) throw new AsmFail(`bad size ${v.value}`, col);
        if (name === '.BLKW' && (here & 1)) throw new AsmFail('.BLKW at an odd address (add .EVEN before it)', nameCol);
        this.emit(new Array<number>(name === '.BLKW' ? v.value * 2 : v.value).fill(0), false);
        return true;
      }
      case '.EVEN':
        if (here & 1) this.lc = (here + 1) & 0xffff;
        this.record(here, [], false);
        return true;
      case '.ODD':
        if (!(here & 1)) this.lc = (here + 1) & 0xffff;
        this.record(here, [], false);
        return true;
      case '.END': {
        if (args.trim() !== '') {
          const v = this.expr(args, col);
          this.start = v.value & 0xffff;
        }
        this.record(here, [], false);
        return false;
      }
      default:
        if (IGNORED.has(name)) { this.record(here, [], false); return true; }
        throw new AsmFail(`unknown directive ${name}`, nameCol);
    }
  }

  private ascii(args: string, col: number): number[] {
    const out: number[] = [];
    let i = 0;
    const s = args;
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '<') {
        const end = s.indexOf('>', i);
        if (end < 0) throw new AsmFail('missing >', col + i);
        const v = this.expr(s.slice(i + 1, end), col + i + 1);
        out.push(v.value & 0xff);
        i = end + 1;
        continue;
      }
      const end = s.indexOf(ch, i + 1);
      if (end < 0) throw new AsmFail(`text needs a closing ${ch}`, col + i);
      for (let k = i + 1; k < end; k++) out.push(s.charCodeAt(k) & 0xff);
      i = end + 1;
    }
    return out;
  }

  private emit(bytes: number[], code: boolean): void {
    this.record(this.lc, bytes, code);
    this.lc = (this.lc + bytes.length) & 0xffff;
  }

  // ------------------------------------------------------------------ instructions

  /** `CLC!CLV` → 000243. Only flag operations, and clears and sets not mixed. */
  private flagCombination(text: string, col: number): OpInfo {
    let opcode = 0o000240;
    let set: boolean | null = null;
    for (const part of text.split('!').map((p) => p.trim().toUpperCase())) {
      const op = BY_NAME.get(part);
      if (!op || op.format !== 'none' || op.opcode <= 0o000240 || op.opcode >= 0o000300 || op.opcode === 0o000260) {
        throw new AsmFail(`only flag operations (CLC, SEV, …) combine with !, not ${part}`, col);
      }
      const s = (op.opcode & 0o20) !== 0;
      if (set !== null && s !== set) throw new AsmFail('clear (CLx) and set (SEx) flag operations cannot be combined', col);
      set = s;
      opcode |= op.opcode;
    }
    return { name: text.replace(/\s+/g, '').toUpperCase(), opcode, format: 'none' };
  }

  private instruction(op: OpInfo, args: string, col: number): void {
    if (this.lc & 1) throw new AsmFail('an instruction at an odd address (add .EVEN before it)', col);
    const parts = args.trim() === '' ? [] : splitArgs(args, col);
    const want = (n: number, form: string): void => {
      if (parts.length !== n) throw new AsmFail(`${op.name} takes ${form}`, col);
    };
    const words: number[] = [op.opcode];
    const extras: Array<NonNullable<Operand['extra']>> = [];
    const operand = (p: { text: string; column: number }): number => {
      const o = this.operand(p.text, p.column);
      if (o.extra) extras.push(o.extra);
      return (o.mode << 3) | o.reg;
    };
    const here = this.lc;
    switch (op.format) {
      case 'double':
        want(2, 'two operands: src, dst');
        words[0] |= (operand(parts[0]) << 6) | operand(parts[1]);
        break;
      case 'single': {
        want(1, 'one operand');
        const spec = operand(parts[0]);
        if (op.name === 'JMP' && (spec >> 3) === 0) throw new AsmFail('JMP needs an address, not a register', parts[0].column);
        words[0] |= spec;
        break;
      }
      case 'jsr': {
        want(2, 'a register and an address: JSR PC, NAME');
        const spec = operand(parts[1]);
        if ((spec >> 3) === 0) throw new AsmFail('JSR needs an address, not a register', parts[1].column);
        words[0] |= (this.register(parts[0].text, parts[0].column) << 6) | spec;
        break;
      }
      case 'rts':
        want(1, 'a register: RTS PC');
        words[0] |= this.register(parts[0].text, parts[0].column);
        break;
      case 'xor':
        want(2, 'a register and a destination: XOR R1, dst');
        words[0] |= (this.register(parts[0].text, parts[0].column) << 6) | operand(parts[1]);
        break;
      case 'regsrc':
        want(2, `a source and a register: ${op.name} src, R2`);
        words[0] |= operand(parts[0]) | (this.register(parts[1].text, parts[1].column) << 6);
        break;
      case 'branch': {
        want(1, 'a target label');
        const t = this.expr(parts[0].text, parts[0].column);
        if (!t.undef) {
          const diff = t.value - (here + 2);
          if (diff & 1) throw new AsmFail('branch target at an odd address', parts[0].column);
          const off = diff / 2;
          if (off < -128 || off > 127) throw new AsmFail(`branch target too far (${off} words; the limit is −128…127, use JMP)`, parts[0].column);
          words[0] |= off & 0o377;
        }
        break;
      }
      case 'sob': {
        want(2, 'a register and a target: SOB R3, 1$');
        const reg = this.register(parts[0].text, parts[0].column);
        const t = this.expr(parts[1].text, parts[1].column);
        let off = 0;
        if (!t.undef) {
          const diff = here + 2 - t.value;
          if (diff & 1) throw new AsmFail('SOB target at an odd address', parts[1].column);
          off = diff / 2;
          if (off < 1 || off > 63) throw new AsmFail(`SOB only jumps backwards, at most 63 words (here ${-off})`, parts[1].column);
        }
        words[0] |= (reg << 6) | off;
        break;
      }
      case 'trap': {
        if (parts.length > 1) throw new AsmFail(`${op.name} takes at most one number`, col);
        if (parts.length === 1) {
          const v = this.expr(parts[0].text, parts[0].column);
          if (!v.undef && (v.value < 0 || v.value > 0o377)) throw new AsmFail(`${op.name} numbers are 0–377`, parts[0].column);
          words[0] |= v.value & 0o377;
        }
        break;
      }
      case 'none':
        want(0, 'no operands');
        break;
    }
    // Extra words, in operand order.
    for (const x of extras) {
      const addr = (here + 2 * words.length) & 0xffff;
      const v = this.expr(x.expr, x.column);
      let value = v.value;
      if (x.relative) value = value - (addr + 2);
      if (!v.undef && !x.relative && (v.value < -0x8000 || v.value > 0xffff)) throw new AsmFail(`${v.value} doesn't fit 16 bits`, x.column);
      words.push(value & 0xffff);
    }
    const bytes: number[] = [];
    for (const w of words) bytes.push(w & 0xff, (w >> 8) & 0xff);
    this.emit(bytes, true);
  }

  private register(text: string, column: number): number {
    const r = this.tryRegister(text.trim(), column);
    if (r === null) throw new AsmFail(`expected a register, got "${text.trim()}"`, column);
    return r;
  }

  private tryRegister(t: string, column: number): number | null {
    const up = t.toUpperCase();
    if (up in REGISTERS) return REGISTERS[up];
    if (this.regSymbols.has(up)) return this.regSymbols.get(up)!;
    if (up.startsWith('%')) {
      const v = this.expr(up.slice(1), column + 1);
      if (v.value < 0 || v.value > 7) throw new AsmFail('registers are %0–%7', column);
      return v.value;
    }
    return null;
  }

  private operand(text: string, column: number): Operand {
    let s = trimArg(text);
    if (s === '') throw new AsmFail('missing operand', column);
    if (s.startsWith('#')) return { mode: 2, reg: 7, extra: { expr: s.slice(1), relative: false, column: column + 1 } };
    if (s.startsWith('@#')) return { mode: 3, reg: 7, extra: { expr: s.slice(2), relative: false, column: column + 2 } };
    let deferred = false;
    if (s.startsWith('@')) { deferred = true; s = s.slice(1).trim(); column++; }
    const d = deferred ? 1 : 0;
    let m = /^\(([^()]+)\)\s*\+$/.exec(s);
    if (m) return { mode: 2 + d, reg: this.register(m[1], column + 1) };
    m = /^-\s*\(([^()]+)\)$/.exec(s);
    if (m) return { mode: 4 + d, reg: this.register(m[1], column + 2) };
    m = /^\(([^()]+)\)$/.exec(s);
    if (m) {
      const reg = this.register(m[1], column + 1);
      return deferred ? { mode: 7, reg, extra: { expr: '0', relative: false, column } } : { mode: 1, reg };
    }
    m = /^(.+)\(([^()]+)\)$/.exec(s);
    if (m) return { mode: 6 + d, reg: this.register(m[2], column + m[1].length + 1), extra: { expr: m[1], relative: false, column } };
    const r = this.tryRegister(s, column);
    if (r !== null) return { mode: d, reg: r };
    return { mode: 6 + d, reg: 7, extra: { expr: s, relative: true, column } };
  }

  private word(text: string, column: number): number {
    const v = this.expr(text, column);
    if (!v.undef && (v.value < -0x8000 || v.value > 0xffff)) throw new AsmFail(`${v.value} doesn't fit 16 bits`, column);
    return v.value & 0xffff;
  }

  // ------------------------------------------------------------------ expressions

  private expr(text: string, column: number): Value {
    const p = new ExprParser(text, column, (name, col) => this.lookup(name, col), this.opts.hex ?? false);
    const v = p.parse();
    if (v.undef && this.pass === 2) throw new AsmFail(`undefined symbol ${p.undefName}`, p.undefCol);
    return v;
  }

  private defined(name: string, column: number): boolean {
    try { return this.lookup(name, column) !== null; } catch { return false; }
  }

  private lookup(name: string, column: number): number | null {
    if (name === '.') return this.lc;
    if (/^\d+\$$/.test(name)) {
      const v = this.symbols.get(`${this.scope}:${name}`);
      return v ?? null;
    }
    const up = this.checkName(name, column);
    if (up in REGISTERS || this.regSymbols.has(up)) throw new AsmFail(`${name} is a register; a value is needed here`, column);
    // As the original assembler: instruction names are permanent symbols with their opcode as value (MOV #NOP, X).
    return this.symbols.get(up) ?? this.predefined.get(up) ?? BY_NAME.get(up)?.opcode ?? null;
  }

  // ------------------------------------------------------------------ listing

  private listing(): Array<{ line: number; text: string }> {
    const out: Array<{ line: number; text: string }> = [];
    for (const l of this.lines) {
      const src = this.src[l.line - 1] ?? '';
      if (l.bytes.length === 0) {
        out.push({ line: l.line, text: `${' '.repeat(30)}${src}` });
        continue;
      }
      const chunks: string[] = [];
      if (l.code || (l.address % 2 === 0 && l.bytes.length % 2 === 0 && !isText(src))) {
        // Words, three per row.
        for (let i = 0; i < l.bytes.length; i += 6) {
          const ws: string[] = [];
          for (let k = i; k < Math.min(i + 6, l.bytes.length); k += 2) ws.push(octal(l.bytes[k] | (l.bytes[k + 1] << 8)));
          chunks.push(`${octal((l.address + i) & 0xffff)}  ${ws.join(' ').padEnd(22)}`);
        }
      } else {
        for (let i = 0; i < l.bytes.length; i += 6) {
          const bs = l.bytes.slice(i, i + 6).map((b) => octal(b, 3));
          chunks.push(`${octal((l.address + i) & 0xffff)}  ${bs.join(' ').padEnd(22)}`);
        }
      }
      const isBlk = /\.BLK[WB]/i.test(src);
      out.push({ line: l.line, text: chunks[0] + src });
      if (!isBlk) for (let i = 1; i < Math.min(chunks.length, 8); i++) out.push({ line: l.line, text: chunks[i].trimEnd() });
    }
    return out;
  }
}

function isText(src: string): boolean {
  return /\.(ASCII|ASCIZ|BYTE)\b/i.test(src);
}

/** Remove a `;` comment, leaving `;` inside .ASCII text and character literals alone. */
function stripComment(line: string): string {
  const m = /\.ASCI[IZ]\b/i.exec(line);
  let i = 0;
  if (m) {
    // Skip over the delimited text after .ASCII / .ASCIZ.
    i = m.index + m[0].length;
    while (i < line.length) {
      const ch = line[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === ';') break;
      const close = ch === '<' ? '>' : ch;
      const end = line.indexOf(close, i + 1);
      if (end < 0) return line.trimEnd();
      i = end + 1;
    }
  }
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") { i++; continue; }
    if (ch === '"') { i += 2; continue; }
    if (ch === ';') return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

/** Split at top-level commas (not inside `< >`, or after a quote character). */
function splitArgs(args: string, column: number): Array<{ text: string; column: number }> {
  const out: Array<{ text: string; column: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "'") { i++; continue; }
    if (ch === '"') { i += 2; continue; }
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(piece(args, start, i, column));
      start = i + 1;
    }
  }
  out.push(piece(args, start, args.length, column));
  return out;
}

function piece(s: string, a: number, b: number, column: number): { text: string; column: number } {
  const raw = s.slice(a, b);
  const lead = raw.length - raw.trimStart().length;
  return { text: trimArg(raw), column: column + a + lead };
}

/** Trim, but keep the space in a character literal: \`#' \` is the code of a space. */
function trimArg(raw: string): string {
  const t = raw.trim();
  if (t.endsWith("'") && !t.endsWith("''") && raw.trimStart().length > t.length) return t + ' ';
  return t;
}

class ExprParser {
  private i = 0;
  undef = false;
  undefName = '';
  undefCol = 0;

  constructor(
    private readonly s: string,
    private readonly col: number,
    private readonly lookup: (name: string, column: number) => number | null,
    private readonly hex: boolean,
  ) {}

  parse(): Value {
    this.ws();
    if (this.i >= this.s.length) throw new AsmFail('missing value', this.col);
    const v = this.binary();
    this.ws();
    if (this.i < this.s.length) throw new AsmFail(`unexpected "${this.s.slice(this.i)}"`, this.col + this.i);
    return { value: v, undef: this.undef };
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private binary(): number {
    let v = this.term();
    for (;;) {
      this.ws();
      const op = this.s[this.i];
      if (op === undefined || !'+-*/&!'.includes(op)) return v;
      this.i++;
      const r = this.term();
      switch (op) {
        case '+': v = v + r; break;
        case '-': v = v - r; break;
        case '*': v = v * r; break;
        case '/':
          if (r === 0) { if (!this.undef) throw new AsmFail('division by zero', this.col + this.i); v = 0; }
          else v = Math.trunc(v / r);
          break;
        case '&': v = v & r; break;
        default: v = v | r; break;
      }
    }
  }

  private term(): number {
    this.ws();
    const s = this.s;
    const c = s[this.i];
    const at = this.col + this.i;
    if (c === undefined) throw new AsmFail('missing value', at);
    if (c === '-') { this.i++; return -this.term(); }
    if (c === '+') { this.i++; return this.term(); }
    if (c === '<') {
      this.i++;
      const v = this.binary();
      this.ws();
      if (s[this.i] !== '>') throw new AsmFail('missing >', this.col + this.i);
      this.i++;
      return v;
    }
    if (c === "'") {
      if (this.i + 1 >= s.length) throw new AsmFail('missing character after \'', at);
      const v = s.charCodeAt(this.i + 1) & 0xff;
      this.i += 2;
      return v;
    }
    if (c === '"') {
      if (this.i + 2 >= s.length) throw new AsmFail('" needs two characters', at);
      const v = (s.charCodeAt(this.i + 1) & 0xff) | ((s.charCodeAt(this.i + 2) & 0xff) << 8);
      this.i += 3;
      return v;
    }
    if (c === '^') {
      const k = (s[this.i + 1] ?? '').toUpperCase();
      this.i += 2;
      if (k === 'C') return ~this.term() & 0xffff;
      if (k === 'X') {
        if (!this.hex) throw new AsmFail('^X (hexadecimal) is not standard syntax; it needs the hex option', at);
        const h = /^[0-9A-Fa-f]+/.exec(s.slice(this.i));
        if (!h) throw new AsmFail('^X needs hexadecimal digits', at);
        this.i += h[0].length;
        return parseInt(h[0], 16);
      }
      const radix = k === 'D' ? 10 : k === 'O' ? 8 : k === 'B' ? 2 : 0;
      if (!radix) throw new AsmFail(`unknown ^${k} (use ^D, ^O, ^B or ^C)`, at);
      const m = /^[0-9]+/.exec(s.slice(this.i));
      if (!m) throw new AsmFail(`^${k} needs digits`, at);
      const v = parseInt(m[0], radix);
      if (Number.isNaN(v) || [...m[0]].some((d) => +d >= radix)) throw new AsmFail(`bad digit for ^${k}: ${m[0]}`, at);
      this.i += m[0].length;
      return v;
    }
    const num = /^([0-9]+)(\.?)(?![A-Za-z0-9$_])/.exec(s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      if (num[2]) return parseInt(num[1], 10);
      if (/[89]/.test(num[1])) throw new AsmFail(`${num[1]} is not octal (write ${num[1]}. for decimal)`, at);
      return parseInt(num[1], 8);
    }
    const sym = /^([0-9]+\$|[A-Za-z.$_][A-Za-z0-9.$_]*)/.exec(s.slice(this.i));
    if (sym) {
      this.i += sym[0].length;
      const v = this.lookup(sym[1], at);
      if (v === null) {
        if (!this.undef) { this.undefName = sym[1]; this.undefCol = at; }
        this.undef = true;
        return 0;
      }
      return v;
    }
    throw new AsmFail(`can't read "${s.slice(this.i)}"`, at);
  }
}

/**
 * Is this line an implicit .WORD (as in the original assembler: an expression where the instruction goes)?
 * Yes when it starts with a number, a character, `<`, a sign, or is a name alone or
 * followed by an operator or a comma. A name followed by operands (`MOVV R0, R1`) is an
 * unknown instruction, so typos keep a clear message. Purely syntactic: both passes agree.
 */
function dataLine(rest: string, om: RegExpExecArray | null): boolean {
  if (!om) return /^[0-9'"^<+-]/.test(rest);
  return om[2] === '' || /^[-+*/&!,]/.test(om[2]);
}
