import { PORT_CODES, PORTS } from '../core/ports';
import { OPCODE_NUMBERS } from '../core/vm/isa';
import { builtinConstants, formatSig, OPCODES } from '../core/vm/Compiler';
import type { WorldRegistry } from '../core/WorldRegistry';
import { CHASSIS_MK1, ENCODING as E } from '../core/balance';
import { TOOLS } from '../core/tools';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const NOTES: Record<string, string> = {
  MOV: 'copy value', PUSH: 'push to data stack', POP: 'pop from data stack',
  ADD: 'dst += v', SUB: 'dst -= v', MUL: 'dst *= v', DIV: 'dst /= v (truncates)', MOD: 'dst = dst mod v (never negative)',
  JMP: 'jump', JEQ: 'jump if a == b', JNE: 'jump if a != b', JLT: 'jump if a < b', JGT: 'jump if a > b', JLE: 'jump if a <= b', JGE: 'jump if a >= b',
  CALL: 'push args, call', RET: 'return',
  SLEEP: 'wait N ticks', SCAN: 'ray: dest1 = tile type, dest2 = distance', STEP: 'drive [tiles] in dir', ACT: 'fire tool in hardpoint (see Tools)', PEEK: 'dest = item ID in cargo slot', USE: 'repair [system] (default SYS_HULL) by consuming the material in cargo slot (see Tools)',
  SNAP: 'photograph the subject in dir into the science recorder (see Tools). Mk-I modes 1 (grey) and 2 (dithered), 258 B each; needs daylight or the headlight aimed at dir',
  LOG: 'queue a log frame for the downlink (Console tab). tag: number or CONST 0–14 (15 = system). 1 cycle, no @STATUS; dropped if the FIFO is full (@LOG_LOST)',
  BRK: 'halt the CPU (HALTED) until the Console sends Continue or you upload; the world keeps running, no watchdog. 1 cycle. In a program: halts only the program (PROG_HALTED)',
  RUN: 'firmware only: run the program for N ticks (a STEP or SLEEP in progress finishes first), then continue here. @STATUS ERR_INVALID if @PROG_STATE is not PROG_READY',
  END: 'program only: finish with @PROG_STATE = PROG_DONE and @PROG_RESULT = value (default 0); control returns to the firmware',
};

/** Generated language reference: always in sync with the compiler and port table. */
export function renderReference(el: HTMLElement, registry: WorldRegistry): void {
  const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  const ops = OPCODES.map((op) => `<tr><td><code>${formatSig(op)}</code></td><td class="dim"><code>${h2(OPCODE_NUMBERS[op])}</code></td><td>${NOTES[op] ?? ''}</td></tr>`).join('');
  const ports = PORTS.map((p) => `<tr><td><code>@${p.name}</code></td><td class="dim"><code>${h2(0x40 | PORT_CODES.indexOf(p.name))}</code></td><td>${p.read ? 'R' : ''}${p.write ? 'W' : ''}</td><td>${p.description}</td></tr>`).join('');
  const consts = Object.entries({ ...builtinConstants(), ...registry.constants() })
    .map(([k, v]) => `<code>${k}=${v}</code>`)
    .join(' ');
  el.innerHTML = `
    <p><b>Two slots.</b> The <b>program</b> is your task (Code tab, Program): the firmware runs it in time slices with
    <code>RUN</code>; it finishes with <code>END [value]</code>. The <b>firmware</b> keeps the rover alive and decides when the
    program runs (advanced). Both share the flash; each has its own labels, <code>CONST</code>s, registers and stacks.
    The firmware reads the program's state in <code>@PROG_STATE</code> and its result in <code>@PROG_RESULT</code>.</p>
    <p>One instruction per line. <code>label:</code> marks a jump target, <code>;</code> starts a comment.
    The program loops back to the top when it runs off the end.
    Compute instructions are fast (several per tick); hardware instructions (<code>SCAN STEP SLEEP ACT USE SNAP</code>) end the tick and take time.</p>
    <p><b>Program size</b> (Flash, in bytes): opcode ${E.opcode} B; register ${E.register} B; port ${E.port} B;
    number 0–${E.shortImmMax} ${E.shortImm} B, −128…127 ${E.imm8} B, up to ±32767 ${E.imm16} B, larger ${E.imm32} B; label used as a jump/call target ${E.label} B.
    Constants cost what their value costs (<code>NORTH</code> 1 B, <code>IRON_ORE</code> 1 B).
    Labels, comments, <code>ALIAS r0 name</code> and <code>CONST NAME 5</code> themselves cost nothing.
    Example: <code>JLE @BAT 20 home</code> = ${E.opcode}+${E.port}+${E.imm8}+${E.label} = ${E.opcode + E.port + E.imm8 + E.label} B.</p>
    <p><b>Machine code</b> (<b>Compile</b> shows the listing): opcode byte = instruction number (column 2 below), plus 0x20 per
    optional operand given (<code>STEP 1 2</code> = <code>34 01 02</code>). Operand bytes: <code>00</code>–<code>0F</code> number 0–15,
    <code>10</code>–<code>17</code> register r0–r7, <code>40</code>–<code>7F</code> port (column 2 of Ports), <code>18</code> / <code>19</code> / <code>1A</code>
    followed by an 8 / 16 / 32-bit number; a label is its 2-byte address. Each slot starts at address 0x000:
    <code>JLE @BAT 20 home</code> with <code>home</code> at 0x02A = <code>0E 40 18 14 00 2A</code>.</p>
    <h4>Instructions</h4><table>${ops}</table>
    <h4>Tools (Mk-I hardpoints; TOOL_3 can be fitted with an upgrade)</h4><table>${CHASSIS_MK1.tools
      .map((t, i) => (t ? `<tr><td><code>ACT TOOL_${i} &lt;${TOOLS[t].arg}&gt;</code></td><td>${TOOLS[t].name}: ${esc(TOOLS[t].description)} ${TOOLS[t].ticks} ticks, ${TOOLS[t].energy / 1000}% battery.</td></tr>` : `<tr><td><code>ACT TOOL_${i}</code></td><td>empty hardpoint: ERR_NO_TOOL</td></tr>`))
      .join('')}<tr><td><code>ACT TOOL_3 &lt;dir&gt;</code></td><td>with the upgrade: ${TOOLS.SEISMIC.name}: ${esc(TOOLS.SEISMIC.description)}</td></tr><tr><td><code>SNAP &lt;dir&gt; [mode]</code></td><td>${TOOLS.CAMERA.name}: ${esc(TOOLS.CAMERA.description)} ${TOOLS.CAMERA.ticks} ticks, ${TOOLS.CAMERA.energy / 1000}% battery.</td></tr><tr><td><code>USE &lt;slot&gt; [system]</code></td><td>${TOOLS.USE_ITEM.name}: ${esc(TOOLS.USE_ITEM.description)} ${TOOLS.USE_ITEM.ticks} ticks, ${TOOLS.USE_ITEM.energy / 1000}% battery.</td></tr></table>
    <h4>Ports</h4><table>${ports}</table>
    <h4>Constants</h4><p class="consts">${consts}</p>
    <h4>Keys</h4><p><code>Ctrl+Enter</code> upload · <code>Space</code> pause (outside editor) · <code>.</code> step instruction · <code>V</code> camera view · <code>F</code> follow rover · <code>Q</code>/<code>E</code> rotate · <code>B</code> bloom · <code>P</code> frame-time HUD</p>
  `;
}
