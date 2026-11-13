import { PORT_CODES, PORTS } from '../core/ports';
import { HARDWARE_OPS, OPCODE_NUMBERS, type Op } from '../core/vm/isa';
import { formatSig, OPCODES } from '../core/vm/Compiler';
import type { TileDef, WorldRegistry } from '../core/WorldRegistry';
import { CHASSIS_MK1, ENCODING as E } from '../core/balance';
import { TOOLS } from '../core/tools';
import { Alert, Dir, Layer, LightColor, ProgState, Status, SystemId } from '../core/types';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

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

/** Instruction sections. An opcode not listed here lands in "Other", so new ones still show up. */
const OP_GROUPS: [string, Op[]][] = [
  ['Data', ['MOV', 'PUSH', 'POP']],
  ['Arithmetic', ['ADD', 'SUB', 'MUL', 'DIV', 'MOD']],
  ['Flow control', ['JMP', 'JEQ', 'JNE', 'JLT', 'JGT', 'JLE', 'JGE', 'CALL', 'RET']],
  ['Hardware (end the tick, write @STATUS)', ['SLEEP', 'SCAN', 'STEP', 'ACT', 'PEEK', 'USE', 'SNAP']],
  ['Program, log and debug', ['RUN', 'END', 'LOG', 'BRK']],
];

/** Port sections. A port not listed here lands in "Other", so new ones still show up. */
const PORT_GROUPS: [string, string[]][] = [
  ['Health and power', ['BAT', 'HULL', 'SOLAR_HEALTH', 'ANTENNA_HEALTH']],
  ['Position and motion', ['X', 'Y', 'HEADING', 'TICK', 'STATUS']],
  ['Sensors and ground', ['GROUND', 'GROUND_HAZARD', 'SENSOR_RANGE', 'SEISMIC_TYPE', 'SEISMIC_DIST']],
  ['Cargo, science and supplies', ['CARGO_FREE', 'SCIENCE_READY', 'REC_FREE', 'DROPS', 'DROP_X', 'DROP_Y']],
  ['Sun and solar array', ['SUN_AZIMUTH', 'SUN_ELEV', 'SUN_LIGHT', 'SOLAR_OPEN', 'SOLAR_ANGLE']],
  ['Comms and log', ['ORBIT_AZIMUTH', 'ANTENNA_ANGLE', 'SIGNAL_STR', 'TX_DATA', 'LOG_FREE', 'LOG_LOST']],
  ['World events', ['ALERT', 'ALERT_ETA']],
  ['Lights and displays', ['HEADLIGHT', 'IND1', 'IND2', 'IND3', 'POST']],
  ['Firmware and program', ['PROG_STATE', 'PROG_RESULT']],
];

/** Builtin constant families (the same enums `builtinConstants()` merges for the compiler). */
const CONST_GROUPS: [string, object][] = [
  ['Directions', Dir],
  ['Status codes (@STATUS)', Status],
  ['Light colors (@IND1–3)', LightColor],
  ['Systems (USE)', SystemId],
  ['Alerts (@ALERT)', Alert],
  ['Program states (@PROG_STATE)', ProgState],
];

const SECTIONS = [
  ['basics', 'Basics'],
  ['instr', 'Instructions'],
  ['ports', 'Ports'],
  ['tools', 'Tools'],
  ['registry', 'Registry'],
] as const;

/** Split `items` into the named groups (in order) plus an "Other" group for leftovers. */
function grouped<T>(items: T[], key: (t: T) => string, groups: [string, string[]][]): [string, T[]][] {
  const byKey = new Map(items.map((t) => [key(t), t]));
  const used = new Set<string>();
  const out: [string, T[]][] = groups.map(([title, keys]) => {
    const rows = keys.filter((k) => byKey.has(k)).map((k) => (used.add(k), byKey.get(k)!));
    return [title, rows];
  });
  const rest = items.filter((t) => !used.has(key(t)));
  if (rest.length) out.push(['Other', rest]);
  return out.filter(([, rows]) => rows.length > 0);
}

const enumEntries = (e: object) => Object.entries(e).filter(([, v]) => typeof v === 'number') as [string, number][];
const constList = (entries: [string, number][]) =>
  `<p class="consts">${entries.map(([k, v]) => `<code>${k}=${v}</code>`).join(' ')}</p>`;

function basicsHtml(): string {
  return `
    <h4>Two slots</h4>
    <p>The <b>program</b> is your task (Code tab, Program): the firmware runs it in time slices with
    <code>RUN</code>; it finishes with <code>END [value]</code>. The <b>firmware</b> keeps the rover alive and decides when the
    program runs (advanced). Both share the flash; each has its own labels, <code>CONST</code>s, registers and stacks.
    The firmware reads the program's state in <code>@PROG_STATE</code> and its result in <code>@PROG_RESULT</code>.</p>
    <h4>Syntax</h4>
    <p>One instruction per line. <code>label:</code> marks a jump target, <code>;</code> starts a comment.
    The program loops back to the top when it runs off the end.
    Compute instructions are fast (several per tick); hardware instructions (<code>SCAN STEP SLEEP ACT USE SNAP</code>) end the tick and take time.
    Names are case-insensitive.</p>
    <h4>Program size</h4>
    <p>Flash is counted in bytes: opcode ${E.opcode} B; register ${E.register} B; port ${E.port} B;
    number 0–${E.shortImmMax} ${E.shortImm} B, −128…127 ${E.imm8} B, up to ±32767 ${E.imm16} B, larger ${E.imm32} B; label used as a jump/call target ${E.label} B.
    Constants cost what their value costs (<code>NORTH</code> 1 B, <code>IRON_ORE</code> 1 B).
    Labels, comments, <code>ALIAS r0 name</code> and <code>CONST NAME 5</code> themselves cost nothing.
    Example: <code>JLE @BAT 20 home</code> = ${E.opcode}+${E.port}+${E.imm8}+${E.label} = ${E.opcode + E.port + E.imm8 + E.label} B.</p>
    <h4>Machine code</h4>
    <p>The listing beside the editor shows it while you type. Opcode byte = instruction number (hex column in Instructions), plus 0x20 per
    optional operand given (<code>STEP 1 2</code> = <code>34 01 02</code>). Operand bytes: <code>00</code>–<code>0F</code> number 0–15,
    <code>10</code>–<code>17</code> register r0–r7, <code>40</code>–<code>7F</code> port (hex column in Ports), <code>18</code> / <code>19</code> / <code>1A</code>
    followed by an 8 / 16 / 32-bit number; a label is its 2-byte address. Each slot starts at address 0x000:
    <code>JLE @BAT 20 home</code> with <code>home</code> at 0x02A = <code>0E 40 18 14 00 2A</code>.</p>
    <h4>Keys</h4>
    <table>
      <tr><td><code>Ctrl+Enter</code></td><td>upload</td></tr>
      <tr><td><code>Space</code></td><td>pause (outside the editor)</td></tr>
      <tr><td><code>.</code></td><td>step one instruction</td></tr>
      <tr><td><code>V</code></td><td>camera view</td></tr>
      <tr><td><code>F</code></td><td>follow rover</td></tr>
      <tr><td><code>Q</code> / <code>E</code></td><td>rotate camera</td></tr>
      <tr><td><code>B</code></td><td>bloom</td></tr>
      <tr><td><code>P</code></td><td>frame-time HUD</td></tr>
    </table>`;
}

function instructionsHtml(): string {
  return grouped(OPCODES as Op[], (o) => o, OP_GROUPS)
    .map(([title, ops]) => `<h4>${title}</h4><table>${ops
      .map((op) => `<tr><td><code>${formatSig(op)}</code></td><td class="dim"><code>${h2(OPCODE_NUMBERS[op])}</code></td><td>${NOTES[op] ?? ''}${HARDWARE_OPS.has(op) && !title.startsWith('Hardware') ? ' <span class="dim">(hardware)</span>' : ''}</td></tr>`)
      .join('')}</table>`)
    .join('');
}

function portsHtml(): string {
  return `<p class="small dim">R = readable, W = writable. Hex = machine-code operand byte.</p>` + grouped(PORTS, (p) => p.name, PORT_GROUPS)
    .map(([title, ports]) => `<h4>${title}</h4><table>${ports
      .map((p) => `<tr><td><code>@${p.name}</code></td><td class="dim"><code>${h2(0x40 | PORT_CODES.indexOf(p.name))}</code></td><td>${p.read ? 'R' : ''}${p.write ? 'W' : ''}</td><td>${esc(p.description)}</td></tr>`)
      .join('')}</table>`)
    .join('');
}

function toolsHtml(): string {
  const cost = (t: { ticks: number; energy: number }) => `<span class="dim">${t.ticks} ticks, ${t.energy / 1000}% battery</span>`;
  const hardpoints = CHASSIS_MK1.tools
    .map((id, i) => {
      if (!id) return `<tr><td><code>ACT TOOL_${i}</code></td><td>empty hardpoint: <code>ERR_NO_TOOL</code>. With the upgrade: <b>${TOOLS.SEISMIC.name}</b> (<code>ACT TOOL_${i} &lt;dir&gt;</code>): ${esc(TOOLS.SEISMIC.description)} ${cost(TOOLS.SEISMIC)}</td></tr>`;
      const t = TOOLS[id];
      return `<tr><td><code>ACT TOOL_${i} &lt;${t.arg}&gt;</code></td><td><b>${t.name}</b>: ${esc(t.description)} ${cost(t)}</td></tr>`;
    })
    .join('');
  return `
    <h4>Hardpoints (Mk-I)</h4>
    <p class="small dim"><code>ACT TOOL_n arg</code> fires the tool mounted in hardpoint n.</p>
    <table>${hardpoints}</table>
    <h4>Built-in</h4>
    <table>
      <tr><td><code>SNAP &lt;dir&gt; [mode]</code></td><td><b>${TOOLS.CAMERA.name}</b>: ${esc(TOOLS.CAMERA.description)} ${cost(TOOLS.CAMERA)}</td></tr>
      <tr><td><code>USE &lt;slot&gt; [system]</code></td><td><b>${TOOLS.USE_ITEM.name}</b>: ${esc(TOOLS.USE_ITEM.description)} ${cost(TOOLS.USE_ITEM)}</td></tr>
    </table>`;
}

const SYS_NAMES = enumEntries(SystemId).reduce<Record<number, string>>((m, [k, v]) => ((m[v] = k), m), {});

function tileNotes(d: TileDef): string {
  const n: string[] = [];
  if (d.moveTicks !== undefined) n.push(`${d.moveTicks} ticks, ${d.moveEnergy ?? 0} energy to enter`);
  if (d.hazardDamage) n.push(`${d.hazardDamage} hull damage`);
  if (d.hazardLevel) n.push(`hazard ${d.hazardLevel}`);
  if (d.blocksMove) n.push('blocks STEP');
  if (d.tool) n.push(`collect with ${TOOLS[d.tool].name}`);
  if (d.science) n.push(`${d.science} science`);
  if (d.repairs) n.push('repairs ' + Object.entries(d.repairs).map(([s, v]) => `${SYS_NAMES[+s] ?? s} +${v}`).join(', '));
  return n.join(' · ');
}

function registryHtml(registry: WorldRegistry): string {
  const layers = enumEntries(Layer).sort((a, b) => a[1] - b[1]);
  const tiles = layers
    .map(([layer, lv]) => {
      const rows = registry.all().filter((d) => d.layer === lv).sort((a, b) => a.id - b.id);
      if (!rows.length) return '';
      return `<h4>${layer[0] + layer.slice(1).toLowerCase()}</h4><table>${rows
        .map((d) => `<tr><td><code>${d.constName.toUpperCase()}</code></td><td class="dim"><code>${d.id}</code></td><td>${esc(d.name)}</td><td class="small">${tileNotes(d)}</td></tr>`)
        .join('')}</table>`;
    })
    .join('');
  const consts = CONST_GROUPS.map(([title, e]) => `<h4>${title}</h4>${constList(enumEntries(e))}`).join('');
  const toolSlots = constList(CHASSIS_MK1.tools.map((_, i) => [`TOOL_${i}`, i]));
  return `
    <p class="small dim">Every tile name is a constant: <code>SCAN</code>, <code>PEEK</code> and <code>@GROUND</code> return these IDs; <code>NONE=0</code>.</p>
    ${tiles}
    ${consts}
    <h4>Hardpoints (ACT)</h4>${toolSlots}`;
}

/** Generated language reference: always in sync with the compiler, port, tool and tile tables. */
export function renderReference(el: HTMLElement, registry: WorldRegistry): void {
  const panes: Record<string, string> = {
    basics: basicsHtml(),
    instr: instructionsHtml(),
    ports: portsHtml(),
    tools: toolsHtml(),
    registry: registryHtml(registry),
  };
  el.innerHTML = `
    <div class="ref-head">
      <div class="ref-tabs">${SECTIONS.map(([id, label], i) => `<button class="ref-tab${i === 0 ? ' active' : ''}" data-ref="${id}">${label}</button>`).join('')}</div>
      <input class="ref-filter" type="search" placeholder="Filter…" title="Show only rows that contain this text" />
    </div>
    ${SECTIONS.map(([id], i) => `<div class="ref-pane${i === 0 ? ' active' : ''}" data-ref="${id}">${panes[id]}</div>`).join('')}`;

  const filter = el.querySelector<HTMLInputElement>('.ref-filter')!;
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    const pane = el.querySelector<HTMLElement>('.ref-pane.active')!;
    pane.querySelectorAll<HTMLElement>('tr, .consts code').forEach((r) => {
      r.hidden = q !== '' && !r.textContent!.toLowerCase().includes(q);
    });
    // Hide headings whose table / list has nothing left to show.
    pane.querySelectorAll<HTMLElement>('h4').forEach((h) => {
      const body = h.nextElementSibling as HTMLElement | null;
      if (!body || (body.tagName !== 'TABLE' && !body.classList.contains('consts'))) return;
      const visible = body.querySelector(body.tagName === 'TABLE' ? 'tr:not([hidden])' : 'code:not([hidden])');
      h.hidden = body.hidden = q !== '' && !visible;
    });
  };
  filter.addEventListener('input', applyFilter);
  el.querySelectorAll<HTMLButtonElement>('.ref-tab').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelectorAll('.ref-tab').forEach((x) => x.classList.toggle('active', x === b));
      el.querySelectorAll<HTMLElement>('.ref-pane').forEach((p) => p.classList.toggle('active', p.dataset.ref === b.dataset.ref));
      applyFilter();
    }),
  );
}
