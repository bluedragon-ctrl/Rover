/**
 * M15 slice 5: Reference for the PDP-11 core (MACRO-11). Generated from the tables it
 * describes where they exist (instruction set, I/O page, ROM routines, predefined symbols,
 * dump and message formats), so it stays in sync; a test checks every instruction has a row.
 */
import { CHASSIS_MK1, PDP11 } from '../core/balance';
import { DumpKind, STACK11_WORDS } from '../core/downlink';
import { DEVICE_BLOCKS, IO_REGISTERS, CARGO_BASE, CLOCK_VECTOR, TX_VECTOR, type IoRegister } from '../core/machine/iopage';
import { ROM_EXPORTS, ROM_ROUTINES, ROM_SOURCE } from '../core/machine/rom';
import { systemSymbols } from '../core/machine/names';
import { MSG_TYPE_NAMES, MsgType } from '../core/messages';
import { INSTRUCTIONS } from '../pdp11';
import type { WorldRegistry } from '../core/WorldRegistry';
import { mountReference } from './ReferencePanel';
import { oct6 } from './toolchain';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const o = (v: number, w = 6) => (v & 0xffff).toString(8).padStart(w, '0');

/**
 * What each instruction does: syntax, effect, flags N Z V C in DEC's notation (`*` set by
 * the result, `0` / `1` cleared / set, `-` unchanged). Byte forms (`MOVB`…) share the row.
 */
export const INSTR_DOC: Record<string, { syntax: string; does: string; flags: string }> = {
  MOV: { syntax: 'MOV src, dst', does: 'dst ← src. MOVB to a register sign-extends', flags: '**0-' },
  CMP: { syntax: 'CMP src, dst', does: 'compare: src − dst, only the flags change', flags: '****' },
  BIT: { syntax: 'BIT src, dst', does: 'test bits: src AND dst, only the flags change', flags: '**0-' },
  BIC: { syntax: 'BIC src, dst', does: 'clear bits: dst ← dst AND NOT src', flags: '**0-' },
  BIS: { syntax: 'BIS src, dst', does: 'set bits: dst ← dst OR src', flags: '**0-' },
  ADD: { syntax: 'ADD src, dst', does: 'dst ← dst + src', flags: '****' },
  SUB: { syntax: 'SUB src, dst', does: 'dst ← dst − src', flags: '****' },
  XOR: { syntax: 'XOR R, dst', does: 'dst ← dst XOR R', flags: '**0-' },
  CLR: { syntax: 'CLR dst', does: 'dst ← 0', flags: '0100' },
  COM: { syntax: 'COM dst', does: 'dst ← NOT dst (every bit flipped)', flags: '**01' },
  INC: { syntax: 'INC dst', does: 'dst ← dst + 1', flags: '***-' },
  DEC: { syntax: 'DEC dst', does: 'dst ← dst − 1', flags: '***-' },
  NEG: { syntax: 'NEG dst', does: 'dst ← −dst', flags: '****' },
  TST: { syntax: 'TST dst', does: 'set the flags from dst (is it 0? negative?)', flags: '**00' },
  ASR: { syntax: 'ASR dst', does: 'shift right, bit 15 stays (÷ 2, signed); bit 0 into C', flags: '****' },
  ASL: { syntax: 'ASL dst', does: 'shift left (× 2); bit 15 into C', flags: '****' },
  ROR: { syntax: 'ROR dst', does: 'rotate right through C', flags: '****' },
  ROL: { syntax: 'ROL dst', does: 'rotate left through C', flags: '****' },
  ADC: { syntax: 'ADC dst', does: 'dst ← dst + C (multi-word arithmetic)', flags: '****' },
  SBC: { syntax: 'SBC dst', does: 'dst ← dst − C', flags: '****' },
  SWAB: { syntax: 'SWAB dst', does: 'swap the two bytes of a word; flags from the new low byte', flags: '**00' },
  SXT: { syntax: 'SXT dst', does: 'dst ← 0 if N is clear, 177777 (−1) if set', flags: '-*0-' },
  BR: { syntax: 'BR label', does: 'branch always (±127 words)', flags: '----' },
  BNE: { syntax: 'BNE label', does: 'branch if not equal / not zero (Z = 0)', flags: '----' },
  BEQ: { syntax: 'BEQ label', does: 'branch if equal / zero (Z = 1)', flags: '----' },
  BPL: { syntax: 'BPL label', does: 'branch if plus (N = 0)', flags: '----' },
  BMI: { syntax: 'BMI label', does: 'branch if minus (N = 1)', flags: '----' },
  BVC: { syntax: 'BVC label', does: 'branch if no overflow (V = 0)', flags: '----' },
  BVS: { syntax: 'BVS label', does: 'branch if overflow (V = 1)', flags: '----' },
  BCC: { syntax: 'BCC label', does: 'branch if carry clear (C = 0)', flags: '----' },
  BCS: { syntax: 'BCS label', does: 'branch if carry set (C = 1)', flags: '----' },
  BGE: { syntax: 'BGE label', does: 'signed ≥ (N XOR V = 0)', flags: '----' },
  BLT: { syntax: 'BLT label', does: 'signed < (N XOR V = 1)', flags: '----' },
  BGT: { syntax: 'BGT label', does: 'signed > (Z OR (N XOR V) = 0)', flags: '----' },
  BLE: { syntax: 'BLE label', does: 'signed ≤ (Z OR (N XOR V) = 1)', flags: '----' },
  BHI: { syntax: 'BHI label', does: 'unsigned > (C = 0 and Z = 0)', flags: '----' },
  BLOS: { syntax: 'BLOS label', does: 'unsigned ≤ (C = 1 or Z = 1)', flags: '----' },
  BHIS: { syntax: 'BHIS label', does: 'unsigned ≥ (same as BCC)', flags: '----' },
  BLO: { syntax: 'BLO label', does: 'unsigned < (same as BCS)', flags: '----' },
  JMP: { syntax: 'JMP dst', does: 'jump to the address of dst (any distance)', flags: '----' },
  JSR: { syntax: 'JSR R, dst', does: 'call: push R, R ← return address, jump. Usually JSR PC, NAME', flags: '----' },
  RTS: { syntax: 'RTS R', does: 'return: PC ← R, R ← pop. RTS PC after JSR PC', flags: '----' },
  SOB: { syntax: 'SOB R, label', does: 'R ← R − 1; branch back to label unless 0 (a counted loop)', flags: '----' },
  TRAP: { syntax: 'TRAP n', does: 'system call through vector 034 (the firmware serves it)', flags: '****' },
  EMT: { syntax: 'EMT n', does: 'trap through vector 030 (reserved)', flags: '****' },
  BPT: { syntax: 'BPT', does: 'breakpoint: trap 014. Halts and sends a register dump', flags: '****' },
  IOT: { syntax: 'IOT', does: 'trap 020 (reserved)', flags: '****' },
  RTI: { syntax: 'RTI', does: 'return from an interrupt or trap: pop PC, then PSW', flags: '****' },
  RTT: { syntax: 'RTT', does: 'as RTI, but a trace trap waits one instruction', flags: '****' },
  WAIT: { syntax: 'WAIT', does: 'sleep until an interrupt (the rest of the tick costs no cycles)', flags: '----' },
  HALT: { syntax: 'HALT', does: 'program: end, the result in R0. Firmware: the CPU stops', flags: '----' },
  RESET: { syntax: 'RESET', does: 'every device back to idle (CSRs: DONE, no IE)', flags: '----' },
  NOP: { syntax: 'NOP', does: 'nothing', flags: '----' },
  CLC: { syntax: 'CLC', does: 'clear C. Combine: CLC!CLV', flags: '---0' },
  CLV: { syntax: 'CLV', does: 'clear V', flags: '--0-' },
  CLZ: { syntax: 'CLZ', does: 'clear Z', flags: '-0--' },
  CLN: { syntax: 'CLN', does: 'clear N', flags: '0---' },
  CCC: { syntax: 'CCC', does: 'clear all four', flags: '0000' },
  SEC: { syntax: 'SEC', does: 'set C', flags: '---1' },
  SEV: { syntax: 'SEV', does: 'set V', flags: '--1-' },
  SEZ: { syntax: 'SEZ', does: 'set Z', flags: '-1--' },
  SEN: { syntax: 'SEN', does: 'set N', flags: '1---' },
  SCC: { syntax: 'SCC', does: 'set all four', flags: '1111' },
  MUL: { syntax: 'MUL src, R', does: 'EIS: R (and R+1) ← R × src. Not installed: use JSR PC, MUL16', flags: '**0*' },
  DIV: { syntax: 'DIV src, R', does: 'EIS: R, R+1 ÷ src. Not installed: use JSR PC, DIV16', flags: '****' },
  ASH: { syntax: 'ASH src, R', does: 'EIS: shift R by src places. Not installed', flags: '****' },
  ASHC: { syntax: 'ASHC src, R', does: 'EIS: shift R, R+1 by src places. Not installed', flags: '****' },
};

const GROUPS: [string, string[]][] = [
  ['Double operand', ['MOV', 'CMP', 'BIT', 'BIC', 'BIS', 'ADD', 'SUB', 'XOR']],
  ['Single operand', ['CLR', 'COM', 'INC', 'DEC', 'NEG', 'TST', 'ASR', 'ASL', 'ROR', 'ROL', 'ADC', 'SBC', 'SWAB', 'SXT']],
  ['Branches (to a label within 127 words)', ['BR', 'BNE', 'BEQ', 'BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BGE', 'BLT', 'BGT', 'BLE', 'BHI', 'BLOS', 'BHIS', 'BLO']],
  ['Jumps and subroutines', ['JMP', 'JSR', 'RTS', 'SOB']],
  ['Traps and control', ['TRAP', 'EMT', 'BPT', 'IOT', 'RTI', 'RTT', 'WAIT', 'HALT', 'RESET', 'NOP']],
  ['Flags', ['CLC', 'CLV', 'CLZ', 'CLN', 'CCC', 'SEC', 'SEV', 'SEZ', 'SEN', 'SCC']],
  ['EIS (an upgrade, not installed yet: these trap to 010)', ['MUL', 'DIV', 'ASH', 'ASHC']],
];

const SECTIONS = [
  ['basics', 'Basics'],
  ['instr', 'Instructions'],
  ['modes', 'Modes'],
  ['flags', 'Flags'],
  ['io', 'I/O page'],
  ['rom', 'ROM'],
  ['consts', 'Symbols'],
  ['radio', 'Radio'],
] as const;

function basicsHtml(): string {
  const rows = (r: [string, string][]) => `<table>${r.map(([a, b]) => `<tr><td><code>${a}</code></td><td class="small">${b}</td></tr>`).join('')}</table>`;
  return `
    <p class="small">The rover's computer is a <b>PDP-11</b>-style 16-bit CPU, programmed in a subset of <b>MACRO-11</b>. Words are 16
    bits, stored low byte first; addresses are byte addresses, words sit at even ones. <b>Numbers are octal</b>.</p>
    <h4>Writing code</h4>
    ${rows([
      ['LABEL:  OP  src, dst  ; note', 'a line: label, instruction, operands (source first), comment'],
      ['20 · 20. · ^B10100 · \'A', 'octal 20 (= 16), decimal 20, binary, a character code'],
      ['NAME = 5 · DIR = %1', 'a constant; a register symbol (DIR means R1)'],
      ['1$:', 'local label: valid up to the next ordinary label, so routines can each have a 1$'],
      ['.WORD 1, 2 · .BYTE 7', 'data words / bytes'],
      ['.ASCII /HI/ · .ASCIZ /HI/', 'characters (.ASCIZ adds a 0 byte)'],
      ['.BLKW 4 · .BLKB 10', 'reserve 4 words / 8 bytes (zeros)'],
      ['.EVEN · . = . + 20', 'align to a word; move the location counter'],
      ['2+3*4 · 2+&lt;3*4&gt;', 'expressions go left to right (20.); &lt; &gt; group (14.). Also & (and), ! (or)'],
      ['NAME (six characters)', 'names have at most six letters, digits, . and $ (DEC style)'],
    ])}
    <h4>Registers</h4>
    ${rows([
      ['R0 … R5', 'general registers. ROM routines take arguments in R0, R1 (R2) and return in R0 with the flags set'],
      ['SP (R6)', 'the stack pointer: the stack grows down; JSR pushes the return address'],
      ['PC (R7)', 'the program counter: the address of the next instruction'],
      ['PSW', `status word at ${oct6(0o177776)}: priority (bits 7–5), T (4), N Z V C (3–0); see Flags`],
    ])}
    <h4>Memory map</h4>
    ${rows([
      ['000000–000177', 'trap and interrupt vectors (the boot ROM fills them)'],
      [`${o(PDP11.firmwareBase)}–${o(PDP11.programBase - 1)}`, `the firmware: code, data, its stack below ${o(PDP11.programBase)} (PRGBAS)`],
      [`${o(PDP11.programBase)}–${o(PDP11.coreBytes - 1)}`, 'the program: code, data, its stack from the top of core down (Mk-I core 2 KB)'],
      [`${o(PDP11.imageBase)}–`, 'image memory (IMGBAS): the photo the camera took'],
      [`${o(PDP11.romBase)}–167777`, 'the ROM: boot, handlers, drivers, helpers (read and execute only)'],
      [`${o(PDP11.ioBase)}–177777`, 'device registers: the I/O page'],
    ])}
    <h4>Firmware, program and the gate</h4>
    <p class="small">The <b>firmware</b> keeps the rover alive and gives the <b>program</b> time slices: it writes <code>GO</code> to
    <code>PRGCS</code> (the ROM's <code>RUN</code> does it for you). The program runs in user mode with its own registers until
    <code>HALT</code> (result in <code>R0</code> → <code>PRGRES</code>), <code>RTS PC</code>, the end of its slice, a preemption or a
    fault; then the firmware continues after its gate write and reads why in <code>PRGST</code> / <code>PRGER</code>. A program can't
    write firmware-only registers or memory outside its region (that is a fault).</p>
    <h4>Time</h4>
    <p class="small">The CPU gets ${PDP11.cyclesPerRoverCycle * CHASSIS_MK1.cyclesPerTick} cycles per tick (Mk-I; the overclock upgrades give more). Every bus access costs one cycle: each
    instruction word, each extra word (<code>#n</code>, an address, an index), each operand read and write. <code>MOV R1, R2</code> = 1,
    <code>MOV #5, R0</code> = 2, <code>INC @#COUNT</code> = 4, <code>JSR PC, X</code> = 3. <code>WAIT</code> sleeps until an interrupt
    (the line clock interrupts every tick at vector ${o(CLOCK_VECTOR, 3)} when <code>LKS</code> has <code>IE</code>).</p>
    <h4>Traps</h4>
    ${rows([
      ['004', 'bus error: odd address, nothing there, protection, stack overflow → program fault; firmware: reboot'],
      ['010', 'illegal instruction (also MUL / DIV without EIS)'],
      ['014', 'BPT and the trace bit: halt and dump'],
      ['034', 'TRAP n: a system call the firmware serves'],
      [`${o(CLOCK_VECTOR, 3)} · ${DEVICE_BLOCKS.map((b) => o(b.vector, 3)).join(' ')} · ${o(TX_VECTOR, 3)}`, `interrupts: line clock (level 6); ${DEVICE_BLOCKS.map((b) => b.title.toLowerCase()).join(', ')} (level 4); TX room`],
    ])}`;
}

function instructionsHtml(): string {
  const names = new Set(INSTRUCTIONS.map((i) => i.name));
  const byteForm = (n: string) => names.has(`${n}B`);
  const fl = (f: string) => `<code class="flags4" title="N Z V C: * by the result, 0 / 1 cleared / set, - unchanged">${f}</code>`;
  return (
    `<p class="small dim">src and dst can be any addressing mode (Modes tab). <b>B</b>: a byte form exists (MOVB…). Flags N Z V C: * set from the result, 0 / 1 cleared / set, - unchanged.</p>` +
    GROUPS.map(
      ([title, ops]) =>
        `<h4>${esc(title)}</h4><table>${ops
          .map((n) => {
            const d = INSTR_DOC[n];
            const op = INSTRUCTIONS.find((i) => i.name === n);
            return `<tr><td><code>${esc(d.syntax)}</code>${byteForm(n) ? ' <small class="dim">B</small>' : ''}</td><td class="small">${esc(d.does)}</td><td class="dim">${fl(d.flags)}</td><td class="dim small">${op ? o(op.opcode) : ''}</td></tr>`;
          })
          .join('')}</table>`,
    ).join('')
  );
}

function modesHtml(): string {
  const modes: [string, string, string, string, string][] = [
    ['0', 'R', 'register', 'the register itself', 'MOV R1, R2'],
    ['1', '(R)', 'register deferred', 'the word R points at', 'CLR (R1)'],
    ['2', '(R)+', 'autoincrement', 'the word R points at, then R += 2 (1 for a byte)', 'MOV (R1)+, R0'],
    ['3', '@(R)+', 'autoincrement deferred', 'R points at an address; R += 2', 'JMP @(R1)+'],
    ['4', '-(R)', 'autodecrement', 'R −= 2 first, then the word it points at (a push)', 'MOV R0, -(SP)'],
    ['5', '@-(R)', 'autodecrement deferred', 'R −= 2, then the address it points at', 'TST @-(R2)'],
    ['6', 'X(R)', 'index', 'the word at R + X (X follows the instruction)', 'MOV 2(R1), R0'],
    ['7', '@X(R)', 'index deferred', 'the address stored at R + X', 'INC @HEALTH(R2)'],
  ];
  const pc: [string, string, string, string][] = [
    ['#n', 'immediate (mode 2 on PC)', 'the number n, stored after the instruction', 'MOV #3, R1'],
    ['@#a', 'absolute (mode 3 on PC)', 'the word at address a: device registers', 'MOV @#BAT, R0'],
    ['LABEL', 'relative (mode 6 on PC)', 'the word at LABEL, wherever the code is', 'INC COUNT'],
    ['@LABEL', 'relative deferred (mode 7 on PC)', 'the address stored at LABEL', 'JMP @VECTOR'],
  ];
  return `<p class="small">Every operand is a register and a mode (3 bits each). The operand's machine code is <code>mode reg</code>
    in octal, so <code>MOV (R1)+, R0</code> is <code>01 21 00</code> = <code>012100</code>.</p>
    <h4>The eight modes</h4><table>${modes.map(([m, s, n, d, e]) => `<tr><td><code>${s}</code> <small class="dim">${m}</small></td><td class="small"><b>${n}</b>: ${d}</td><td class="small"><code>${e}</code></td></tr>`).join('')}</table>
    <h4>On the PC</h4><table>${pc.map(([s, n, d, e]) => `<tr><td><code>${s}</code></td><td class="small"><b>${n}</b>: ${d}</td><td class="small"><code>${e}</code></td></tr>`).join('')}</table>
    <h4>Cycles per operand</h4>
    <table>
      <tr><td><code>R</code></td><td class="small">0 extra cycles</td></tr>
      <tr><td><code>(R) (R)+ -(R)</code></td><td class="small">1 (the read or write)</td></tr>
      <tr><td><code>@(R)+ @-(R) X(R) LABEL @#a</code></td><td class="small">2 (an address or index word, then the operand)</td></tr>
      <tr><td><code>@X(R) @LABEL</code></td><td class="small">3</td></tr>
      <tr><td><code>#n</code></td><td class="small">1</td></tr>
    </table>
    <p class="small dim">Plus 1 for the instruction word. A destination that is read and written (<code>INC</code>, <code>ADD</code>) costs its write too; <code>MOV</code> and <code>CLR</code> only write, <code>CMP</code>, <code>BIT</code>, <code>TST</code> only read.</p>`;
}

function flagsHtml(): string {
  return `<p class="small">Most instructions set four condition flags in the <code>PSW</code> from their result; branches test them.
    The debugger and register dumps show them as <code>NZVC</code> (capital = set).</p>
    <h4>Condition flags</h4><table>
      <tr><td><code>N</code> <small class="dim">bit 3</small></td><td class="small">negative: bit 15 (bit 7 for a byte) of the result is 1</td></tr>
      <tr><td><code>Z</code> <small class="dim">bit 2</small></td><td class="small">zero: the result is 0</td></tr>
      <tr><td><code>V</code> <small class="dim">bit 1</small></td><td class="small">overflow: a signed result did not fit (100000 + 100000)</td></tr>
      <tr><td><code>C</code> <small class="dim">bit 0</small></td><td class="small">carry: an unsigned result carried out (or a subtraction borrowed); the bit shifted out</td></tr>
    </table>
    <h4>The rest of the PSW</h4><table>
      <tr><td><code>T</code> <small class="dim">bit 4</small></td><td class="small">trace: trap to 014 after each instruction (single step)</td></tr>
      <tr><td><code>priority</code> <small class="dim">bits 7–5</small></td><td class="small">interrupts at this level or below wait (7 = none). The program runs at 0</td></tr>
      <tr><td><code>mode</code> <small class="dim">bits 15–12</small></td><td class="small">current and previous mode: 00 kernel (firmware), 11 user (program)</td></tr>
    </table>
    <h4>Which branch after CMP A, B</h4><table>
      <tr><td><code>A = B</code></td><td class="small"><code>BEQ</code> · ≠ <code>BNE</code></td></tr>
      <tr><td><code>A &gt; B</code></td><td class="small">signed <code>BGT</code> · unsigned <code>BHI</code></td></tr>
      <tr><td><code>A ≥ B</code></td><td class="small">signed <code>BGE</code> · unsigned <code>BHIS</code></td></tr>
      <tr><td><code>A &lt; B</code></td><td class="small">signed <code>BLT</code> · unsigned <code>BLO</code></td></tr>
      <tr><td><code>A ≤ B</code></td><td class="small">signed <code>BLE</code> · unsigned <code>BLOS</code></td></tr>
    </table>
    <p class="small dim">CMP computes A − B (source minus destination), the other way round from SUB. ROM routines return with the flags of R0, so <code>BNE</code> right after <code>JSR PC, STEP</code> catches every error.</p>`;
}

/** I/O page groups: address range → title. Device blocks come from DEVICE_BLOCKS. */
function ioGroups(): [string, (r: IoRegister) => boolean][] {
  const dev = DEVICE_BLOCKS.map((b): [string, (r: IoRegister) => boolean] => [`${b.title} (${o(b.base)}, interrupt ${o(b.vector, 3)})`, (r) => r.addr >= b.base && r.addr < b.base + 0o20]);
  return [
    ['Telemetry (read only, sampled each tick)', (r) => r.addr >= 0o176000 && r.addr < 0o176200],
    ['Actuators', (r) => r.addr >= 0o176200 && r.addr < 0o176400],
    ...dev,
    [`Output: TX (interrupt ${o(TX_VECTOR, 3)}) and the recorder`, (r) => r.addr >= 0o176540 && r.addr < 0o176600],
    ['Program control and system (FW = firmware only)', (r) => r.addr >= 0o177000 && r.addr < 0o177100],
    ['Clock, display, stack limit', (r) => r.addr >= 0o177100],
  ];
}

function ioHtml(): string {
  const regs = IO_REGISTERS.filter((r) => !r.alias);
  const used = new Set<IoRegister>();
  const groups = ioGroups().map(([title, f]) => {
    const rows = regs.filter((r) => f(r) && !used.has(r));
    rows.forEach((r) => used.add(r));
    return [title, rows] as const;
  });
  const rest = regs.filter((r) => !used.has(r));
  if (rest.length) groups.push(['Other', rest]);
  const csr = `<p class="small">Every device has a <b>CSR</b> (control and status register): write a function and <code>GO</code> (bit 0) to
    start it; <code>DONE</code> (bit 7) says it is idle again, <code>ERR</code> (bit 15) that it refused or failed, and then its
    <code>xxER</code> register says why (<code>E.BLK</code>, …). <code>IE</code> (bit 6) asks for an interrupt when it is done.
    The ROM drivers (ROM tab) do this for you. Names are predefined symbols: <code>MOV @#BAT, R0</code>.
    Cargo slots are bytes at <code>${o(CARGO_BASE)}</code> (CARGO).</p>`;
  return (
    csr +
    groups
      .filter(([, rows]) => rows.length)
      .map(([title, rows]) => `<h4>${esc(title)}</h4><table>${rows.map((r) => `<tr><td><code>${r.name}</code></td><td class="dim small">${o(r.addr)}</td><td class="dim small">${r.access}</td><td class="small">${esc(r.description)}</td></tr>`).join('')}</table>`)
      .join('')
  );
}

/** The comment block above each ROM routine in its source (`; STEP: drive R1 tiles…`). */
export function romDocs(): Record<string, string> {
  const lines = ROM_SOURCE.split('\n');
  const out: Record<string, string> = {};
  for (const name of ROM_ROUTINES) {
    const i = lines.findIndex((l) => l.startsWith(`; ${name}:`));
    if (i < 0) continue;
    const text = [lines[i].slice(name.length + 3).trim()];
    for (let j = i + 1; j < lines.length && lines[j].startsWith(';') && !/^; [A-Z0-9]+:/.test(lines[j]); j++) text.push(lines[j].slice(1).trim());
    out[name] = text.join(' ').trim().replace(/^the same message into/, 'like PUTMSG, but into');
  }
  return out;
}

function romHtml(): string {
  const docs = romDocs();
  const drivers = ROM_ROUTINES.filter((n) => !['MUL16', 'DIV16', 'ABS', 'DIRTO', 'PLOT'].includes(n));
  const helpers = ROM_ROUTINES.filter((n) => !drivers.includes(n));
  const table = (names: readonly string[]) =>
    `<table>${names.map((n) => `<tr><td><code>JSR PC, ${n}</code></td><td class="dim small">${o(ROM_EXPORTS[n])}</td><td class="small">${esc(docs[n] ?? '')}</td></tr>`).join('')}</table>`;
  return `<p class="small">The ROM at <code>${o(PDP11.romBase)}</code> boots the rover, serves the default trap handlers and offers routines.
    Call one with <code>JSR PC, NAME</code>: arguments in <code>R0</code>, <code>R1</code> (a third in <code>R2</code>, kept), the result in
    <code>R0</code> with its flags (<code>BNE</code> = not OK). <code>R0</code> and <code>R1</code> are scratch; every other register is kept.
    Drivers return the device's error code (<code>OK</code> = 0).</p>
    <h4>Drivers</h4>${table(drivers)}
    <h4>Helpers</h4>${table(helpers)}
    <details class="small"><summary>The whole ROM source</summary><pre class="rom-src">${esc(ROM_SOURCE)}</pre></details>`;
}

function constsHtml(registry: WorldRegistry): string {
  const sys = systemSymbols();
  const io = new Set(IO_REGISTERS.map((r) => r.name));
  const groups: [string, (k: string) => boolean][] = [
    ['Error codes (driver results, xxER)', (k) => k === 'OK' || k.startsWith('E.')],
    ['Function codes (CSR bits 3–1)', (k) => k.startsWith('F.')],
    ['CSR bits', (k) => ['GO', 'IE', 'DONE', 'READY', 'ERR'].includes(k)],
    ['Message types and framing', (k) => k.startsWith('T.') || k === 'SOH' || k === 'ETX'],
    ['Program states (PRGST)', (k) => k.startsWith('P.')],
    ['Why the program returned (PRGCS bits 3–1)', (k) => k.startsWith('W.')],
    ['Program faults (PRGER)', (k) => k.startsWith('PF.')],
    ['Preemption (PREMPT bits)', (k) => k.startsWith('PR.')],
    ['Alerts (ALERT)', (k) => k.startsWith('A.')],
    ['Directions', (k) => ['NORTH', 'EAST', 'SOUTH', 'WEST'].includes(k)],
    ['Light colours (IND1–3)', (k) => ['OFF', 'RED', 'GREEN', 'BLUE', 'AMBER'].includes(k)],
    ['Addresses', (k) => ['PSW', 'PRGBAS', 'IMGBAS', 'CARGO', 'SAFE'].includes(k)],
  ];
  const used = new Set<string>();
  const parts = groups.map(([title, f]) => {
    const entries = Object.entries(sys).filter(([k]) => !io.has(k) && f(k) && !used.has(k));
    entries.forEach(([k]) => used.add(k));
    return `<h4>${esc(title)}</h4><p class="consts">${entries.map(([k, v]) => `<code>${k}=${o(v, 1)}</code>`).join(' ')}</p>`;
  });
  const rest = Object.entries(sys).filter(([k]) => !io.has(k) && !used.has(k));
  if (rest.length) parts.push(`<h4>Other</h4><p class="consts">${rest.map(([k, v]) => `<code>${k}=${o(v, 1)}</code>`).join(' ')}</p>`);
  const tiles = Object.entries(registry.shortConstants());
  parts.push(`<h4>Tiles (radar, ground, cargo)</h4><p class="consts">${tiles.map(([k, v]) => `<code>${k}=${o(v, 1)}</code>`).join(' ')}</p>`);
  return `<p class="small dim">Predefined symbols, in octal. Device register names are in the I/O page tab, ROM routines in the ROM tab.</p>${parts.join('')}`;
}

function radioHtml(): string {
  const types = Object.entries(MSG_TYPE_NAMES)
    .map(([v, n]) => `<tr><td><code>T.${Object.entries(MsgType).find(([, x]) => x === Number(v))?.[0] ?? v}</code></td><td class="dim small">${o(Number(v), 3)}</td><td class="small">${n}</td></tr>`)
    .join('');
  return `<p class="small">Your code talks to mission control in <b>messages</b>, byte by byte into <code>TXBUF</code> (real time, a
    ${PDP11.txFifoBytes} B FIFO, lossy) or <code>RECBUF</code> (the recorder: store and forward). The ROM's <code>LOG</code>, <code>PUTMSG</code>,
    <code>SEND</code> and <code>SNDIMG</code> write them for you. The rover sends dumps first, then TX, then the recorder.</p>
    <h4>Message format</h4><table>
      <tr><td><code>SOH</code></td><td class="small">001: a message starts</td></tr>
      <tr><td><code>type</code></td><td class="small">1 byte: what it is (below; 100–377 are yours)</td></tr>
      <tr><td><code>length</code></td><td class="small">1 byte: body bytes (0–255)</td></tr>
      <tr><td><code>body</code></td><td class="small">the bytes</td></tr>
      <tr><td><code>ETX</code></td><td class="small">003: the end. If the length or the ETX does not match, Comms shows the message <i>broken</i> (bytes lost when the FIFO was full) or <i>incomplete</i> (cut off by a reboot)</td></tr>
    </table>
    <h4>Types</h4><table>${types}</table>
    <table>
      <tr><td><code>T.LOG</code> body</td><td class="small">tag (1 byte) and a value (one word, low byte first). Comms names the tag from your <code>L.</code> symbols: <code>L.BAT = 1</code></td></tr>
      <tr><td><code>T.TEXT</code> body</td><td class="small">characters; Comms prints them</td></tr>
      <tr><td><code>T.ERR</code> body</td><td class="small">an error code and the address where it happened (a word)</td></tr>
      <tr><td><code>T.IMG</code> body</td><td class="small">photo type, chunk number, chunks, then up to 128 pixel bytes (SNDIMG)</td></tr>
    </table>
    <h4>Register dump (Dump registers, BPT)</h4><table>
      <tr><td><code>F8 kind length</code></td><td class="small">system frame; kind ${DumpKind.CPU11} firmware, ${DumpKind.PROG_CPU11} program; length 19</td></tr>
      <tr><td><code>state</code></td><td class="small">1 byte: CPU state (firmware) or PRGST (program)</td></tr>
      <tr><td><code>PSW</code></td><td class="small">a word, low byte first</td></tr>
      <tr><td><code>R0 … R5, SP, PC</code></td><td class="small">eight words, low byte first</td></tr>
    </table>
    <h4>Stack dump (Dump stack)</h4><table>
      <tr><td><code>F8 kind length</code></td><td class="small">kind ${DumpKind.STACK11} firmware, ${DumpKind.PROG_STACK11} program</td></tr>
      <tr><td><code>SP</code></td><td class="small">a word</td></tr>
      <tr><td><code>count</code></td><td class="small">1 byte: words that follow (at most ${STACK11_WORDS})</td></tr>
      <tr><td><code>words</code></td><td class="small">from SP up: the top of the stack first</td></tr>
    </table>`;
}

/** Reference tab for a world with the PDP-11 core. */
export function renderReference11(el: HTMLElement, registry: WorldRegistry): void {
  el.classList.add('ref11');
  mountReference(el, SECTIONS, {
    basics: basicsHtml(),
    instr: instructionsHtml(),
    modes: modesHtml(),
    flags: flagsHtml(),
    io: ioHtml(),
    rom: romHtml(),
    consts: constsHtml(registry),
    radio: radioHtml(),
  });
}
