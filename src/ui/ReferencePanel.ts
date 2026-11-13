import { PORT_CODES, PORTS } from '../core/ports';
import { HARDWARE_OPS, opcodeHex, type Op } from '../core/vm/isa';
import { formatSig, OPCODES } from '../core/vm/Compiler';
import type { TileDef, WorldRegistry } from '../core/WorldRegistry';
import { BALANCE, CHASSIS_MK1, ENCODING as E } from '../core/balance';
import { BOOT_REASON_NAMES, DumpKind, encodeCpuDump, encodeLog, encodeStackDump } from '../core/downlink';
import { emptyDictionary, fieldsHtml, frameFields, type Dictionaries } from './comms';
import { TOOLS } from '../core/tools';
import { UPGRADES } from '../core/upgrades';
import { Alert, Dir, Layer, LightColor, ProgState, Status, SystemId } from '../core/types';
import { PHOTO_FORMATS, photoBytes } from '../core/photos';
import { imageBytes } from '../core/Unit';
import { PROGRAM_TEMPLATES } from '../core/programs';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const h2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

const NOTES: Record<string, string> = {
  MOV: 'copy value', PUSH: 'push to data stack', POP: 'pop from data stack',
  ADD: 'dst += v', SUB: 'dst -= v', MUL: 'dst *= v', DIV: 'dst /= v (truncates)', MOD: 'dst = dst mod v (never negative)',
  AND: 'dst = dst AND v, bit by bit (AND 3 keeps the lowest two bits)', OR: 'dst = dst OR v, bit by bit (sets the bits of v)',
  SHL: 'shift dst left by v bits (SHL 2 = × 4); v clamped to 0–32', SHR: 'shift dst right by v bits, zeros come in from the left (SHR 2 = / 4 for values ≥ 0); v clamped to 0–32',
  JMP: 'jump', JEQ: 'jump if a == b', JNE: 'jump if a != b', JLT: 'jump if a < b', JGT: 'jump if a > b', JLE: 'jump if a <= b', JGE: 'jump if a >= b',
  CALL: 'push args, call', RET: 'return',
  SLEEP: 'wait N ticks', SCAN: 'ray: dest1 = tile type, dest2 = distance', STEP: 'drive [tiles] in dir', ACT: 'fire tool in hardpoint (see Tools)', PEEK: 'dest = item ID in cargo slot', USE: 'repair [system] (default SYS_HULL) by consuming the material in cargo slot (see Tools)',
  SNAP: 'photograph the subject in dir into image memory (see Tools); nothing is sent until SEND. Mk-I modes 1 (grey) and 2 (dithered), 256 B each; needs daylight or the headlight aimed at dir',
  LDB: 'dst = byte at addr of image memory (0–255); the address wraps at the memory size (Mk-I 256 B). 1 cycle, no @STATUS',
  STB: 'byte at addr of image memory = v (only the low 8 bits: 256 → 0, −1 → 255). 1 cycle, no @STATUS. Makes the next SEND of the photo "edited"',
  SEND: 'copy image memory into the science recorder as a photo of [type] (default: the last SNAP\'s mode; SEND 1 = 32×32 grey). The first SEND after a SNAP carries its credits; any other SEND is a "drawn" picture worth nothing. Image memory is kept. 1 tick, 10 energy; ERR_FULL (recorder), ERR_INVALID (type), ERR_LOW_POWER',
  ERASE: 'zero all of image memory and forget the last SNAP (the next SEND is a drawn picture). Image memory keeps its contents through reboots and power loss until ERASE or a new SNAP. 2 ticks, 10 energy',
  LOG: 'queue a log frame for the downlink (Comms tab). tag: number or CONST 0–14 (15 = system). 1 cycle, no @STATUS; dropped if the FIFO is full (@LOG_LOST)',
  BRK: 'breakpoint: halt the CPU (HALTED) until mission control sends Resume (Continue) or you upload; the world keeps running, no watchdog. The rover sends a register dump by itself (Comms: "sent by BRK"). 1 cycle. In a program: halts only the program (PROG_HALTED)',
  RUN: 'firmware only: run the program for N ticks (a STEP or SLEEP in progress finishes first), then continue here. @STATUS ERR_INVALID if @PROG_STATE is not PROG_READY',
  END: 'program only: finish with @PROG_STATE = PROG_DONE and @PROG_RESULT = value (default 0); control returns to the firmware',
};

/** Instruction sections. An opcode not listed here lands in "Other", so new ones still show up. */
const OP_GROUPS: [string, Op[]][] = [
  ['Data', ['MOV', 'PUSH', 'POP']],
  ['Arithmetic', ['ADD', 'SUB', 'MUL', 'DIV', 'MOD']],
  ['Bits (2-byte opcodes)', ['AND', 'OR', 'SHL', 'SHR']],
  ['Flow control', ['JMP', 'JEQ', 'JNE', 'JLT', 'JGT', 'JLE', 'JGE', 'CALL', 'RET']],
  ['Hardware (end the tick, write @STATUS)', ['SLEEP', 'SCAN', 'STEP', 'ACT', 'PEEK', 'USE', 'SNAP']],
  ['Image memory (SNAP → LDB / STB → SEND)', ['LDB', 'STB', 'SEND', 'ERASE']],
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
  ['consts', 'Constants'],
  ['radio', 'Radio'],
  ['image', 'Image'],
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
    Compute instructions are fast (several per tick); hardware instructions (<code>SCAN STEP SLEEP ACT USE SNAP SEND ERASE</code>) end the tick and take time.
    Names are case-insensitive.</p>
    <h4>Registers</h4>
    <p>The Mk-I has ${CHASSIS_MK1.registers} registers, <code>r0</code>–<code>r${CHASSIS_MK1.registers - 1}</code>${regUpgrades()}.
    Each holds a signed 32-bit integer that wraps on overflow. All of them are general purpose: no register has a fixed meaning,
    and any of them can hold a direction, a count, a tile ID or a coordinate (<code>STEP r2</code>, <code>JEQ r1 IRON_ORE found</code>).
    <code>ALIAS r0 dir</code> gives a register a name (free, compile time only); the shipped firmware's <code>dir</code> is just its own choice.
    The firmware and the program each have their own set. A reboot (upload or watchdog) zeroes them; a register the chassis
    does not have is a compile error.</p>
    <h4>Program size</h4>
    <p>Flash is counted in bytes: opcode ${E.opcode} B; register ${E.register} B; port ${E.port} B;
    number 0–${E.shortImmMax} ${E.shortImm} B, −128…127 ${E.imm8} B, up to ±32767 ${E.imm16} B, larger ${E.imm32} B; label used as a jump/call target ${E.label} B.
    Constants cost what their value costs (<code>NORTH</code> 1 B, <code>IRON_ORE</code> 1 B).
    Labels, comments, <code>ALIAS r0 name</code> and <code>CONST NAME 5</code> themselves cost nothing.
    Example: <code>JLE @BAT 20 home</code> = ${E.opcode}+${E.port}+${E.imm8}+${E.label} = ${E.opcode + E.port + E.imm8 + E.label} B.</p>
    <h4>Machine code</h4>
    <p>The listing beside the editor shows it while you type. Opcode byte = instruction number (hex column in Instructions), plus 0x20 per
    optional operand given (<code>STEP 1 2</code> = <code>34 01 02</code>). The one-byte numbers ran out, so newer instructions
    (the bit instructions) have a 2-byte opcode: the prefix <code>1F</code>, then their own number (<code>AND r0 3</code> =
    <code>1F 01 10 03</code>), like the prefix bytes of real CPUs. One byte longer, just as fast. Operand bytes: <code>00</code>–<code>0F</code> number 0–15,
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
      .map((op) => `<tr><td><code>${formatSig(op)}</code></td><td class="dim"><code>${opcodeHex(op)}</code></td><td>${NOTES[op] ?? ''}${HARDWARE_OPS.has(op) && !title.startsWith('Hardware') ? ' <span class="dim">(hardware)</span>' : ''}</td></tr>`)
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

/** ` (upgrades: …)` listing the register-file upgrades, or nothing. */
function regUpgrades(): string {
  const ups = UPGRADES.filter((u) => u.id.startsWith('REGS_'));
  return ups.length ? `; upgrades: ${ups.map((u) => `<b>${esc(u.title)}</b>`).join(', ')}, values kept` : '';
}

function constantsHtml(registry: WorldRegistry): string {
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
    <p class="small dim">Names that stand for a fixed number; usable wherever a value goes. Your own: <code>CONST NAME 5</code>.</p>
    <h3>Tiles</h3>
    <p class="small dim">Every tile name is a constant: <code>SCAN</code>, <code>PEEK</code> and <code>@GROUND</code> return these IDs; <code>NONE=0</code>.</p>
    ${tiles}
    <h3>Other constants</h3>
    ${consts}
    <h4>Hardpoints (ACT)</h4>${toolSlots}`;
}

/** Example program the Radio examples are decoded against (as if it were on the rover). */
const EXAMPLE_DICT: Dictionaries = {
  firmware: emptyDictionary(),
  program: {
    tags: { 2: { names: ['T_BAT'], lines: [55] }, 3: { names: ['T_SEEN'], lines: [21] } },
    regs: { 0: ['dir'], 1: ['seen'], 2: ['dist'] },
    lineAt: (a) => ({ 0x26: 18, 0x1a: 9 })[a] ?? 0,
  },
};

/**
 * Radio: what goes up and down and every byte of what comes down (SPEC §3.8). The example
 * tables come from the same decoder as the Comms tab's "Decode bytes", so they always match.
 */
function radioHtml(): string {
  const ex = (bytes: number[]) => fieldsHtml(frameFields(bytes, EXAMPLE_DICT));
  const regs = encodeCpuDump({ ip: 0x26, status: 0, state: ProgState.PROG_RUNNING, regs: [3, 255, -1, 0], dsDepth: 2, csDepth: 1 }, DumpKind.PROG_CPU);
  const stacks = encodeStackDump([5, -2], [0x1a], DumpKind.PROG_STACKS);
  const ch = CHASSIS_MK1;
  return `
    <p class="small dim">The rover and mission control talk by radio through the relay orbiter. The <b>Comms</b> tab lists
    everything; its <b>Decode bytes</b> shows any message like the examples below. Examples assume a program with
    <code>ALIAS r0 dir</code>, <code>ALIAS r1 seen</code>, <code>ALIAS r2 dist</code> and <code>CONST T_BAT 2</code>.</p>
    <h4>▲ Up and ▼ down</h4>
    <table class="radio-kv">
      <tr><td>▲ up</td><td>Code uploads (Code tab), <b>Dump registers</b>, <b>Dump stacks</b>, <b>Resume after BRK</b>, <b>Restart</b>.
        Each costs battery (less at a good signal) and needs signal ${BALANCE.linkMinSignal} or more.</td></tr>
      <tr><td>▼ down</td><td>${ch.linkBytesPerTick} B per tick at full signal, nothing below ${BALANCE.linkMinSignal}. Order: dumps first
        (the ones you asked for, and the register dump a <code>BRK</code> sends by itself),
        then <code>LOG</code> messages (a ${ch.logFifoBytes} B queue: when it is full new ones are <b>lost</b>, <code>@LOG_LOST</code>),
        then science (photos, spectra: Gallery).</td></tr>
      <tr><td>never</td><td>The rover never sends its code back: mission control keeps a copy of what it uploaded (<b>Revert</b> uses it).</td></tr>
    </table>
    <h4>Header byte</h4>
    <p class="small dim">Every message starts with one header byte, read as bits <code>k|tttt|ss|0</code>:</p>
    <table class="radio-kv">
      <tr><td><code>k</code> bit 7</td><td>0 = <code>LOG</code> or system message; 1 = a frame with a length (dumps, science)</td></tr>
      <tr><td><code>tttt</code> bits 6–3</td><td>tag 0–14 (your <code>LOG tag</code>, named by your <code>CONST</code>); 15 = system</td></tr>
      <tr><td><code>ss</code> bits 2–1</td><td>value size: <code>00</code> none, <code>01</code> 1 byte, <code>10</code> 2 bytes, <code>11</code> 4 bytes.
        In a science frame (tag = product type): the picture's processing level, <code>00</code> raw, <code>01</code> edited, <code>10</code> drawn</td></tr>
    </table>
    <h4>Numbers</h4>
    <table class="radio-kv">
      <tr><td>byte order</td><td>High byte first: <code>03 2C</code> = 3 × 256 + 44 = 812.</td></tr>
      <tr><td>negative</td><td>Two's complement, counted down from all ones: <code>FF</code> = −1, <code>FE</code> = −2;
        in 4 bytes <code>FF FF FF FF</code> = −1, <code>00 00 00 FF</code> = 255.</td></tr>
      <tr><td>LOG size</td><td><code>LOG</code> uses the smallest size that fits: −128…127 1 byte, up to ±32767 2 bytes, else 4. Small values queue faster.</td></tr>
      <tr><td>addresses</td><td>2 bytes, a byte address in the slot's machine code (the listing's address column).</td></tr>
    </table>
    <h4>LOG message: <code>LOG T_BAT 812</code></h4>${ex(encodeLog(2, 812))}
    <h4>LOG without a value: <code>LOG T_SEEN</code></h4>${ex(encodeLog(3, null))}
    <h4>System message: reboot</h4>${ex(encodeLog(15, 2))}
    <table class="radio-kv">${Object.entries(BOOT_REASON_NAMES).map(([v, n]) => `<tr><td>boot reason ${v}</td><td>${n}</td></tr>`).join('')}</table>
    <h4>Register dump (▲ Dump registers)</h4>
    <p class="small dim">The CPU state of one slot at the moment the request arrived, or when a <code>BRK</code> stopped it
    (then the rover sends it unasked; <i>next</i> is the instruction after the <code>BRK</code>). A firmware dump (kind 1) has
    the same layout; its state is the CPU's: RUNNING, BLOCKED, HALTED or FAULT. While a program is not running
    (<code>PROG_NONE</code>, <code>PROG_DONE</code>) its <i>next</i> means nothing.</p>
    ${ex(regs)}
    <h4>Stack dump (▲ Dump stacks)</h4>
    <p class="small dim">The values <code>PUSH</code>ed and not yet <code>POP</code>ped, and where each unfinished <code>CALL</code>
    returns to. Firmware: kind 2.</p>
    ${ex(stacks)}
    <h4>Dump kinds</h4>
    <table class="radio-kv">
      <tr><td><code>01</code></td><td>firmware registers</td></tr><tr><td><code>02</code></td><td>firmware stacks</td></tr>
      <tr><td><code>03</code></td><td>program registers</td></tr><tr><td><code>04</code></td><td>program stacks</td></tr>
    </table>`;
}

/** What a pixel value means in each photo kind. */
const PIXEL_MEANING: Record<string, string> = {
  grey: 'grey 0–3',
  dither: 'grey 0–3',
  palette: 'palette 0–15',
  rgb332: '<code>RRRGGGBB</code>',
};

/**
 * Image: image memory (SPEC §3.8.7), from the player guide docs/IMAGE_MEMORY.md. Sizes, costs
 * and formats come from the game's own tables (BALANCE, PHOTO_FORMATS, imageBytes).
 */
function imageHtml(): string {
  const B = BALANCE;
  const examples = Object.keys(PROGRAM_TEMPLATES).filter((n) => n.startsWith('Image: '));
  const teaches: Record<string, string> = {
    'Image: Line': 'rows, addresses, <code>ERASE</code>',
    'Image: Test pattern': 'grey levels, computing a byte from its address',
    'Image: Negative': '<code>SNAP</code> → change → <code>SEND</code>',
    'Image: Stamp': 'numbers as bytes (masks and shifts)',
    'Image: Plot': 'single pixels inside a byte',
    'Image: Memory map': 'image memory as plain memory (a map of visited tiles)',
  };
  const modes = Object.entries(PHOTO_FORMATS)
    .map(([m, f]) => `<tr><td>${m}</td><td>${f.w}×${f.h}</td><td>${8 / f.bpp}</td><td>${(f.w * f.bpp) / 8}</td><td>${photoBytes(Number(m))} B</td><td>${PIXEL_MEANING[f.kind]}</td></tr>`)
    .join('');
  return `
    <p class="small dim">The camera does not send a photo by itself. Taking a picture, changing it and sending it are
    three steps, and your program decides what happens in between. Real rovers work the same way: Curiosity's cameras keep
    their images in their own memory, and only the products made from them go to Earth.</p>
    <pre class="ref-diagram">        SNAP               SEND
camera ─────► image memory ─────► recorder ──► downlink ──► Gallery
                ▲     │
            STB │     │ LDB
                └ your program</pre>
    <h4>Instructions</h4>
    <table class="radio-kv">
      <tr><td><code>SNAP dir [mode]</code></td><td>Photograph into image memory (overwrites all of it). ${B.snapTicks} ticks, ${B.snapEnergy} energy. Nothing is sent yet.</td></tr>
      <tr><td><code>LDB dst addr</code></td><td>Read one byte (0–255). 1 cycle, no energy, no <code>@STATUS</code>.</td></tr>
      <tr><td><code>STB addr v</code></td><td>Write one byte (only the low 8 bits: 256 → 0, −1 → 255). 1 cycle, no energy, no <code>@STATUS</code>.</td></tr>
      <tr><td><code>SEND [type]</code></td><td>Copy image memory into the science recorder as a photo of <code>type</code> (default: the last <code>SNAP</code>'s mode).
        Image memory is kept. ${B.sendTicks} tick, ${B.sendEnergy} energy; <code>ERR_FULL</code>, <code>ERR_INVALID</code>, <code>ERR_LOW_POWER</code>.</td></tr>
      <tr><td><code>ERASE</code></td><td>Set every byte to 0 and forget the last <code>SNAP</code>. ${B.eraseTicks} ticks, ${B.eraseEnergy} energy.</td></tr>
    </table>
    <h4>Rows and addresses (modes 1 and 2: 32×32 grey)</h4>
    <p class="small">Stored row by row, top row first. A pixel has 4 grey levels (2 bits), so <b>one byte holds 4 pixels</b>:
    a row of 32 pixels is 8 bytes, the picture ${photoBytes(1)} bytes (addresses 0–${photoBytes(1) - 1}).
    <b>address = y × 8 + x / 4</b> (rounded down) = <code>(y SHL 3) + (x SHR 2)</code>. Pixel (10, 3) is in byte 3 × 8 + 2 = 26.</p>
    <pre class="ref-diagram">         x: 0–3   4–7   8–11  …  28–31
row  0:  byte   0     1     2   …    7
row  1:  byte   8     9    10   …   15
  …
row 31:  byte 248   249   250   …  255</pre>
    <h4>Inside a byte</h4>
    <pre class="ref-diagram">bit:     7 6     5 4     3 2     1 0
       pixel 0 pixel 1 pixel 2 pixel 3     (x AND 3 tells which)
weight:   64      16      4       1</pre>
    <table class="radio-kv">
      <tr><td><code>0</code></td><td><code>00 00 00 00</code> four black pixels</td></tr>
      <tr><td><code>85</code> = <code>0x55</code></td><td><code>01 01 01 01</code> four dark grey</td></tr>
      <tr><td><code>170</code> = <code>0xAA</code></td><td><code>10 10 10 10</code> four light grey</td></tr>
      <tr><td><code>255</code> = <code>0xFF</code></td><td><code>11 11 11 11</code> four white</td></tr>
      <tr><td><code>192</code> = <code>0xC0</code></td><td><code>11 00 00 00</code> white, then three black</td></tr>
    </table>
    <h4>Pixel recipes (bit instructions)</h4>
    <p class="small dim">Pixel <code>k</code> = <code>x AND 3</code> sits <code>shift = 6 − 2k</code> bits up. Example: byte <code>0xD8</code> = <code>11 01 10 00</code>, pixel 1 (shift 4).</p>
    <table class="radio-kv">
      <tr><td>read</td><td><code>(byte SHR shift) AND 3</code>: <code>0xD8 SHR 4</code> = <code>1101</code>, <code>AND 3</code> = 1</td></tr>
      <tr><td>mask</td><td><code>3 SHL shift</code> = <code>00 11 00 00</code></td></tr>
      <tr><td>clear</td><td><code>OR mask</code>, then <code>SUB mask</code> (there is no NOT): <code>11 00 10 00</code></td></tr>
      <tr><td>set</td><td><code>OR (colour SHL shift)</code>: colour 2 gives <code>11 10 10 00</code></td></tr>
      <tr><td>without bits</td><td>read <code>(byte / weight) MOD 4</code>; change <code>byte − old × weight + new × weight</code></td></tr>
    </table>
    <h4>Camera modes and memory size</h4>
    <p class="small dim">Image memory is as big as the largest picture the camera can take: ${imageBytes(CHASSIS_MK1)} B on Mk-I,
    more with the camera upgrades (Upgrades tab). Bigger pictures take more bytes to send. Grey: 0 black … 3 white;
    mode 5: red 0–7, green 0–7, blue 0–3 in one byte.</p>
    <table>
      <tr class="dim"><td>mode</td><td>picture</td><td>px/byte</td><td>B/row</td><td>size</td><td>pixel</td></tr>
      ${modes}
    </table>
    <h4>Things to know</h4>
    <table class="radio-kv">
      <tr><td>keeps</td><td>Image memory keeps its contents through reboots and a flat battery, like a camera's flash memory.
        Only a new <code>SNAP</code> or <code>ERASE</code> clears it, never <code>SEND</code>.</td></tr>
      <tr><td>wraps</td><td>Addresses wrap around the memory size: on Mk-I address 256 is byte 0, −1 is byte 255. No error.</td></tr>
      <tr><td>type</td><td><code>SEND type</code> only says how mission control decodes the bytes: <code>SEND 1</code> shows any bytes as a 32×32 grey photo.</td></tr>
      <tr><td>labels</td><td>The Gallery labels what arrived: <b>raw</b> (sent as the camera took it), <b>edited</b> (changed with <code>STB</code>),
        <b>drawn</b> (no camera picture behind it). The label travels in the header byte (Radio).</td></tr>
      <tr><td>credits</td><td>Only the first <code>SEND</code> after a <code>SNAP</code>, of the same type, earns photo credits, edited or not.
        Drawn pictures earn nothing. Anomaly flags are checked against the real tile.</td></tr>
      <tr><td>speed</td><td>Touching every byte costs about 6 cycles each: ~400 ticks for a whole 32×32 picture on Mk-I. Programs run in time slices, so long loops just take longer.</td></tr>
    </table>
    <h4>Examples (Code tab → Program → template)</h4>
    <table class="radio-kv">
      ${examples.map((n) => `<tr><td>${esc(n.slice(7))}</td><td>${teaches[n] ?? ''}</td></tr>`).join('')}
    </table>`;
}

/** Generated language reference: always in sync with the compiler, port, tool and tile tables. */
export function renderReference(el: HTMLElement, registry: WorldRegistry): void {
  const panes: Record<string, string> = {
    basics: basicsHtml(),
    instr: instructionsHtml(),
    ports: portsHtml(),
    tools: toolsHtml(),
    consts: constantsHtml(registry),
    radio: radioHtml(),
    image: imageHtml(),
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
    // Hide a part heading (h3) when every section under it is hidden.
    pane.querySelectorAll<HTMLElement>('h3').forEach((h) => {
      let any = false;
      for (let n = h.nextElementSibling as HTMLElement | null; n && n.tagName !== 'H3'; n = n.nextElementSibling as HTMLElement | null)
        if (n.tagName === 'H4' && !n.hidden) any = true;
      h.hidden = q !== '' && !any;
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
