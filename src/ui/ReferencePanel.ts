import { PORTS } from '../core/ports';
import { builtinConstants, formatSig, OPCODES } from '../core/vm/Compiler';
import type { WorldRegistry } from '../core/WorldRegistry';
import { CHASSIS_MK1 } from '../core/balance';
import { TOOLS } from '../core/tools';

const NOTES: Record<string, string> = {
  MOV: 'copy value', PUSH: 'push to data stack', POP: 'pop from data stack',
  ADD: 'dst += v', SUB: 'dst -= v', MUL: 'dst *= v', DIV: 'dst /= v (truncates)', MOD: 'dst = dst mod v (never negative)',
  JMP: 'jump', JEQ: 'jump if a == b', JNE: 'jump if a != b', JLT: 'jump if a < b', JGT: 'jump if a > b', JLE: 'jump if a <= b', JGE: 'jump if a >= b',
  CALL: 'push args, call', RET: 'return',
  SLEEP: 'wait N ticks', SCAN: 'ray: dest1 = tile type, dest2 = distance', STEP: 'drive [tiles] in dir', ACT: 'fire tool in hardpoint (see Tools)', PEEK: 'dest = item ID in cargo slot', USE: 'consume cargo item (REPAIR_KIT: +30 hull)',
};

/** Generated language reference: always in sync with the compiler and port table. */
export function renderReference(el: HTMLElement, registry: WorldRegistry): void {
  const ops = OPCODES.map((op) => `<tr><td><code>${formatSig(op)}</code></td><td>${NOTES[op] ?? ''}</td></tr>`).join('');
  const ports = PORTS.map((p) => `<tr><td><code>@${p.name}</code></td><td>${p.read ? 'R' : ''}${p.write ? 'W' : ''}</td><td>${p.description}</td></tr>`).join('');
  const consts = Object.entries({ ...builtinConstants(), ...registry.constants() })
    .map(([k, v]) => `<code>${k}=${v}</code>`)
    .join(' ');
  el.innerHTML = `
    <p>One instruction per line. <code>label:</code> marks a jump target, <code>;</code> starts a comment.
    <code>ALIAS r0 name</code> and <code>CONST NAME 5</code> cost no Flash. The program loops back to the top when it runs off the end.
    Compute instructions are fast (several per tick); hardware instructions (<code>SCAN STEP SLEEP ACT USE</code>) end the tick and take time.</p>
    <h4>Instructions</h4><table>${ops}</table>
    <h4>Tools (Mk-I hardpoints)</h4><table>${CHASSIS_MK1.tools
      .map((t, i) => (t ? `<tr><td><code>ACT TOOL_${i} &lt;${TOOLS[t].arg}&gt;</code></td><td>${TOOLS[t].name}: ${TOOLS[t].description} ${TOOLS[t].ticks} ticks, ${TOOLS[t].energy / 1000}% battery.</td></tr>` : `<tr><td><code>ACT TOOL_${i}</code></td><td>empty hardpoint: ERR_NO_TOOL</td></tr>`))
      .join('')}</table>
    <h4>Ports</h4><table>${ports}</table>
    <h4>Constants</h4><p class="consts">${consts}</p>
    <h4>Keys</h4><p><code>Ctrl+Enter</code> upload · <code>Space</code> pause (outside editor) · <code>.</code> step instruction · <code>V</code> camera view · <code>F</code> follow rover</p>
  `;
}
