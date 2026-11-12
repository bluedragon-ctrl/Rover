import { ENCODING, type ChassisDef } from '../balance';
import { getPort } from '../ports';
import { Alert, Dir, LightColor, Status, SystemId } from '../types';

export type Op =
  | 'MOV' | 'PUSH' | 'POP'
  | 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'MOD'
  | 'JMP' | 'JEQ' | 'JNE' | 'JLT' | 'JGT' | 'JLE' | 'JGE'
  | 'CALL' | 'RET'
  | 'SLEEP' | 'SCAN' | 'STEP' | 'ACT' | 'PEEK' | 'USE';

export type Operand =
  | { k: 'imm'; v: number }
  | { k: 'reg'; i: number }
  | { k: 'port'; name: string }
  | { k: 'label'; target: number; name: string };

export interface Instr {
  op: Op;
  args: Operand[];
  /** 1-based source line. */
  line: number;
}

export interface Program {
  instrs: Instr[];
  labels: Record<string, number>;
  /** Map from source line (1-based) to instruction index, for breakpoints/UI. */
  lineToIp: Record<number, number>;
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
}

/** Encoded size of an integer immediate. */
export function immBytes(v: number): number {
  if (v >= 0 && v <= ENCODING.shortImmMax) return ENCODING.shortImm;
  if (v >= -128 && v <= 127) return ENCODING.imm8;
  if (v >= -32768 && v <= 32767) return ENCODING.imm16;
  return ENCODING.imm32;
}

export function operandBytes(o: Operand): number {
  switch (o.k) {
    case 'reg':
      return ENCODING.register;
    case 'port':
      return ENCODING.port;
    case 'label':
      return ENCODING.label;
    case 'imm':
      return immBytes(o.v);
  }
}

export function instrBytes(i: Instr): number {
  return i.args.reduce<number>((n, o) => n + operandBytes(o), ENCODING.opcode);
}

/**
 * Operand kinds:
 *  v  readable value (reg, port, imm, const)
 *  d  destination (reg or writable port)
 *  m  read-modify-write destination (reg or read+write port)
 *  l  label
 *  suffix '?' optional, '*' variadic
 */
const SIGNATURES: Record<Op, string[]> = {
  MOV: ['d', 'v'],
  PUSH: ['v'],
  POP: ['d'],
  ADD: ['m', 'v'],
  SUB: ['m', 'v'],
  MUL: ['m', 'v'],
  DIV: ['m', 'v'],
  MOD: ['m', 'v'],
  JMP: ['l'],
  JEQ: ['v', 'v', 'l'],
  JNE: ['v', 'v', 'l'],
  JLT: ['v', 'v', 'l'],
  JGT: ['v', 'v', 'l'],
  JLE: ['v', 'v', 'l'],
  JGE: ['v', 'v', 'l'],
  CALL: ['l', 'v*'],
  RET: [],
  SLEEP: ['v'],
  SCAN: ['v', 'd', 'd'],
  STEP: ['v', 'v?'],
  ACT: ['v', 'v?'],
  PEEK: ['v', 'd'],
  USE: ['v', 'v?'],
};

export const OPCODES = Object.keys(SIGNATURES) as Op[];
export const HARDWARE_OPS: ReadonlySet<Op> = new Set(['SLEEP', 'SCAN', 'STEP', 'ACT', 'USE']);

export function builtinConstants(): Record<string, number> {
  const c: Record<string, number> = {};
  for (const [k, v] of Object.entries(Dir)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(Status)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(LightColor)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(SystemId)) if (typeof v === 'number') c[k] = v;
  for (const [k, v] of Object.entries(Alert)) if (typeof v === 'number') c[k] = v;
  for (let i = 0; i < 4; i++) c[`TOOL_${i}`] = i;
  return c;
}

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
    let body = (semi >= 0 ? text.slice(0, semi) : text).trim();
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
export function compile(source: string, chassis: ChassisDef, extraConstants: Record<string, number> = {}): CompileResult {
  const errors: CompileError[] = [];
  const err = (line: number, message: string) => errors.push({ line, message });

  const constants: Record<string, number> = { ...builtinConstants() };
  for (const [k, v] of Object.entries(extraConstants)) constants[k.toUpperCase()] = v;
  const aliases: Record<string, number> = {};
  const labels: Record<string, number> = {};
  const lines = tokenize(source);

  const nameTaken = (n: string) => n in constants || n in aliases || n in labels || REG.test(n) || (OPCODES as string[]).includes(n);

  // Pass 1: directives and labels.
  let ip = 0;
  const code: RawLine[] = [];
  for (const l of lines) {
    if (l.label) {
      const name = l.label.toUpperCase();
      if (nameTaken(name)) err(l.line, `Label '${l.label}' clashes with an existing name`);
      else labels[name] = ip;
    }
    if (!l.tokens.length) continue;
    const op = l.tokens[0].toUpperCase();
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
      else aliases[name] = +rm[1];
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
    code.push(l);
    ip++;
  }


  // Pass 2: instructions.
  const instrs: Instr[] = [];
  const lineToIp: Record<number, number> = {};
  const lineBytes: Record<number, number> = {};

  /** Size of an operand token without reporting errors (so lines with errors still get a size). */
  const tokenBytes = (tok: string, kind: string): number => {
    const up = tok.toUpperCase();
    if (kind === 'l') return ENCODING.label;
    if (up.startsWith('@')) return ENCODING.port;
    if (up in aliases || REG.test(tok)) return ENCODING.register;
    const n = parseNumber(tok) ?? constants[up];
    if (n !== undefined) return immBytes(n);
    return up in labels ? ENCODING.label : ENCODING.imm8;
  };

  const parseOperand = (tok: string, kind: string, line: number): Operand | null => {
    const up = tok.toUpperCase();
    if (kind === 'l') {
      if (up in labels) return { k: 'label', target: labels[up], name: up };
      err(line, `Unknown label '${tok}'`);
      return null;
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

  for (const l of code) {
    const opTok = l.tokens[0].toUpperCase();
    const sigOf = SIGNATURES[opTok as Op] as string[] | undefined;
    lineBytes[l.line] = l.tokens
      .slice(1)
      .reduce<number>((n, tok, i) => n + tokenBytes(tok, (sigOf?.[Math.min(i, sigOf.length - 1)] ?? 'v')[0]), ENCODING.opcode);
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
    if (op === 'CALL' && args.length - 1 > chassis.dataStack) {
      err(l.line, `CALL passes ${args.length - 1} args but the data stack holds ${chassis.dataStack}`);
      ok = false;
    }
    if (!ok) continue;
    lineToIp[l.line] = instrs.length;
    instrs.push({ op, args, line: l.line });
  }

  let flashUsed = 0;
  let overLine = 0;
  for (const l of code) {
    flashUsed += lineBytes[l.line];
    if (!overLine && flashUsed > chassis.flashBytes) overLine = l.line;
  }
  if (overLine) err(overLine, `Program is ${flashUsed} bytes; ${chassis.name} has ${chassis.flashBytes} bytes of Flash`);

  return {
    program: errors.length ? null : { instrs, labels, lineToIp },
    errors,
    flashUsed,
    lineBytes,
  };
}

export function formatSig(op: Op): string {
  const names: Record<string, string> = { v: 'value', d: 'dest', m: 'reg', l: 'label' };
  return (
    `${op} ` +
    SIGNATURES[op]
      .map((s) => {
        const base = names[s[0]];
        return s.endsWith('?') ? `[${base}]` : s.endsWith('*') ? `[${base}...]` : `<${base}>`;
      })
      .join(' ')
  ).trim();
}
