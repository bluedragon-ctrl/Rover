import { PORT_CODES, PORTS } from '../core/ports';
import { opcodeHex, PROGRAM_GATE, ROM_BASE, type Op } from '../core/vm/isa';
import { formatSig, OPCODES, romCompile } from '../core/vm/Compiler';
import { ROM_ARGS, ROM_ENTRIES, ROM_SOURCE } from '../core/rom';
import { buildListing, listingText } from './listing';
import type { TileDef, WorldRegistry } from '../core/WorldRegistry';
import { BALANCE, CHASSIS_MK1, ENCODING as E, MEMORY_MAP } from '../core/balance';
import { BOOT_REASON_NAMES, DumpKind, encodeCpuDump, encodeLog, encodeStackDump } from '../core/downlink';
import { emptyDictionary, fieldsHtml, frameFields, type Dictionaries } from './comms';
import { TOOLS } from '../core/tools';
import { UPGRADES } from '../core/upgrades';
import { Alert, Dir, Layer, LightColor, Preempt, ProgState, Status, SystemId } from '../core/types';
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
  CALL: 'push args, call a label of yours or a ROM routine (CALL STEP EAST 3: see ROM). Firmware only: CALL PROGRAM calls the program slot (@SLICE ticks; 0 = no limit), @STATUS ERR_INVALID if it is not PROG_READY',
  RET: 'return. In the program, a RET with nothing to return to ends the program: PROG_DONE with @PROG_RESULT = r0',
  WAIT: 'WAIT @port: sleep until the port reads 0 (no energy; checked at the start of every tick). On a device\'s port (@DRIVE, @RADAR, @TOOL, @REPAIR, @CAM, @SEND, @ERASE) @STATUS then says how the device\'s work ended. 1 cycle',
  LDB: 'LDB dst [addr]: dst = the byte (0–255) at data address addr: RAM from 0, image memory from IMG, cargo from CARGO (Basics → Memory map). [r], [n], [r+n]. No memory there: FAULT. 1 cycle, no @STATUS',
  STB: 'STB [addr] v: byte at data address addr = v (only the low 8 bits: 256 → 0, −1 → 255). Cargo is read-only; no memory there: FAULT. 1 cycle, no @STATUS. Into image memory: makes the next send of the photo "edited"',
  LDF: 'LDF dst [addr]: dst = the byte at addr of this slot\'s own Flash, e.g. a DATA table: LDF r0 [route+r1]. Past the end of the slot: FAULT. 1 cycle, no @STATUS',
  LOG: 'queue a log frame for the downlink (Comms tab). tag: number or CONST 0–14 (15 = system). 1 cycle, no @STATUS; dropped if the FIFO is full (@LOG_LOST)',
  BRK: 'breakpoint: halt the CPU (HALTED) until mission control sends Resume (Continue) or you upload; the world keeps running, no watchdog. The rover sends a register dump by itself (Comms: "sent by BRK"). 1 cycle. In a program: halts only the program (PROG_HALTED)',
  END: 'program only: finish with @PROG_STATE = PROG_DONE and @PROG_RESULT = value (default 0); control returns to the firmware',
};

/** Instruction sections. An opcode not listed here lands in "Other", so new ones still show up. */
const OP_GROUPS: [string, Op[]][] = [
  ['Data', ['MOV', 'PUSH', 'POP']],
  ['Arithmetic', ['ADD', 'SUB', 'MUL', 'DIV', 'MOD']],
  ['Bits (2-byte opcodes)', ['AND', 'OR', 'SHL', 'SHR']],
  ['Flow control', ['JMP', 'JEQ', 'JNE', 'JLT', 'JGT', 'JLE', 'JGE', 'CALL', 'RET']],
  ['Devices (the hardware is driven through ports: see Ports → Devices, and the ROM)', ['WAIT']],
  ['Memory (load / store: the only instructions that touch memory)', ['LDB', 'STB', 'LDF']],
  ['Program, log and debug', ['END', 'LOG', 'BRK']],
];

/** Port sections. A port not listed here lands in "Other", so new ones still show up. */
const PORT_GROUPS: [string, string[]][] = [
  ['Health and power', ['BAT', 'HULL', 'SOLAR_HEALTH', 'ANTENNA_HEALTH', 'TEMP', 'HEATER']],
  ['Position and motion', ['X', 'Y', 'HEADING', 'TICK', 'STATUS']],
  ['Sensors and ground', ['GROUND', 'GROUND_HAZARD', 'SENSOR_RANGE', 'SEISMIC_TYPE', 'SEISMIC_DIST']],
  ['Cargo, science and supplies', ['CARGO_FREE', 'SCIENCE_READY', 'REC_FREE', 'DROPS', 'DROP_X', 'DROP_Y']],
  ['Sun and solar array', ['SUN_AZIMUTH', 'SUN_ELEV', 'SUN_LIGHT', 'SOLAR_OPEN', 'SOLAR_ANGLE', 'SOLAR_DUST']],
  ['Devices: write to start (@STATUS = accepted?), read = work left, WAIT @port for the result', ['TIMER', 'DRIVE', 'DRIVE_N', 'RADAR', 'RADAR_HIT', 'RADAR_DIST', 'TOOL', 'TOOL_ARG', 'REPAIR', 'REPAIR_SYS', 'CAM', 'CAM_MODE', 'SEND', 'ERASE']],
  ['Comms and log', ['ORBIT_AZIMUTH', 'ANTENNA_ANGLE', 'SIGNAL_STR', 'LOG_FREE', 'LOG_LOST']],
  ['World events', ['ALERT', 'ALERT_ETA']],
  ['Lights and displays', ['HEADLIGHT', 'IND1', 'IND2', 'IND3', 'POST']],
  ['Firmware and program', ['PROG_STATE', 'PROG_RESULT', 'SLICE']],
  ['Watchdog and fault protection (firmware writes)', ['WDT', 'PREEMPT', 'BAT_ALARM', 'PREEMPTED']],
];

/** Builtin constant families (the same enums `builtinConstants()` merges for the compiler). */
const CONST_GROUPS: [string, object][] = [
  ['Directions', Dir],
  ['Status codes (@STATUS)', Status],
  ['Light colors (@IND1–3)', LightColor],
  ['Systems (@REPAIR_SYS, CALL USE)', SystemId],
  ['Alerts (@ALERT)', Alert],
  ['Program states (@PROG_STATE)', ProgState],
  ['Memory map (data addresses)', MEMORY_MAP],
  ['Fault protection (@PREEMPT bits)', Preempt],
];

const SECTIONS = [
  ['basics', 'Basics'],
  ['instr', 'Instructions'],
  ['ports', 'Ports'],
  ['devices', 'Devices'],
  ['tools', 'Tools'],
  ['consts', 'Constants'],
  ['radio', 'Radio'],
  ['image', 'Image'],
  ['rom', 'ROM'],
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
    <p>The <b>program</b> is your task (Code tab, Program): the firmware calls it for time slices with
    <code>CALL RUN ticks</code>; it finishes with <code>END [value]</code> (or a <code>RET</code> at its top level). The <b>firmware</b> keeps the rover alive and decides when the
    program runs (advanced). Both share the flash; each has its own labels, <code>CONST</code>s, registers and stacks.
    The firmware reads the program's state in <code>@PROG_STATE</code> and its result in <code>@PROG_RESULT</code>.</p>
    <h4>Syntax</h4>
    <p>One instruction per line. <code>label:</code> marks a jump target, <code>;</code> starts a comment.
    The program loops back to the top when it runs off the end.
    Every instruction takes 1 cycle (${CHASSIS_MK1.cyclesPerTick} per tick on the Mk-I). The CPU only computes and moves data: the hardware
    (drive, radar, tools, camera…) are <b>devices</b> you start by writing a port and wait for with <code>WAIT @port</code>. The ROM has
    a ready-made routine for each (<code>CALL STEP EAST 3</code>, <code>CALL SCAN dir</code>: see ROM) that you can read and copy.
    Names are case-insensitive.</p>
    <h4>Program size</h4>
    <p>Flash is counted in bytes: opcode ${E.opcode} B; register ${E.register} B; port ${E.port} B;
    number 0–${E.shortImmMax} ${E.shortImm} B, −128…127 ${E.imm8} B, up to ±32767 ${E.imm16} B, larger ${E.imm32} B; label used as a jump/call target ${E.label} B.
    Constants cost what their value costs (<code>NORTH</code> 1 B, <code>IRON_ORE</code> 1 B).
    Address in brackets: <code>[r]</code> ${E.memReg} B, <code>[n]</code> or <code>[r+n]</code> ${E.memAddr} B. <code>DATA</code> costs one byte per value.
    Labels, comments, <code>ALIAS r0 name</code>, <code>CONST NAME 5</code> and <code>VAR name</code> themselves cost nothing.
    Example: <code>JLE @BAT 20 home</code> = ${E.opcode}+${E.port}+${E.imm8}+${E.label} = ${E.opcode + E.port + E.imm8 + E.label} B.</p>
    <p class="small dim">Below: <b>CPU</b> (registers, cycles, stacks, calls, machine code) and <b>Memory map</b> (RAM, image memory, cargo,
    Flash, ROM). The hardware behind the ports: <b>Devices</b>.</p>
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

const hex3 = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(3, '0');
const hex4 = (n: number) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
const romBytes = () => romCompile().flashUsed;
const maxOf = (key: 'flashBytes' | 'ramBytes') =>
  Math.max(CHASSIS_MK1[key], ...UPGRADES.flatMap((u) => {
    const c = { ...CHASSIS_MK1, tools: [...CHASSIS_MK1.tools], cameraModes: [...CHASSIS_MK1.cameraModes] };
    try { u.apply(c, { ramMemory() {} } as never); } catch { /* an upgrade that needs a real rover: not a memory one */ }
    return [c[key]];
  }));

/** M14 (docs/ASSEMBLER_CORE.md §3, §5, §6.1): the processor itself. Numbers from CHASSIS_MK1. */
export function cpuHtml(): string {
  const C = CHASSIS_MK1;
  return `
    <p class="small dim">The CPU only computes and moves data. Everything physical (wheels, radar, tools, camera, radio) is a
    <b>device</b> it talks to through ports (Devices). This is how real microcontrollers work: the processor writes a number
    into a peripheral's register, the peripheral does the work, and the processor checks back later.</p>
    <h4>Registers</h4>
    <p>The Mk-I has ${C.registers} registers, <code>r0</code>–<code>r${C.registers - 1}</code>${regUpgrades()}.
    Each holds a signed 32-bit integer that wraps on overflow. All of them are general purpose: no register has a fixed meaning,
    and any of them can hold a direction, a count, a tile ID or a coordinate (<code>CALL STEP r2 1</code>, <code>JEQ r1 IRON_ORE found</code>).
    <code>ALIAS r0 dir</code> gives a register a name (free, compile time only). Only the ROM's <b>helpers</b> give two of them a role:
    they answer in <code>r0</code> and may change <code>r0</code> and <code>r1</code> (below).
    The firmware and the program each have their own set. A reboot (upload or watchdog) zeroes them; a register the chassis
    does not have is a compile error. When four are not enough, keep numbers in RAM (<code>VAR</code>, Memory map).</p>
    <h4>Cycles and time</h4>
    <table class="radio-kv">
      <tr><td>speed</td><td>Every instruction takes 1 cycle; the Mk-I runs ${C.cyclesPerTick} per tick (CPU overclock upgrades: more). Size never changes speed.</td></tr>
      <tr><td>waiting</td><td><code>WAIT @port</code> sleeps until the port reads 0, checked at the start of every tick. A sleeping CPU uses no energy
        and no cycles: <code>CALL SLEEP 20</code> is <code>MOV @TIMER 20</code> + <code>WAIT @TIMER</code>.</td></tr>
      <tr><td>energy</td><td>Computing is free; devices cost energy (Devices).</td></tr>
    </table>
    <h4>Stacks</h4>
    <table class="radio-kv">
      <tr><td>data stack</td><td>${C.dataStack} numbers per slot. <code>PUSH v</code> / <code>POP dst</code>; <code>CALL name a b</code> pushes <code>a</code>, then <code>b</code>,
        so the routine pops <code>b</code> first (last in, first out). Every routine pops all its arguments. Full or empty: FAULT.</td></tr>
      <tr><td>call stack</td><td>${C.callStack} return addresses per slot: how deep <code>CALL</code>s can nest (a ROM routine counts). <code>RET</code> goes back.</td></tr>
    </table>
    <h4>Calling convention</h4>
    <table class="radio-kv">
      <tr><td>drivers</td><td><code>SLEEP STEP SCAN ACT USE SNAP SEND ERASE RUN</code>: pop their arguments straight into the device's ports, start it and WAIT.
        They change <b>no register</b>; the outcome is in <code>@STATUS</code> (and the device's answer ports).</td></tr>
      <tr><td>helpers</td><td><code>ABS DIR_TO PUT16 GET16 PLOT</code>: answer in <code>r0</code>; may change <code>r0</code> and <code>r1</code> (scratch, like ARM's
        <code>r0</code>–<code>r3</code>) and keep every other register. Keep your own loop counters in <code>r2</code>/<code>r3</code> around them.</td></tr>
      <tr><td>yours</td><td>Your own subroutines may do as they like: say in a comment which registers they change.</td></tr>
    </table>
    <h4>@STATUS</h4>
    <p>Each slot has one <code>@STATUS</code>. Only three things set it: a write to a device's start port (accepted? <code>OK</code>, <code>ERR_BUSY</code>…),
    <code>WAIT</code> on a device port (how the work ended), and <code>DIV</code> / <code>MOD</code> by 0 (<code>ERR_INVALID</code>); also <code>CALL PROGRAM</code>.
    Every other instruction leaves it alone, so check it right after the call.</p>
    <h4>The program as a subroutine</h4>
    <p>The firmware runs the program with <code>CALL PROGRAM</code> (the ROM's <code>CALL RUN ticks</code> sets <code>@SLICE</code> first).
    It starts in the same tick, with its own registers and stacks. It comes back when it <code>END</code>s, <code>RET</code>s at its top level
    (result <code>r0</code>), faults, hits <code>BRK</code>, or when its <code>@SLICE</code> ticks are used up: then the <b>timer interrupt</b> stops it between two
    instructions and the next <code>CALL PROGRAM</code> resumes it there. <code>@PREEMPT</code> lets the firmware be interrupted sooner (fault protection).
    Devices the program started keep running meanwhile.</p>
    <h4>Machine code</h4>
    <p>The listing beside the editor shows it while you type. Opcode byte = instruction number (hex column in Instructions), plus 0x20 per
    optional operand given (<code>LOG 2 r0</code> = <code>39 02 10</code>). The one-byte numbers ran out, so newer instructions
    (the bit instructions) have a 2-byte opcode: the prefix <code>1F</code>, then their own number (<code>AND r0 3</code> =
    <code>1F 01 10 03</code>), like the prefix bytes of real CPUs. One byte longer, just as fast. Operand bytes: <code>00</code>–<code>0F</code> number 0–15,
    <code>10</code>–<code>17</code> register r0–r7, <code>40</code>–<code>7F</code> port (hex column in Ports), <code>18</code> / <code>19</code> / <code>1A</code>
    followed by an 8 / 16 / 32-bit number; <code>1C</code> + 2 bytes <code>[n]</code>, <code>20</code>–<code>27</code> <code>[r]</code>,
    <code>28</code>–<code>2F</code> + 2 bytes <code>[r+n]</code>; a label is its 2-byte address. Each slot starts at address 0x000:
    <code>JLE @BAT 20 home</code> with <code>home</code> at 0x02A = <code>0E 40 18 14 00 2A</code>.</p>`;
}

/** M14 devices (docs/ASSEMBLER_CORE.md §4): one row per device, from its ports and the ROM. */
export const DEVICES: { name: string; start: string; params: string[]; answer: string; rom: string; shares: string; cost: string }[] = [
  { name: 'Timer (one per slot)', start: 'TIMER', params: [], answer: 'reads the ticks left', rom: 'SLEEP', shares: 'none', cost: 'free' },
  { name: 'Drive', start: 'DRIVE', params: ['DRIVE_N'], answer: '<code>@X</code>, <code>@Y</code>; <code>@DRIVE</code> reads the tiles left', rom: 'STEP', shares: 'chassis', cost: '3–6 ticks and 40–120 energy per tile (terrain)' },
  { name: 'Radar', start: 'RADAR', params: [], answer: '<code>@RADAR_HIT</code>, <code>@RADAR_DIST</code>', rom: 'SCAN', shares: 'none: sweeps while the chassis works', cost: `${BALANCE.scanTicks} tick, ${BALANCE.scanEnergy} energy` },
  { name: 'Tools (hardpoints TOOL_0–3)', start: 'TOOL', params: ['TOOL_ARG'], answer: 'cargo, the recorder, <code>@SEISMIC_TYPE</code>, <code>@SEISMIC_DIST</code>', rom: 'ACT', shares: 'chassis', cost: 'per tool (Tools)' },
  { name: 'Field repair', start: 'REPAIR', params: ['REPAIR_SYS'], answer: '<code>@HULL</code>, <code>@SOLAR_HEALTH</code>, <code>@ANTENNA_HEALTH</code>', rom: 'USE', shares: 'chassis', cost: `${TOOLS.USE_ITEM.ticks} ticks, ${TOOLS.USE_ITEM.energy} energy` },
  { name: 'Mast camera', start: 'CAM', params: ['CAM_MODE'], answer: 'image memory (<code>IMG</code>)', rom: 'SNAP', shares: 'chassis; image memory', cost: `${BALANCE.snapTicks} ticks, ${BALANCE.snapEnergy} energy` },
  { name: 'Image send', start: 'SEND', params: [], answer: 'the science recorder (<code>@REC_FREE</code>)', rom: 'SEND', shares: 'image memory', cost: `${BALANCE.sendTicks} tick, ${BALANCE.sendEnergy} energy` },
  { name: 'Image erase', start: 'ERASE', params: [], answer: 'image memory = 0', rom: 'ERASE', shares: 'image memory', cost: `${BALANCE.eraseTicks} ticks, ${BALANCE.eraseEnergy} energy` },
];

export function devicesHtml(): string {
  const port = (n: string) => `<code>@${n}</code>`;
  const rows = DEVICES.map((d) => {
    const args = ROM_ARGS[d.rom as keyof typeof ROM_ARGS].join(' ');
    const params = d.params.length ? ` + ${d.params.map(port).join(', ')}` : '';
    return `<tr><td><b>${d.name}</b></td><td>start ${port(d.start)}${params} · ROM <code>CALL ${d.rom}${args ? ' ' + args : ''}</code><br>
      answer: ${d.answer}<br><span class="dim">shares: ${d.shares} · ${d.cost}</span></td></tr>`;
  }).join('');
  return `
    <p class="small dim">A device does physical work by itself while the CPU goes on. Every device follows the same three steps:</p>
    <table class="radio-kv">
      <tr><td>1. set up</td><td>Write its <b>parameter</b> ports (latched: they keep their value, e.g. <code>MOV @DRIVE_N 3</code>).</td></tr>
      <tr><td>2. start</td><td>Write its <b>start</b> port (<code>MOV @DRIVE EAST</code>). <code>@STATUS</code> says at once whether it was accepted:
        <code>OK</code>, or why not (<code>ERR_BUSY</code>, <code>ERR_LOW_POWER</code>, <code>ERR_INVALID</code>…). Nothing has happened yet.</td></tr>
      <tr><td>3. finish</td><td>Read the start port for the work left (0 = idle), or <code>WAIT @port</code> to sleep until it is done:
        <code>@STATUS</code> then says how it ended. Then read its <b>answer</b> ports.</td></tr>
    </table>
    <p class="small">Each ROM driver is exactly these steps (Reference → ROM). Without the driver the CPU is free in between:
    sweep the radar while driving, compute while the camera exposes (template <i>Drive and scan at once</i>).</p>
    <h4>The devices</h4>
    <table class="radio-kv">${rows}</table>
    <h4>Sharing</h4>
    <table class="radio-kv">
      <tr><td>chassis</td><td>Drive, tools, repair and camera move or hold the rover: only one at a time. Starting another answers <code>ERR_BUSY</code>.</td></tr>
      <tr><td>image memory</td><td>While the camera exposes, <code>@SEND</code> and <code>@ERASE</code> answer <code>ERR_BUSY</code>; one transfer at a time.</td></tr>
      <tr><td>none</td><td>The radar and the timers work alongside anything.</td></tr>
      <tr><td>stop</td><td><code>MOV @DRIVE_N 0</code> while driving stops at the end of the current tile; the drive then ends with <code>ERR_PREEMPTED</code>.</td></tr>
      <tr><td>reboot</td><td>A hard reboot stops every device and puts the parameter ports back to their defaults (<code>@DRIVE_N</code> 1, <code>@CAM_MODE</code> 1…). Actuators (array, dish, lights) are not devices: they keep their state.</td></tr>
    </table>`;
}

/** M14 memory map (docs/ASSEMBLER_CORE.md §7, §9): the data and code address spaces. */
export function memoryMapHtml(): string {
  const C = CHASSIS_MK1;
  const M = MEMORY_MAP;
  const img = imageBytes(C);
  return `
    <p class="small dim">The CPU sees two address spaces, like a Harvard microcontroller: <b>data</b> (read and written by <code>LDB</code> / <code>STB</code>)
    and <b>code</b> (where <code>JMP</code>, <code>CALL</code> and <code>LDF</code> point). An address where nothing answers is a FAULT: "no memory at 0x…".</p>
    <h4>Data addresses (LDB, STB)</h4>
    <table>
      <tr class="dim"><td>addresses</td><td>what</td><td>access</td></tr>
      <tr><td><code>${hex3(M.RAM)}</code>–<code>${hex3(M.RAM + C.ramBytes - 1)}</code></td><td><b>RAM</b> (<code>RAM</code>), Mk-I ${C.ramBytes} B, upgrades up to ${maxOf('ramBytes')} B (to <code>${hex3(M.RAM + maxOf('ramBytes') - 1)}</code>).
        Shared by firmware and program; zero after a reboot (also a firmware upload), kept by program uploads and <i>Run again</i>.</td><td>read / write</td></tr>
      <tr><td><code>${hex3(M.IMG)}</code>–<code>${hex3(M.IMG + img - 1)}</code></td><td><b>image memory</b> (<code>IMG</code>), ${img} B on Mk-I, up to 1024 B with camera upgrades.
        Kept through reboots; a photo overwrites it.</td><td>read / write</td></tr>
      <tr><td><code>${hex3(M.CARGO)}</code>–<code>${hex3(M.CARGO + C.cargoSlots - 1)}</code></td><td><b>cargo</b> (<code>CARGO</code>): one byte per slot, the item's tile ID, 0 = empty.</td><td>read only</td></tr>
      <tr><td>anything else</td><td>nothing</td><td>FAULT</td></tr>
    </table>
    <h4>Addressing modes</h4>
    <table class="radio-kv">
      <tr><td><code>[n]</code></td><td>absolute: a number, a <code>CONST</code> or a <code>VAR</code> name: <code>LDB r0 [count]</code></td></tr>
      <tr><td><code>[r]</code></td><td>register indirect, a pointer: <code>LDB r1 [r2]</code></td></tr>
      <tr><td><code>[r+n]</code></td><td>indexed: <code>STB [IMG+r0] r1</code>, <code>LDF r0 [route+r1]</code></td></tr>
    </table>
    <h4>RAM layout (VAR)</h4>
    <pre class="ref-diagram">${hex3(M.RAM)}  program VARs, from the bottom up ↑
       ...  free ...
${hex3(M.RAM + C.ramBytes - 1)}  firmware VARs, from the top down ↓</pre>
    <p class="small"><code>VAR name [size]</code> reserves bytes (default 1) and makes <code>name</code> their address; it costs no Flash and has no initial value.
    If the two slots' VARs would overlap, the upload is refused with both sizes. Absolute addresses reach all of RAM: both slots can share data (a mailbox)
    or overwrite each other's by mistake. The Code tab shows the RAM each slot uses.</p>
    <h4>Code addresses (JMP, CALL, LDF)</h4>
    <table>
      <tr class="dim"><td>addresses</td><td>what</td></tr>
      <tr><td><code>${hex4(0)}</code>–</td><td>the slot's own <b>Flash</b>: its code, then its <code>DATA</code> section. Each slot starts at 0. Mk-I: ${C.flashBytes} B shared by both slots
        (upgrades up to ${maxOf('flashBytes')} B).</td></tr>
      <tr><td><code>${hex4(PROGRAM_GATE)}</code></td><td>the <b>program gate</b>: <code>CALL PROGRAM</code> (firmware only)</td></tr>
      <tr><td><code>${hex4(ROM_BASE)}</code>–<code>${hex4(ROM_BASE + romBytes() - 1)}</code></td><td><b>ROM</b>, ${romBytes()} B: drivers and helpers (Reference → ROM). <code>LDF</code> can read it.
        Listings and dumps write <code>rom:STEP+3</code>.</td></tr>
    </table>`;
}

/** M14 ROM library (docs/ASSEMBLER_CORE.md §6): its listing, generated from the ROM source. */
function romHtml(): string {
  const listing = listingText(buildListing(ROM_SOURCE, romCompile(), 'firmware', ROM_BASE));
  return `
    <p class="small dim">The ROM holds ready-made subroutines at code address <code>0xF000</code>. Both slots can <code>CALL</code> them;
    they cost no Flash, run with the caller's registers, stacks and <code>@STATUS</code> and take normal cycles. Each driver pops its
    arguments into the device's ports, starts the device and <code>WAIT</code>s until it is done, so <code>@STATUS</code> says how it ended.
    Write the ports yourself to do more: drive and sweep the radar at the same time, stop a drive early (<code>@DRIVE_N 0</code>).
    The <b>helpers</b> (<code>ABS</code>, <code>DIR_TO</code>, <code>PUT16</code>, <code>GET16</code>, <code>PLOT</code>) return their answer in
    <code>r0</code>; they may change <code>r0</code> and <code>r1</code> and keep every other register.
    Routine names are reserved: <code>${ROM_ENTRIES.join(' ')}</code> (and <code>PROGRAM</code>).</p>
    <pre class="ref-diagram">${esc(listing)}</pre>`;
}

function instructionsHtml(): string {
  return grouped(OPCODES as Op[], (o) => o, OP_GROUPS)
    .map(([title, ops]) => `<h4>${title}</h4><table>${ops
      .map((op) => `<tr><td><code>${formatSig(op)}</code></td><td class="dim"><code>${opcodeHex(op)}</code></td><td>${NOTES[op] ?? ''}</td></tr>`)
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
      if (!id) return `<tr><td><code>CALL ACT TOOL_${i} arg</code></td><td>empty hardpoint: <code>ERR_NO_TOOL</code>. With the upgrade: <b>${TOOLS.SEISMIC.name}</b> (<code>CALL ACT TOOL_${i} &lt;dir&gt;</code>): ${esc(TOOLS.SEISMIC.description)} ${cost(TOOLS.SEISMIC)}</td></tr>`;
      const t = TOOLS[id];
      return `<tr><td><code>CALL ACT TOOL_${i} &lt;${t.arg}&gt;</code></td><td><b>${t.name}</b>: ${esc(t.description)} ${cost(t)}</td></tr>`;
    })
    .join('');
  return `
    <h4>Hardpoints (Mk-I)</h4>
    <p class="small dim"><code>CALL ACT TOOL_n arg</code> (ROM) uses the tool mounted in hardpoint n: it writes <code>@TOOL_ARG</code> = arg and
    <code>@TOOL</code> = n, then waits with <code>WAIT @TOOL</code>. Drive, tools, repair and camera share the chassis: one at a time
    (<code>ERR_BUSY</code>).</p>
    <table>${hardpoints}</table>
    <h4>Built-in</h4>
    <table>
      <tr><td><code>CALL SNAP &lt;dir&gt; &lt;mode&gt;</code><br><span class="dim">@CAM_MODE, @CAM</span></td><td><b>${TOOLS.CAMERA.name}</b>: ${esc(TOOLS.CAMERA.description)} ${cost(TOOLS.CAMERA)}</td></tr>
      <tr><td><code>CALL USE &lt;slot&gt; &lt;system&gt;</code><br><span class="dim">@REPAIR_SYS, @REPAIR</span></td><td><b>${TOOLS.USE_ITEM.name}</b>: ${esc(TOOLS.USE_ITEM.description)} ${cost(TOOLS.USE_ITEM)}</td></tr>
    </table>`;
}

const SYS_NAMES = enumEntries(SystemId).reduce<Record<number, string>>((m, [k, v]) => ((m[v] = k), m), {});

function tileNotes(d: TileDef): string {
  const n: string[] = [];
  if (d.moveTicks !== undefined) n.push(`${d.moveTicks} ticks, ${d.moveEnergy ?? 0} energy to enter`);
  if (d.hazardDamage) n.push(`${d.hazardDamage} hull damage`);
  if (d.hazardLevel) n.push(`hazard ${d.hazardLevel}`);
  if (d.blocksMove) n.push('blocks the drive');
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
    <p class="small dim">Every tile name is a constant: <code>@RADAR_HIT</code>, cargo bytes (<code>[CARGO+slot]</code>) and <code>@GROUND</code> hold these IDs; <code>NONE=0</code>.</p>
    ${tiles}
    <h3>Other constants</h3>
    ${consts}
    <h4>Hardpoints (CALL ACT, @TOOL)</h4>${toolSlots}`;
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
    'Image: Line': 'rows, addresses, <code>CALL ERASE</code>',
    'Image: Test pattern': 'grey levels, computing a byte from its address (<code>AND</code>, <code>SHR</code>)',
    'Image: Negative': '<code>CALL SNAP</code> → change → <code>CALL SEND</code>',
    'Image: Stamp': 'numbers as bytes, the ROM\'s <code>PUT16</code>',
    'Image: Plot': 'single pixels with the ROM\'s <code>PLOT</code>, saving a register (<code>PUSH</code> / <code>POP</code>)',
    'Image: Memory map': 'image memory as plain memory (a map of visited tiles), an address from bits',
  };
  const modes = Object.entries(PHOTO_FORMATS)
    .map(([m, f]) => `<tr><td>${m}</td><td>${f.w}×${f.h}</td><td>${8 / f.bpp}</td><td>${(f.w * f.bpp) / 8}</td><td>${photoBytes(Number(m))} B</td><td>${PIXEL_MEANING[f.kind]}</td></tr>`)
    .join('');
  return `
    <p class="small dim">The camera does not send a photo by itself. Taking a picture, changing it and sending it are
    three steps, and your program decides what happens in between. Real rovers work the same way: Curiosity's cameras keep
    their images in their own memory, and only the products made from them go to Earth.</p>
    <pre class="ref-diagram">       SNAP              SEND        downlink
camera ───► image memory ───► recorder ───► Gallery
              ▲     │
          STB │     │ LDB
              └ your program</pre>
    <h4>Instructions and routines</h4>
    <table class="radio-kv">
      <tr><td><code>CALL SNAP dir mode</code></td><td>ROM: photograph into image memory (<code>@CAM_MODE</code>, <code>@CAM</code>) (overwrites all of it). ${B.snapTicks} ticks, ${B.snapEnergy} energy. Nothing is sent yet.</td></tr>
      <tr><td><code>LDB dst [IMG+addr]</code></td><td>Read one byte (0–255) of image memory, which starts at data address <code>IMG</code>. 1 cycle, no energy, no <code>@STATUS</code>.</td></tr>
      <tr><td><code>STB [IMG+addr] v</code></td><td>Write one byte (only the low 8 bits: 256 → 0, −1 → 255). 1 cycle, no energy, no <code>@STATUS</code>.
        An address outside the picture faults.</td></tr>
      <tr><td><code>CALL SEND type</code></td><td>ROM (<code>@SEND</code>): copy image memory into the science recorder as a photo of <code>type</code> (0: the last photo's mode).
        Image memory is kept. ${B.sendTicks} tick, ${B.sendEnergy} energy; <code>ERR_FULL</code>, <code>ERR_INVALID</code>, <code>ERR_LOW_POWER</code>.</td></tr>
      <tr><td><code>CALL ERASE</code></td><td>ROM (<code>@ERASE</code>): set every byte to 0 and forget the last photo. ${B.eraseTicks} ticks, ${B.eraseEnergy} energy.</td></tr>
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
        Only a new photo or <code>CALL ERASE</code> clears it, never <code>CALL SEND</code>.</td></tr>
      <tr><td>bounds</td><td>Stay inside the picture: on Mk-I <code>[IMG+256]</code> and <code>[IMG-1]</code> are outside image memory, and the CPU faults (no wrap-around since M14).</td></tr>
      <tr><td>type</td><td><code>CALL SEND type</code> only says how mission control decodes the bytes: <code>CALL SEND 1</code> shows any bytes as a 32×32 grey photo.</td></tr>
      <tr><td>labels</td><td>The Gallery labels what arrived: <b>raw</b> (sent as the camera took it), <b>edited</b> (changed with <code>STB</code>),
        <b>drawn</b> (no camera picture behind it). The label travels in the header byte (Radio).</td></tr>
      <tr><td>credits</td><td>Only the first send after a photo, of the same type, earns photo credits, edited or not.
        The first lit <b>edited</b> photo in each camera mode earns +${BALANCE.editFirstBonus} more (goal <i>Darkroom</i>). Drawn pictures earn nothing. Anomaly flags are checked against the real tile.</td></tr>
      <tr><td>speed</td><td>Touching every byte costs about 6 cycles each: ~200 ticks for a whole 32×32 picture on Mk-I (${CHASSIS_MK1.cyclesPerTick} cycles per tick). Programs run in time slices, so long loops just take longer.</td></tr>
    </table>
    <h4>Examples (Code tab → Program → template)</h4>
    <table class="radio-kv">
      ${examples.map((n) => `<tr><td>${esc(n.slice(7))}</td><td>${teaches[n] ?? ''}</td></tr>`).join('')}
    </table>`;
}

/** Generated language reference: always in sync with the compiler, port, tool and tile tables. */
export function renderReference(el: HTMLElement, registry: WorldRegistry): void {
  const panes: Record<string, string> = {
    basics: `<h3>Basics</h3>${basicsHtml()}<h3>CPU</h3>${cpuHtml()}<h3>Memory map</h3>${memoryMapHtml()}`,
    instr: instructionsHtml(),
    ports: portsHtml(),
    devices: devicesHtml(),
    tools: toolsHtml(),
    consts: constantsHtml(registry),
    radio: radioHtml(),
    image: imageHtml(),
    rom: romHtml(),
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
