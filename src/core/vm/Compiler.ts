import { ENCODING, MEMORY_MAP, type ChassisDef } from '../balance';
import { MAX_LOG_TAG, SYSTEM_TAG } from '../downlink';
import { getPort } from '../ports';
import { Alert, Dir, LightColor, Preempt, ProgState, Status, SystemId } from '../types';

import { encodeInstr, immBytes, instrBytes, MAX_OPTIONAL, memBytes, OPCODES, opcodeSize, SIGNATURES, type Instr, type Op, type Operand } from './isa';

export { HARDWARE_OPS, immBytes, instrBytes, OPCODES, operandBytes, type Instr, type Op, type Operand } from './isa';

export interface Program {
  instrs: Instr[];
  /** Label name → byte address. */
  labels: Record<string, number>;
  /** Source line (1-based) → byte address of its instruction, for breakpoints/UI. */
  lineToIp: Record<number, number>;
  /** Machine code of the slot (SPEC §5.7.1), addressed from 0x000. */
  code: number[];
  /** Byte address → index into `instrs` (instruction starts only). */
  indexAt: Map<number, number>;
  /** M14: where the instructions end; `DATA` bytes follow up to `code.length` (the data section). */
  codeBytes: number;
}

export interface CompileError {
  line: number;
  message: string;
}

export interface CompileResult {
  program: Program | null;
  errors: CompileError[];
  /** Program size in bytes (machine code, docs/SPEC.md §5.7). */
  flashUsed: number;
  /** Bytes per source line (1-based) that holds an instruction; a best estimate on lines with errors. */
  lineBytes: Record<number, number>;
  /**
   * Log dictionary for the console: per LOG tag, the names it was written with
   * (CONST names) and the source lines that log it.
   */
  logTags: Record<number, { names: string[]; lines: number[] }>;
  /** `ALIAS` names per register number, as written (dump decoding in Comms; display only). */
  regNames: Record<number, string[]>;
  /** Byte address of each line that holds an instruction or `DATA` (an estimate on lines with errors). */
  lineAddr: Record<number, number>;
  /** M14: RAM this slot's `VAR`s take, and where: [low, high) (program from 0 up, firmware from the top down). */
  ramUsed: number;
  ramLow: number;
  ramHigh: number;
}

/** Code slot (M10, SPEC §3.9): the firmware runs the program inside `RUN` time slices. */
export type Slot = 'firmware' | 'program';

export interface CompileOptions {
  /** Default 'firmware'. */
  slot?: Slot;
  /** Flash bytes taken by the other slot (firmware + program share the chassis flash). */
  otherBytes?: number;
  /** M14: RAM the other slot's VARs take, [low, high), for the overlap check (shared RAM). */
  otherRam?: { low: number; high: number } | null;
  /** M14: top of RAM for the firmware's VARs (default: the chassis RAM; a saved firmware keeps its own). */
  ramTop?: number;
}

export function builtinConstants(): Record<string, number> {
  const c: Record<string, number> = {};
  for (const [k, v] of Object.entries(Dir)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(Status)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(LightColor)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(SystemId)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(Alert)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(ProgState)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(Preempt)) if (typeof v === 'number') c[k] = v;
  for (let i = 0; i < 4; i++) c[`TOOL_${i}`] = i;
  for (const [k, v] of Object.entries(MEMORY_MAP)) c[k] = v;
  return c;
}

/** Ports a program may read but only the firmware may write (SPEC §3.9). */
export const FIRMWARE_ONLY_PORTS: ReadonlySet<string> = new Set(['PROG_STATE', 'WDT', 'PREEMPT', 'BAT_ALARM']);

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER = /^-?(0x[0-9a-f]+|\d+)$/i;
const REG = /^r(\d+)$/i;

function parseNumber(tok: string): number | null {
  if (!NUMBER.test(tok)) return null;
  const neg = tok.startsWith('-');
  const body = neg ? tok.slice(1) : tok;
  const n = body.toLowerCase().startsWith('0x') ? parseInt(body.slice(2), 16) : parseInt(body, 10);
  return (neg ? -n : n) | 0;
}

interface RawLine {
  line: number;
  label?: string;
  tokens: string[];
}

function tokenize(source: string): RawLine[] {
  const out: RawLine[] = [];
  source.split(/\r?\n/).forEach((text, idx) => {
    const semi = text.indexOf(';');
    // `[IMG + r1]` is one operand: no spaces inside brackets.
    let body = (semi >= 0 ? text.slice(0, semi) : text).trim().replace(/\[[^\]]*\]/g, (m) => m.replace(/\s+/g, ''));
    let label: string | undefined;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(body);
    if (m) {
      label = m[1];
      body = body.slice(m[0].length).trim();
    }
    const tokens = body
      .split(/[\s,]+/)
      .filter((t) => t.length > 0 && t !== '->');
    if (label || tokens.length) out.push({ line: idx + 1, label, tokens });
  });
  return out;
}

/**
 * Compile Rover-ASM source to a Program.
 * @param extraConstants e.g. tile constNames from WorldRegistry.
 */
/** Does compiled code contain `op`? (null / failed compiles: no) */
export const usesOp = (r: CompileResult | null | undefined, op: Op): boolean => !!r?.program?.instrs.some((i) => i.op === op);

/**
 * M12 (SPEC §3.8.7): `code` takes photos (SNAP) but nothing ever records them: neither it nor
 * the other slot on the rover has a SEND, so every photo stays in image memory.
 */
export const snapsWithoutSend = (code: CompileResult | null | undefined, otherSlot: CompileResult | null | undefined): boolean =>
  usesOp(code, 'SNAP') && !usesOp(code, 'SEND') && !usesOp(otherSlot, 'SEND');

export function compile(source: string, chassis: ChassisDef, extraConstants: Record<string, number> = {}, opts: CompileOptions = {}): CompileResult {
  const slot = opts.slot ?? 'firmware';
  const otherBytes = opts.otherBytes ?? 0;
  const errors: CompileError[] = [];
  const err = (line: number, message: string) => errors.push({ line, message });

  const constants: Record<string, number> = { ...builtinConstants() };
  for (const [k, v] of Object.entries(extraConstants)) constants[k.toUpperCase()] = v;
  const aliases: Record<string, number> = {};
  const regNames: CompileResult['regNames'] = {};
  const labels: Record<string, number> = {};
  const lines = tokenize(source);
  const varLines: { line: number; used: number }[] = [];

  const nameTaken = (n: string) => n in constants || n in aliases || n in labels || REG.test(n) || (OPCODES as string[]).includes(n);

  // Pass 1: directives and labels. A label names the next instruction, or the next DATA
  // block (which the assembler moves to the data section after the code, M14).
  let ip = 0;
  const code: RawLine[] = [];
  const data: RawLine[] = [];
  const dataLabels: Record<string, number> = {};
  let pending: { name: string; line: number }[] = [];
  const ramBytes = chassis.ramBytes;
  const ramTop = slot === 'firmware' ? (opts.ramTop ?? ramBytes) : ramBytes;
  let ramUsed = 0;
  const ramAddr = (size: number) => (slot === 'program' ? ramUsed : ramTop - ramUsed - size);
  for (const l of lines) {
    if (l.label) {
      const name = l.label.toUpperCase();
      if (nameTaken(name) || name in dataLabels) err(l.line, `Label '${l.label}' clashes with an existing name`);
      else {
        labels[name] = ip;
        pending.push({ name, line: l.line });
      }
    }
    if (!l.tokens.length) continue;
    const op = l.tokens[0].toUpperCase();
    if (op === 'DATA') {
      for (const p of pending) {
        delete labels[p.name];
        dataLabels[p.name] = data.length;
      }
      pending = [];
      if (l.tokens.length < 2) err(l.line, 'DATA expects: DATA <byte> [byte...]');
      else data.push(l);
      continue;
    }
    if (op === 'VAR') {
      if (l.tokens.length < 2 || l.tokens.length > 3) {
        err(l.line, 'VAR expects: VAR <name> [size]');
        continue;
      }
      const name = l.tokens[1].toUpperCase();
      const size = l.tokens.length === 3 ? (parseNumber(l.tokens[2]) ?? constants[l.tokens[2].toUpperCase()]) : 1;
      if (!IDENT.test(name)) err(l.line, `VAR: invalid name '${l.tokens[1]}'`);
      else if (nameTaken(name) || name in dataLabels) err(l.line, `VAR: name '${l.tokens[1]}' is already used`);
      else if (size === undefined || size < 1) err(l.line, `VAR: size '${l.tokens[2]}' must be a number of bytes (1 or more)`);
      else {
        constants[name] = ramAddr(size);
        ramUsed += size;
        varLines.push({ line: l.line, used: ramUsed });
      }
      continue;
    }
    if (op === 'ALIAS') {
      if (l.tokens.length !== 3) {
        err(l.line, 'ALIAS expects: ALIAS <reg> <name>');
        continue;
      }
      const rm = REG.exec(l.tokens[1]);
      const name = l.tokens[2].toUpperCase();
      if (!rm) err(l.line, `ALIAS: '${l.tokens[1]}' is not a register`);
      else if (+rm[1] >= chassis.registers) err(l.line, `Register r${rm[1]} does not exist (this chassis has r0–r${chassis.registers - 1})`);
      else if (!IDENT.test(name)) err(l.line, `ALIAS: invalid name '${l.tokens[2]}'`);
      else if (nameTaken(name)) err(l.line, `ALIAS: name '${l.tokens[2]}' is already used`);
      else {
        aliases[name] = +rm[1];
        (regNames[+rm[1]] ??= []).push(l.tokens[2]);
      }
      continue;
    }
    if (op === 'CONST') {
      if (l.tokens.length !== 3) {
        err(l.line, 'CONST expects: CONST <name> <value>');
        continue;
      }
      const name = l.tokens[1].toUpperCase();
      const valTok = l.tokens[2].toUpperCase();
      const v = parseNumber(valTok) ?? constants[valTok];
      if (!IDENT.test(name)) err(l.line, `CONST: invalid name '${l.tokens[1]}'`);
      else if (nameTaken(name)) err(l.line, `CONST: name '${l.tokens[1]}' is already used`);
      else if (v === undefined) err(l.line, `CONST: '${l.tokens[2]}' is not a number or known constant`);
      else constants[name] = v;
      continue;
    }
    pending = [];
    code.push(l);
    ip++;
  }


  /** Size of an operand token without reporting errors (so lines with errors still get a size). */
  const tokenBytes = (tok: string, kind: string): number => {
    const up = tok.toUpperCase();
    if (kind === 'l') return ENCODING.label;
    if (kind === 'k') return immBytes(parseNumber(tok) ?? constants[up] ?? 0);
    if (kind === 'a') {
      const terms = tok.replace(/^\[|\]$/g, '').split(/[+-]/).filter(Boolean);
      const regs = terms.filter((t) => REG.test(t) || t.toUpperCase() in aliases).length;
      return memBytes({ base: regs ? 0 : -1, off: 0, wide: terms.length > regs });
    }
    if (up.startsWith('@')) return ENCODING.port;
    if (up in aliases || REG.test(tok)) return ENCODING.register;
    const n = parseNumber(tok) ?? constants[up];
    if (n !== undefined) return immBytes(n);
    return up in labels ? ENCODING.label : ENCODING.imm8;
  };

  const lineSize = (l: RawLine): number => {
    const op = l.tokens[0].toUpperCase() as Op;
    const sigOf = SIGNATURES[op] as string[] | undefined;
    return l.tokens.slice(1).reduce<number>((n, tok, i) => n + tokenBytes(tok, (sigOf?.[Math.min(i, sigOf.length - 1)] ?? 'v')[0]), sigOf ? opcodeSize(op) : ENCODING.opcode);
  };

  // Labels become byte addresses (SPEC §5.7.1): every slot is addressed from 0x000; the
  // data section starts where the instructions end.
  const addrOf: number[] = [];
  let addr = 0;
  for (const l of code) {
    addrOf.push(addr);
    addr += lineSize(l);
  }
  addrOf.push(addr);
  const codeBytes = addr;
  const dataAddr: number[] = [];
  for (const l of data) {
    dataAddr.push(addr);
    addr += l.tokens.length - 1;
  }
  for (const name of Object.keys(labels)) labels[name] = addrOf[labels[name]];
  for (const [name, i] of Object.entries(dataLabels)) labels[name] = dataAddr[i];

  // Pass 2: instructions.
  const instrs: Instr[] = [];
  const lineToIp: Record<number, number> = {};
  const lineBytes: Record<number, number> = {};
  const logTags: CompileResult['logTags'] = {};

  /** `[n]`, `[r]`, `[r+n]`, `[n+r]`, `[a+b-c]`: at most one register; numbers, CONSTs, VARs and labels add up. */
  const parseMem = (tok: string, line: number): Operand | null => {
    if (!/^\[.+\]$/.test(tok)) {
      err(line, `'${tok}' must be a memory address in brackets: [n], [r] or [r+n]`);
      return null;
    }
    let base = -1;
    let off = 0;
    let terms = 0;
    for (const m of tok.slice(1, -1).matchAll(/([+-]?)([^+-]+)/g)) {
      const neg = m[1] === '-';
      const t = m[2];
      const up = t.toUpperCase();
      const r = REG.exec(t) ? +REG.exec(t)![1] : aliases[up];
      if (r !== undefined) {
        if (neg || base >= 0) {
          err(line, `'${tok}': one register only, added (base + offset)`);
          return null;
        }
        if (r >= chassis.registers) {
          err(line, `Register r${r} does not exist (this chassis has r0–r${chassis.registers - 1})`);
          return null;
        }
        base = r;
        continue;
      }
      const n = parseNumber(t) ?? constants[up] ?? labels[up];
      if (n === undefined) {
        err(line, `Unknown name '${t}' in '${tok}'`);
        return null;
      }
      off += neg ? -n : n;
      terms++;
    }
    if (base < 0 && (off < 0 || off > 0xffff)) {
      err(line, `Address ${off} is outside 0–0xFFFF`);
      return null;
    }
    if (base >= 0 && (off < -32768 || off > 32767)) {
      err(line, `Offset ${off} is outside −32768..32767`);
      return null;
    }
    return base >= 0 && terms > 0 ? { k: 'mem', base, off, wide: true } : { k: 'mem', base, off };
  };

  const parseOperand = (tok: string, kind: string, line: number): Operand | null => {
    const up = tok.toUpperCase();
    if (kind === 'a') return parseMem(tok, line);
    if (tok.startsWith('[')) {
      err(line, `Memory operands ('${tok}') only work in LDB, STB and LDF: load it into a register first`);
      return null;
    }
    if (kind === 'l') {
      if (up in labels) return { k: 'label', target: labels[up], name: up };
      err(line, `Unknown label '${tok}'`);
      return null;
    }
    if (kind === 'k') {
      const n = parseNumber(tok) ?? constants[up];
      if (n === undefined) {
        err(line, `'${tok}' must be a number or CONST (compile-time constant)`);
        return null;
      }
      return { k: 'imm', v: n };
    }
    if (up.startsWith('@')) {
      const p = getPort(up);
      if (!p) {
        err(line, `Unknown port '${tok}'`);
        return null;
      }
      if ((kind === 'v' || kind === 'm') && !p.read) {
        err(line, `Port ${up} is write-only`);
        return null;
      }
      if ((kind === 'd' || kind === 'm') && !p.write) {
        err(line, `Port ${up} is read-only`);
        return null;
      }
      return { k: 'port', name: p.name };
    }
    let reg: number | undefined = aliases[up];
    const rm = REG.exec(tok);
    if (rm) reg = +rm[1];
    if (reg !== undefined) {
      if (reg >= chassis.registers) {
        err(line, `Register r${reg} does not exist (this chassis has r0–r${chassis.registers - 1})`);
        return null;
      }
      return { k: 'reg', i: reg };
    }
    if (kind === 'd' || kind === 'm') {
      err(line, `'${tok}' is not a register or writable port`);
      return null;
    }
    const n = parseNumber(tok);
    if (n !== null) return { k: 'imm', v: n };
    if (up in constants) return { k: 'imm', v: constants[up] };
    if (up in labels) err(line, `'${tok}' is a label, not a value`);
    else err(line, `Unknown name '${tok}'`);
    return null;
  };

  const lineAddr: Record<number, number> = {};
  for (const [ci, l] of code.entries()) {
    const opTok = l.tokens[0].toUpperCase();
    lineBytes[l.line] = lineSize(l);
    lineAddr[l.line] = addrOf[ci];
    if (!(opTok in SIGNATURES)) {
      err(l.line, `Unknown instruction '${l.tokens[0]}'`);
      continue;
    }
    const op = opTok as Op;
    const sig = SIGNATURES[op];
    const argToks = l.tokens.slice(1);
    const required = sig.filter((s) => !s.endsWith('?') && !s.endsWith('*')).length;
    const variadic = sig.some((s) => s.endsWith('*'));
    if (argToks.length < required || (!variadic && argToks.length > sig.length)) {
      err(l.line, `${op} expects ${formatSig(op)}`);
      continue;
    }
    const args: Operand[] = [];
    let ok = true;
    argToks.forEach((tok, i) => {
      const kind = (sig[Math.min(i, sig.length - 1)] ?? 'v').replace(/[?*]$/, '');
      const o = parseOperand(tok, kind, l.line);
      if (o) args.push(o);
      else ok = false;
    });
    if (op === 'RUN' && slot === 'program') {
      err(l.line, 'RUN is a firmware instruction: a program cannot start itself');
      ok = false;
    }
    if (op === 'END' && slot === 'firmware') {
      err(l.line, 'END is a program instruction: firmware never ends (it runs the program with RUN)');
      ok = false;
    }
    const fwPort = slot === 'program' && ok ? args.find((o, i) => o.k === 'port' && FIRMWARE_ONLY_PORTS.has(o.name) && /^[dm]/.test(sig[Math.min(i, sig.length - 1)])) : undefined;
    if (fwPort?.k === 'port') {
      err(l.line, `Only the firmware may write @${fwPort.name}`);
      ok = false;
    }
    if (op === 'CALL' && args.length - 1 > chassis.dataStack) {
      err(l.line, `CALL passes ${args.length - 1} args but the data stack holds ${chassis.dataStack}`);
      ok = false;
    } else if (op === 'CALL' && args.length - 1 > MAX_OPTIONAL) {
      err(l.line, `CALL passes at most ${MAX_OPTIONAL} args (the opcode byte counts them)`);
      ok = false;
    }
    if (op === 'LOG' && ok) {
      const tag = (args[0] as { v: number }).v;
      if (tag === SYSTEM_TAG) {
        err(l.line, `LOG tag ${SYSTEM_TAG} is reserved for system frames (boot, dumps); use 0–${MAX_LOG_TAG}`);
        ok = false;
      } else if (tag < 0 || tag > MAX_LOG_TAG) {
        err(l.line, `LOG tag must be 0–${MAX_LOG_TAG}, got ${tag}`);
        ok = false;
      } else {
        const entry = (logTags[tag] ??= { names: [], lines: [] });
        const name = argToks[0].toUpperCase();
        if (parseNumber(argToks[0]) === null && !entry.names.includes(name)) entry.names.push(name);
        entry.lines.push(l.line);
      }
    }
    if (!ok) continue;
    const at = addrOf[ci];
    lineToIp[l.line] = at;
    instrs.push({ op, args, line: l.line, addr: at, size: instrBytes({ op, args }) });
  }

  // DATA: bytes for the data section (−128..255, numbers or CONSTs).
  const dataBytes: number[] = [];
  data.forEach((l, i) => {
    lineBytes[l.line] = l.tokens.length - 1;
    lineAddr[l.line] = dataAddr[i];
    for (const t of l.tokens.slice(1)) {
      const v = parseNumber(t) ?? constants[t.toUpperCase()];
      if (v === undefined) err(l.line, `DATA: '${t}' is not a number or CONST`);
      else if (v < -128 || v > 255) err(l.line, `DATA: ${v} does not fit in a byte (−128..255)`);
      dataBytes.push((v ?? 0) & 255);
    }
  });

  let flashUsed = 0;
  let overLine = 0;
  const budget = chassis.flashBytes - otherBytes;
  for (const l of [...code, ...data]) {
    flashUsed += lineBytes[l.line];
    if (!overLine && flashUsed > budget) overLine = l.line;
  }
  if (overLine) {
    const what = slot === 'program' ? 'Program' : 'Firmware';
    const other = slot === 'program' ? 'firmware' : 'program';
    err(
      overLine,
      otherBytes > 0
        ? `${what} is ${flashUsed} bytes + ${other} ${otherBytes} bytes; ${chassis.name} has ${chassis.flashBytes} bytes of Flash`
        : `${what} is ${flashUsed} bytes; ${chassis.name} has ${chassis.flashBytes} bytes of Flash`,
    );
  }

  // Shared RAM: this slot's VARs must not overlap the other slot's (or leave the RAM).
  const ramLow = slot === 'program' ? 0 : ramTop - ramUsed;
  const ramHigh = slot === 'program' ? ramUsed : ramTop;
  const other = opts.otherRam;
  const overlaps = (lo: number, hi: number) => !!other && other.high > other.low && lo < other.high && other.low < hi;
  for (const v of varLines) {
    const lo = slot === 'program' ? 0 : ramTop - v.used;
    const hi = slot === 'program' ? v.used : ramTop;
    if (lo < 0 || hi > ramBytes || overlaps(lo, hi)) {
      const what = slot === 'program' ? 'Program' : 'Firmware';
      const otherName = slot === 'program' ? 'firmware' : 'program';
      const otherUsed = other ? other.high - other.low : 0;
      err(v.line, otherUsed > 0 ? `${what} VARs take ${v.used} B of RAM + ${otherName} ${otherUsed} B; ${chassis.name} has ${ramBytes} B of RAM` : `${what} VARs take ${v.used} B; ${chassis.name} has ${ramBytes} B of RAM`);
      break;
    }
  }

  let program: Program | null = null;
  if (!errors.length) {
    const bytes: number[] = [];
    const indexAt = new Map<number, number>();
    instrs.forEach((ins, i) => {
      if (ins.addr !== bytes.length) throw new Error(`Compiler: line ${ins.line} sized ${lineBytes[ins.line]} B but encodes differently`);
      indexAt.set(ins.addr, i);
      bytes.push(...encodeInstr(ins));
    });
    bytes.push(...dataBytes);
    program = { instrs, labels, lineToIp, code: bytes, indexAt, codeBytes };
  }

  return {
    program,
    errors,
    flashUsed,
    lineBytes,
    logTags,
    regNames,
    lineAddr,
    ramUsed,
    ramLow,
    ramHigh,
  };
}

export function formatSig(op: Op): string {
  const names: Record<string, string> = { v: 'value', d: 'dest', m: 'reg', l: 'label', k: 'tag', a: '[address]' };
  return (
    `${op} ` +
    SIGNATURES[op]
      .map((s) => {
        const base = names[s[0]];
        if (s[0] === 'a') return base;
        return s.endsWith('?') ? `[${base}]` : s.endsWith('*') ? `[${base}...]` : `<${base}>`;
      })
      .join(' ')
  ).trim();
}
