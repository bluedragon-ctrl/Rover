/**
 * Instruction table (the original /40 model's set with its EIS option, minus memory
 * management). Shared by the assembler and the disassembler; the CPU decodes by the same
 * opcode values.
 *
 * Formats (octal):
 *   double   oSSDD     src, dst          MOV CMP BIT BIC BIS ADD SUB (+B)
 *   single   ooooDD    dst               CLR COM INC ... SWAB SXT JMP (+B)
 *   branch   bbbxxx    label             8-bit signed word offset
 *   jsr      004RDD    reg, dst
 *   rts      00020R    reg
 *   sob      077RNN    reg, label        6-bit backward word offset
 *   regsrc   07xRSS    src, reg          MUL DIV ASH ASHC (EIS)
 *   xor      074RDD    reg, dst
 *   trap     104xxx    [n]               EMT 0–377, TRAP 0–377
 *   none     000000    –                 HALT WAIT RTI BPT IOT RESET RTT NOP, flag ops
 */

export type Format = 'double' | 'single' | 'branch' | 'jsr' | 'rts' | 'sob' | 'regsrc' | 'xor' | 'trap' | 'none';

export interface OpInfo {
  name: string;
  opcode: number;
  format: Format;
  /** Byte instruction (MOVB, CLRB, …). */
  byte?: boolean;
  /** Part of the EIS option (MUL, DIV, ASH, ASHC). */
  eis?: boolean;
}

const t: OpInfo[] = [];
const add = (name: string, opcode: number, format: Format, extra: Partial<OpInfo> = {}): void => {
  t.push({ name, opcode, format, ...extra });
};

// Double operand.
for (const [name, op] of [['MOV', 0o010000], ['CMP', 0o020000], ['BIT', 0o030000], ['BIC', 0o040000], ['BIS', 0o050000]] as const) {
  add(name, op, 'double');
  add(name + 'B', op | 0o100000, 'double', { byte: true });
}
add('ADD', 0o060000, 'double');
add('SUB', 0o160000, 'double');

// Single operand (word and byte).
const singles: Array<[string, number, boolean]> = [
  ['CLR', 0o005000, true], ['COM', 0o005100, true], ['INC', 0o005200, true], ['DEC', 0o005300, true],
  ['NEG', 0o005400, true], ['ADC', 0o005500, true], ['SBC', 0o005600, true], ['TST', 0o005700, true],
  ['ROR', 0o006000, true], ['ROL', 0o006100, true], ['ASR', 0o006200, true], ['ASL', 0o006300, true],
];
for (const [name, op, hasByte] of singles) {
  add(name, op, 'single');
  if (hasByte) add(name + 'B', op | 0o100000, 'single', { byte: true });
}
add('SXT', 0o006700, 'single');
add('SWAB', 0o000300, 'single');
add('JMP', 0o000100, 'single');

// Branches.
const branches: Array<[string, number]> = [
  ['BR', 0o000400], ['BNE', 0o001000], ['BEQ', 0o001400], ['BGE', 0o002000], ['BLT', 0o002400],
  ['BGT', 0o003000], ['BLE', 0o003400], ['BPL', 0o100000], ['BMI', 0o100400], ['BHI', 0o101000],
  ['BLOS', 0o101400], ['BVC', 0o102000], ['BVS', 0o102400], ['BCC', 0o103000], ['BCS', 0o103400],
];
for (const [name, op] of branches) add(name, op, 'branch');
// Aliases come after the primary names so the disassembler prints BCC / BCS.
add('BHIS', 0o103000, 'branch');
add('BLO', 0o103400, 'branch');

add('JSR', 0o004000, 'jsr');
add('RTS', 0o000200, 'rts');
add('SOB', 0o077000, 'sob');
add('XOR', 0o074000, 'xor');
add('MUL', 0o070000, 'regsrc', { eis: true });
add('DIV', 0o071000, 'regsrc', { eis: true });
add('ASH', 0o072000, 'regsrc', { eis: true });
add('ASHC', 0o073000, 'regsrc', { eis: true });
add('EMT', 0o104000, 'trap');
add('TRAP', 0o104400, 'trap');

// No operands.
const none: Array<[string, number]> = [
  ['HALT', 0], ['WAIT', 1], ['RTI', 2], ['BPT', 3], ['IOT', 4], ['RESET', 5], ['RTT', 6],
  ['NOP', 0o000240], ['CLC', 0o000241], ['CLV', 0o000242], ['CLZ', 0o000244], ['CLN', 0o000250], ['CCC', 0o000257],
  ['SEC', 0o000261], ['SEV', 0o000262], ['SEZ', 0o000264], ['SEN', 0o000270], ['SCC', 0o000277],
];
for (const [name, op] of none) add(name, op, 'none');

/** Every instruction, in table order (primary names before aliases). */
export const INSTRUCTIONS: readonly OpInfo[] = t;

/** Mnemonic → instruction (upper case). */
export const BY_NAME: ReadonlyMap<string, OpInfo> = new Map(t.map((o) => [o.name, o]));

/** Bits of the opcode that are operands, per format. */
export const OPERAND_MASK: Record<Format, number> = {
  double: 0o007777, single: 0o000077, branch: 0o000377, jsr: 0o000777, rts: 0o000007,
  sob: 0o000777, regsrc: 0o000777, xor: 0o000777, trap: 0o000377, none: 0,
};

/** Decode a word to its instruction, or null for a reserved / left-out opcode. */
export function decodeOp(word: number): OpInfo | null {
  for (const o of t) {
    if ((word & ~OPERAND_MASK[o.format] & 0xffff) === o.opcode) return o;
  }
  return null;
}

/** Six octal digits, the traditional way of writing a word. */
export function octal(n: number, digits = 6): string {
  return (n >>> 0).toString(8).padStart(digits, '0');
}
