/**
 * Rover-ASM instruction set and machine code (docs/SPEC.md §5.7, §5.7.1).
 *
 * The compiler emits real bytes; the VM executes the decoded instructions. Opcode and
 * port numbers are fixed forever: new instructions and ports get new numbers, old ones
 * never change (saved programs, listings and dumps stay valid).
 */
import { ENCODING } from '../balance';
import { PORT_CODES } from '../ports';

export type Op =
  | 'MOV' | 'PUSH' | 'POP'
  | 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'MOD'
  | 'AND' | 'OR' | 'SHL' | 'SHR'
  | 'JMP' | 'JEQ' | 'JNE' | 'JLT' | 'JGT' | 'JLE' | 'JGE'
  | 'CALL' | 'RET'
  | 'SLEEP' | 'SCAN' | 'STEP' | 'ACT' | 'PEEK' | 'USE' | 'SNAP'
  | 'LOG' | 'BRK'
  | 'RUN' | 'END'
  | 'LDB' | 'STB' | 'SEND' | 'ERASE'
  | 'LDF';

export type Operand =
  | { k: 'imm'; v: number }
  | { k: 'reg'; i: number }
  | { k: 'port'; name: string }
  | { k: 'label'; target: number; name: string }
  /**
   * M14 memory operand `[n]`, `[r]`, `[r+n]` (only LDB / STB / LDF): the address is
   * `off` plus register `base` (-1 = none). `wide`: written with an offset term (`[r+n]`),
   * so it is encoded with a 16-bit offset even when that offset is 0 (sizes follow the syntax).
   */
  | { k: 'mem'; base: number; off: number; wide?: boolean };

export interface Instr {
  op: Op;
  args: Operand[];
  /** 1-based source line. */
  line: number;
  /** Byte address of the opcode in its slot (each slot starts at 0x000). */
  addr: number;
  /** Encoded size in bytes (= instrBytes). */
  size: number;
}

/**
 * Operand kinds:
 *  v  readable value (reg, port, imm, const)
 *  d  destination (reg or writable port)
 *  m  read-modify-write destination (reg or read+write port)
 *  l  label
 *  k  compile-time constant (number or CONST), no register/port
 *  a  memory address in brackets: [n], [r], [r+n] (M14; load / store instructions only)
 *  suffix '?' optional, '*' variadic
 */
export const SIGNATURES: Record<Op, string[]> = {
  MOV: ['d', 'v'],
  PUSH: ['v'],
  POP: ['d'],
  ADD: ['m', 'v'],
  SUB: ['m', 'v'],
  MUL: ['m', 'v'],
  DIV: ['m', 'v'],
  MOD: ['m', 'v'],
  AND: ['m', 'v'],
  OR: ['m', 'v'],
  SHL: ['m', 'v'],
  SHR: ['m', 'v'],
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
  SNAP: ['v', 'v?'],
  LOG: ['k', 'v?'],
  BRK: [],
  RUN: ['v'],
  END: ['v?'],
  LDB: ['d', 'a'],
  STB: ['a', 'v'],
  SEND: ['v?'],
  ERASE: [],
  LDF: ['d', 'a'],
};

export const OPCODES = Object.keys(SIGNATURES) as Op[];
export const HARDWARE_OPS: ReadonlySet<Op> = new Set(['SLEEP', 'SCAN', 'STEP', 'ACT', 'USE', 'SNAP', 'RUN', 'SEND', 'ERASE']);

/**
 * Fixed opcode numbers (SPEC §5.7.1), in §5.4 order. Append only: never renumber.
 * The low 5 bits of the opcode byte hold this number (1–30): the image-memory `LDB` / `STB`
 * (SPEC §3.8.7) took the last two, 1D and 1E; 1F is the extension prefix.
 */
export const OPCODE_NUMBERS: Readonly<Partial<Record<Op, number>>> = {
  MOV: 0x01, PUSH: 0x02, POP: 0x03,
  ADD: 0x04, SUB: 0x05, MUL: 0x06, DIV: 0x07, MOD: 0x08,
  JMP: 0x09, JEQ: 0x0a, JNE: 0x0b, JLT: 0x0c, JGT: 0x0d, JLE: 0x0e, JGE: 0x0f,
  CALL: 0x10, RET: 0x11,
  SLEEP: 0x12, SCAN: 0x13, STEP: 0x14, ACT: 0x15, PEEK: 0x16, USE: 0x17, SNAP: 0x18,
  LOG: 0x19, BRK: 0x1a,
  RUN: 0x1b, END: 0x1c,
  LDB: 0x1d, STB: 0x1e,
  // M14 slice 2: LDF reads Flash. It takes a two-byte number until the hardware
  // instructions retire (slice 3) and free one-byte numbers (owner: reuse them once).
};

/**
 * Extended instructions (SPEC §5.7.1): the opcode byte holds `EXT_PREFIX` (with the optional
 * operand count in its top 3 bits as usual) and the next byte holds this number. Like the
 * prefix bytes of real CPUs (Z80 `CB` / `ED`, x86 `0F`): one byte longer, same speed.
 * Append only: never renumber.
 */
export const EXT_PREFIX = 0x1f;
export const EXT_OPCODE_NUMBERS: Readonly<Partial<Record<Op, number>>> = {
  AND: 0x01, OR: 0x02, SHL: 0x03, SHR: 0x04,
  SEND: 0x05, ERASE: 0x06,
  LDF: 0x07,
};
const OP_BY_NUMBER = new Map(Object.entries(OPCODE_NUMBERS).map(([op, n]) => [n, op as Op]));
const OP_BY_EXT_NUMBER = new Map(Object.entries(EXT_OPCODE_NUMBERS).map(([op, n]) => [n, op as Op]));

/** The opcode bytes of `op` without the optional-operand count: `[0x04]` (ADD), `[0x1F, 0x01]` (AND). */
export function opcodeBytes(op: Op): number[] {
  const ext = EXT_OPCODE_NUMBERS[op];
  if (ext !== undefined) return [EXT_PREFIX, ext];
  const n = OPCODE_NUMBERS[op];
  if (n === undefined) throw new Error(`${op} has no opcode number`);
  return [n];
}

/** Opcode as the Reference tab shows it: `04`, `1F 01`. */
export const opcodeHex = (op: Op): string => opcodeBytes(op).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** Size of the opcode in bytes: 1, or 2 for an extended instruction (bit instructions, SEND, ERASE). */
export const opcodeSize = (op: Op): number => (EXT_OPCODE_NUMBERS[op] !== undefined ? ENCODING.extOpcode : ENCODING.opcode);

/**
 * The top 3 bits of the opcode byte count the optional operands present (`STEP d [n]`,
 * `END [v]`, the arguments of `CALL`): a short immediate (0x00–0x0F) or register byte
 * (0x10–0x17) looks like an opcode, so the decoder could not tell otherwise.
 */
export const OPT_SHIFT = 5;
export const OP_MASK = 0x1f;
/** Most optional operands one instruction can carry (CALL arguments). */
export const MAX_OPTIONAL = 7;

/** Operand byte modes (SPEC §5.7.1). */
export const OPERAND = {
  /** 0000vvvv: short immediate 0–15. */
  shortImm: 0x00,
  /** 00010rrr: register r0–r7. */
  reg: 0x10,
  /** 00011000 / 01 / 10: 8 / 16 / 32-bit big-endian immediate follows. */
  imm8: 0x18,
  imm16: 0x19,
  imm32: 0x1a,
  /** 01pppppp: port 0–63. */
  port: 0x40,
  /** M14 memory operands: 00011100 + 16-bit address `[n]`; 00100rrr `[r]`; 00101rrr + 16-bit signed offset `[r+n]`. */
  memAbs: 0x1c,
  memReg: 0x20,
  memIndexed: 0x28,
} as const;

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
    case 'mem':
      return memBytes(o);
  }
}

/** Encoded size of a memory operand: `[r]` 1 B, `[n]` and `[r+n]` 3 B. */
export function memBytes(o: { base: number; off: number; wide?: boolean }): number {
  return o.base >= 0 && o.off === 0 && !o.wide ? ENCODING.memReg : ENCODING.memAddr;
}

export function instrBytes(i: Pick<Instr, 'op' | 'args'>): number {
  return i.args.reduce<number>((n, o) => n + operandBytes(o), opcodeSize(i.op));
}

/** Number of operands a signature always has (before the optional / variadic ones). */
export function requiredOperands(op: Op): number {
  return SIGNATURES[op].filter((s) => !s.endsWith('?') && !s.endsWith('*')).length;
}

const be = (v: number, n: number): number[] => {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push((v >>> (8 * i)) & 255);
  return out;
};

const portNumber = new Map(PORT_CODES.map((name, i) => [name, i]));

/** Machine code of one instruction. */
export function encodeInstr(ins: Pick<Instr, 'op' | 'args'>): number[] {
  const optional = ins.args.length - requiredOperands(ins.op);
  if (optional < 0 || optional > MAX_OPTIONAL) throw new Error(`${ins.op}: ${ins.args.length} operands cannot be encoded`);
  const [first, ...rest] = opcodeBytes(ins.op);
  const out = [first | (optional << OPT_SHIFT), ...rest];
  for (const o of ins.args) {
    switch (o.k) {
      case 'reg':
        out.push(OPERAND.reg | o.i);
        break;
      case 'port': {
        const n = portNumber.get(o.name);
        if (n === undefined) throw new Error(`Port @${o.name} has no machine-code number`);
        out.push(OPERAND.port | n);
        break;
      }
      case 'label':
        out.push(...be(o.target, 2));
        break;
      case 'imm': {
        const n = immBytes(o.v);
        if (n === ENCODING.shortImm) out.push(OPERAND.shortImm | o.v);
        else if (n === ENCODING.imm8) out.push(OPERAND.imm8, ...be(o.v, 1));
        else if (n === ENCODING.imm16) out.push(OPERAND.imm16, ...be(o.v, 2));
        else out.push(OPERAND.imm32, ...be(o.v, 4));
        break;
      }
      case 'mem':
        if (o.base < 0) out.push(OPERAND.memAbs, ...be(o.off, 2));
        else if (o.off === 0 && !o.wide) out.push(OPERAND.memReg | o.base);
        else out.push(OPERAND.memIndexed | o.base, ...be(o.off, 2));
        break;
    }
  }
  return out;
}

/** A decoded instruction: no source line, labels carry only their address. */
export interface DecodedInstr {
  op: Op;
  args: Operand[];
  addr: number;
  size: number;
}

export class DecodeError extends Error {}

/**
 * Disassemble a slot's machine code (the inverse of encodeInstr over a whole program). `end`:
 * where the instructions stop (M14: the data section after them is not code).
 */
export function decodeProgram(code: ArrayLike<number>, end = code.length): DecodedInstr[] {
  const out: DecodedInstr[] = [];
  let at = 0;
  const byte = (): number => {
    if (at >= end) throw new DecodeError(`Truncated instruction at 0x${at.toString(16)}`);
    return code[at++];
  };
  const signed = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + byte();
    return n === 4 ? v | 0 : v >= 2 ** (8 * n - 1) ? v - 2 ** (8 * n) : v;
  };
  while (at < end) {
    const addr = at;
    const ob = byte();
    const ext = (ob & OP_MASK) === EXT_PREFIX ? byte() : null;
    const op = ext === null ? OP_BY_NUMBER.get(ob & OP_MASK) : OP_BY_EXT_NUMBER.get(ext);
    if (!op) throw new DecodeError(`Unknown opcode 0x${ob.toString(16)}${ext === null ? '' : ` ${ext.toString(16)}`} at 0x${addr.toString(16)}`);
    const sig = SIGNATURES[op];
    const count = requiredOperands(op) + (ob >> OPT_SHIFT);
    if (!sig.some((s) => s.endsWith('*')) && count > sig.length) throw new DecodeError(`${op} at 0x${addr.toString(16)} cannot have ${count} operands`);
    const args: Operand[] = [];
    for (let i = 0; i < count; i++) {
      if (sig[Math.min(i, sig.length - 1)][0] === 'l') {
        const hi = byte();
        const target = hi * 256 + byte();
        args.push({ k: 'label', target, name: '' });
        continue;
      }
      const b = byte();
      if (b <= 0x0f) args.push({ k: 'imm', v: b });
      else if ((b & 0xf8) === OPERAND.reg) args.push({ k: 'reg', i: b & 7 });
      else if (b === OPERAND.imm8) args.push({ k: 'imm', v: signed(1) });
      else if (b === OPERAND.imm16) args.push({ k: 'imm', v: signed(2) });
      else if (b === OPERAND.imm32) args.push({ k: 'imm', v: signed(4) });
      else if (b === OPERAND.memAbs) args.push({ k: 'mem', base: -1, off: (byte() << 8) | byte() });
      else if ((b & 0xf8) === OPERAND.memReg) args.push({ k: 'mem', base: b & 7, off: 0 });
      else if ((b & 0xf8) === OPERAND.memIndexed) args.push({ k: 'mem', base: b & 7, off: signed(2), wide: true });
      else if ((b & 0xc0) === OPERAND.port && PORT_CODES[b & 0x3f]) args.push({ k: 'port', name: PORT_CODES[b & 0x3f] });
      else throw new DecodeError(`Invalid operand byte 0x${b.toString(16)} at 0x${(at - 1).toString(16)}`);
    }
    out.push({ op, args, addr, size: at - addr });
  }
  return out;
}

/** Address as the listing and the Comms tab show it: `fw:0x02A` / `prog:0x010`. */
export function formatAddr(addr: number, slot?: 'firmware' | 'program'): string {
  const a = `0x${addr.toString(16).toUpperCase().padStart(3, '0')}`;
  return slot ? `${slot === 'firmware' ? 'fw' : 'prog'}:${a}` : a;
}
