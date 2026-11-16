/**
 * Mission control's view of the radio link (no DOM): what it knows about the uploaded code
 * (tag names, source lines), how received frames read, and which reply answers which
 * request. Shared by the Comms tab, the Code tab's dump box and Reference → Radio.
 */
import { BOOT_REASON_NAMES, decodeDump, decodeFrame, hex, SYSTEM_TAG, type DecodedDump, type ReceivedFrame } from '../core/downlink';
import type { SentKind, SentRecord, SimulationEngine, Slot } from '../core/SimulationEngine';
import { Status } from '../core/types';
import type { Unit } from '../core/Unit';
import { IMG_CHUNK, MSG_TYPE_NAMES, MsgType, SOH, ETX, type ReceivedMessage } from '../core/messages';
import { ERROR_NAMES } from '../core/machine/names';
import { ROM_EXPORTS } from '../core/machine/rom';
import { PDP11 } from '../core/balance';
import { oct6, toolchain, type SlotBuild } from './toolchain';

/** Log tags a slot names: the names and the lines that use them. */
export type LogDictionary = Record<number, { names: string[]; lines: number[] }>;

/** What mission control knows about one uploaded slot: its log tags and where its instructions are. */
export interface SlotDictionary {
  tags: LogDictionary;
  /** Source line of the instruction at a byte address (0 if none). */
  lineAt: (addr: number) => number;
}

export type Dictionaries = Record<Slot, SlotDictionary>;

export const emptyDictionary = (): SlotDictionary => ({ tags: {}, lineAt: () => 0 });

/**
 * Dictionary of an assembled slot. Log tags are the `L.` symbols it defines
 * (`L.BAT = 1`); their lines are the lines that use the name, the definition excluded.
 */
export function slotDictionary(b: SlotBuild): SlotDictionary {
  const tags: LogDictionary = {};
  const asm = b.pdp.asm;
  {
    const lines = (b.pdp.image?.source ?? '').split('\n').map((l) => l.replace(/;.*$/, ''));
    for (const [name, v] of asm.symbols) {
      if (!name.startsWith('L.') || asm.labels.has(name)) continue;
      const re = new RegExp(`(^|[^A-Z0-9.$])${name.replace(/[.$]/g, '\\$&')}(?![A-Z0-9.$])`, 'i');
      const def = new RegExp(`^\\s*${name.replace(/[.$]/g, '\\$&')}\\s*=`, 'i');
      const used = lines.flatMap((l, i) => (re.test(l) && !def.test(l) ? [i + 1] : []));
      const t = (tags[v & 0xff] ??= { names: [], lines: [] });
      t.names.push(name);
      t.lines.push(...used);
    }
  }
  return { tags, lineAt: b.lineAt };
}

const ROM_SORTED = Object.entries(ROM_EXPORTS).sort((a, b) => b[1] - a[1]);
/** The ROM routine an address lies in (`STEP`), or '' outside the ROM's routines. */
export function romRoutineAt(addr: number): string {
  if (addr < PDP11.romBase || addr >= PDP11.ioBase) return '';
  return ROM_SORTED.find(([, a]) => a <= addr)?.[0] ?? '';
}

/** An address as mission control writes it: octal, `002052`. */
export const dictAddr = (addr: number): string => oct6(addr);

/**
 * Name of a log tag from both slots' CONSTs (SPEC §3.9.3): names of one slot joined by
 * '/', a tag both slots name differently shows both (`T_BAT|T_X`). Lines say their slot.
 */
export function tagName(tag: number, d: Dictionaries): { name: string; lines: string } {
  const fw = d.firmware.tags[tag];
  const pr = d.program.tags[tag];
  const fwName = fw?.names.join('/') ?? '';
  const prName = pr?.names.join('/') ?? '';
  const name = fwName && prName && fwName !== prName ? `${fwName}|${prName}` : fwName || prName || `tag ${tag}`;
  const refs = [...(fw?.lines ?? []).map((l) => `fw L${l}`), ...(pr?.lines ?? []).map((l) => `prog L${l}`)];
  return { name, lines: refs.length ? ` (${refs.join(', ')})` : '' };
}

/** Where a log tag is logged: `fw L55` plus a readable tooltip. */
export function tagSource(tag: number, d: Dictionaries): { short: string; long: string } {
  const parts: string[] = [];
  const long: string[] = [];
  for (const slot of ['firmware', 'program'] as const) {
    const lines = d[slot].tags[tag]?.lines ?? [];
    if (!lines.length) continue;
    parts.push(`${slot === 'firmware' ? 'fw' : 'prog'} L${lines.join(',')}`);
    long.push(`${slot} line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`);
  }
  return { short: parts.join(' · '), long: long.length ? `Sent by LOG in the ${long.join(' and the ')}` : 'No LOG with this tag in the uploaded code' };
}

/** `002052 (L13)`: a byte address in a slot, with its source line if mission control knows it. */
export function addrText(addr: number, slot: Slot, d: Dictionaries): string {
  const line = d[slot].lineAt(addr);
  return `${dictAddr(addr)}${line ? ` (L${line})` : ''}`;
}

export function describeDump(dump: DecodedDump, taken: number | undefined, d: Dictionaries): string {
  const at = `snapshot t${taken ?? '?'}`;
  const who = dump.slot === 'program' ? 'PROGRAM' : 'FIRMWARE';
  if (dump.kind === 'regs') {
    const regs = dump.r.slice(0, 6).map((v, i) => `R${i}=${oct6(v)}`).join(' ');
    return `${who} DUMP (${at}): PC ${addrText(dump.r[7], dump.slot, d)} · ${dump.state} · PSW ${oct6(dump.psw)} ${psWFlags(dump.psw)} · ${regs} SP=${oct6(dump.r[6])}`;
  }
  const words = dump.words.length ? `[${dump.words.map(oct6).join(' ')}]` : '(empty)';
  return `${who} STACK (${at}): SP ${oct6(dump.sp)} · ${words}`;
}

/**
 * Decoded text of a received frame, like a defmt / spacecraft-EVR dictionary: tags are
 * named from the `L.` symbols the uploaded code defines (SPEC §3.8.3, §3.9.3).
 */
export function describeFrame(f: ReceivedFrame, d: Dictionaries): string {
  const dump = decodeDump(f.bytes);
  if (dump) return describeDump(dump, f.taken, d);
  const fr = decodeFrame(f.bytes);
  if (fr.kind === 1) return `science (type ${fr.tag})`;
  if (fr.tag === SYSTEM_TAG) {
    if (fr.value !== null && BOOT_REASON_NAMES[fr.value]) return `BOOT: ${BOOT_REASON_NAMES[fr.value]}`;
    return `SYSTEM${fr.value === null ? '' : ` = ${fr.value}`}`;
  }
  const { name, lines } = tagName(fr.tag, d);
  return `${name}${fr.value === null ? '' : ` = ${fr.value}`}${lines}`;
}

/** Mission control's dictionaries for the code on the rover, recompiled only when it changes. */
export class DictionaryCache {
  private key = '\u0000';
  private dicts: Dictionaries = { firmware: emptyDictionary(), program: emptyDictionary() };

  constructor(private engine: SimulationEngine) {}

  /** Returns the dictionaries and whether they changed since the last call. */
  get(u: Unit): { d: Dictionaries; changed: boolean } {
    const key = `${u.sourceCode}\u0000${u.programSource}`;
    if (key === this.key) return { d: this.dicts, changed: false };
    this.key = key;
    const tc = toolchain(this.engine);
    this.dicts = {
      firmware: slotDictionary(tc.build(u, u.sourceCode, 'firmware')),
      program: u.programSource ? slotDictionary(tc.build(u, u.programSource, 'program')) : emptyDictionary(),
    };
    return { d: this.dicts, changed: true };
  }
}

// ---------------------------------------------------------------- snapshots (memory dumps)

/** What a snapshot request asks the rover to copy. */
export type SnapKind = 'regs' | 'stack';

export const snapKindOf = (k: SentKind): SnapKind | null => (k === 'DUMP' ? 'regs' : k === 'DUMP_STACKS' ? 'stack' : null);

const dumpSnapKind = (d: DecodedDump): SnapKind => d.kind;

/** `NZvc`: PSW condition codes, capitals for the ones set. */
export const psWFlags = (psw: number): string => ['N', 'Z', 'V', 'C'].map((f, i) => (psw & (8 >> i) ? f : f.toLowerCase())).join('');

/** A snapshot reply as mission control holds it. */
export interface Snapshot {
  frame: ReceivedFrame;
  dump: DecodedDump;
  /** Tick the rover copied the values (= when the request arrived). */
  taken: number;
}

/**
 * The reply to a snapshot request: the dump frame of the same rover, slot and kind whose
 * copy was taken in the tick the request was sent (the rover copies on arrival).
 */
export function replyTo(r: SentRecord, received: readonly ReceivedFrame[]): Snapshot | null {
  const want = snapKindOf(r.kind);
  if (!want || r.rejected) return null;
  for (const f of received) {
    if (f.unitId !== r.unitId || f.taken !== r.tick) continue;
    const dump = decodeDump(f.bytes);
    if (dump && dump.slot === r.slot && dumpSnapKind(dump) === want) return { frame: f, dump, taken: f.taken };
  }
  return null;
}

/** The newest snapshot of one kind received from a rover's slot. */
export function latestSnapshot(received: readonly ReceivedFrame[], unitId: number, slot: Slot, kind: SnapKind): Snapshot | null {
  for (let i = received.length - 1; i >= 0; i--) {
    const f = received[i];
    if (f.unitId !== unitId) continue;
    const dump = decodeDump(f.bytes);
    if (dump && dump.slot === slot && dumpSnapKind(dump) === kind) return { frame: f, dump, taken: f.taken ?? f.tick };
  }
  return null;
}

/** Snapshot requests still waiting for their copy to come down (oldest first). */
export function pendingRequests(sent: readonly SentRecord[], received: readonly ReceivedFrame[], unitId: number, slot: Slot, kind: SnapKind): SentRecord[] {
  const out: SentRecord[] = [];
  for (const r of sent) {
    if (r.unitId !== unitId || r.slot !== slot || snapKindOf(r.kind) !== kind || r.rejected) continue;
    if (!replyTo(r, received)) out.push(r);
  }
  return out;
}

/**
 * True if new code was uploaded into the snapshot's slot after the copy was taken: its
 * addresses then point into the old code. Within one tick the sent order decides.
 */
export function snapshotOutdated(s: Snapshot, sent: readonly SentRecord[], unitId: number): boolean {
  const upload: SentKind = s.dump.slot === 'program' ? 'PROGRAM' : 'FIRMWARE';
  const kind = dumpSnapKind(s.dump);
  const req = sent.findIndex((r) => r.unitId === unitId && !r.rejected && r.tick === s.taken && r.slot === s.dump.slot && snapKindOf(r.kind) === kind);
  return sent.some((r, i) => r.unitId === unitId && !r.rejected && r.kind === upload && (r.tick > s.taken || (r.tick === s.taken && i > req)));
}

// ---------------------------------------------------------------- wording

export const SLOT_WORD: Record<Slot, string> = { program: 'program', firmware: 'firmware' };

/** Player-facing name of a sent record (the word "dump" only appears in help texts). */
export function sentText(r: SentRecord): string {
  const s = SLOT_WORD[r.slot];
  switch (r.kind) {
    case 'DUMP':
      return `Dump the ${s}'s registers`;
    case 'DUMP_STACKS':
      return `Dump the ${s}'s stack`;
    case 'CONTINUE':
      return `Resume the ${s} after a breakpoint`;
    case 'RUN_AGAIN':
      return 'Restart the program from its first line';
    case 'PROGRAM':
      return r.bytes ? `Program uploaded (${r.bytes} B)` : 'Program erased';
    case 'FIRMWARE':
      return `Firmware uploaded (${r.bytes ?? 0} B): the rover reboots`;
  }
}

export const costText = (cost: number): string => (cost ? `${(cost / 1000).toFixed(1)}% battery` : 'free');

// ---------------------------------------------------------------- byte by byte (Comms "Decode bytes", Reference → Radio)

/** One field of a received frame: its bytes as they arrived, what it is, its value and a short comment. */
export interface FrameField {
  bytes: number[];
  name: string;
  value: string;
  note: string;
  /** A source line this value points at (Comms: click to show it in the Code tab). */
  goto?: { slot: Slot; line: number };
}

/** What each dumped state means, for the comment next to it (item: value-specific comments). */
export const STATE_NOTES: Record<string, string> = {
  PROG_NONE: 'not running: no program started, or it finished and the firmware acknowledged it',
  PROG_READY: 'waiting for its next run (the gate: RUN or PRGCS); continues at PC',
  PROG_RUNNING: 'running right now',
  PROG_DONE: 'finished with HALT (result in R0); the firmware has not acknowledged it yet',
  PROG_FAULT: 'crashed; the firmware took over',
  PROG_HALTED: 'stopped by BPT; ▶ Resume continues after it',
  RUNNING: 'running',
  BLOCKED: 'asleep in WAIT until an interrupt',
  HALTED: 'stopped by HALT or BPT; ▶ Resume continues after it',
  FAULT: 'crashed (a double fault); the watchdog reboots it',
};

/** What each error code (E.…, a device's `xxER`) says. */
export const STATUS_NOTES: Record<number, string> = {
  [Status.OK]: 'accepted, or the device finished its work',
  [Status.ERR_INVALID]: 'bad argument or nothing usable there (bad direction or slot…)',
  [Status.ERR_FULL]: 'no room: cargo, recorder or log queue full',
  [Status.ERR_LOW_POWER]: 'not enough battery for it',
  [Status.ERR_BLOCKED]: 'the drive hit an obstacle',
  [Status.ERR_NO_TOOL]: 'no tool in that hardpoint',
  [Status.ERR_NO_SIGNAL]: 'the dish does not reach the orbiter',
  [Status.ERR_HAZARD]: 'the drive moved onto a hazard',
  [Status.ERR_DEPLOYED]: 'the drive refused: the solar array is open',
  [Status.ERR_PREEMPTED]: 'stopped by a command before it finished (a drive stopped with DRVCNT 0)',
  [Status.ERR_BUSY]: 'the device (or one it shares the chassis with) is still working',
};

/** False for a program that is not running (finished or never started): its "next" means nothing. */
export const dumpRunning = (state: string): boolean => state !== 'PROG_NONE' && state !== 'PROG_DONE';
/** Stopped at a breakpoint (BPT, or a firmware HALT). */
export const dumpHalted = (state: string): boolean => state === 'HALTED' || state === 'PROG_HALTED';

/** Bytes on the air of a register dump. */
export const REGISTER_DUMP_BYTES = 22;
/** Smallest stack dump (no words); each word adds 2 B. */
export const STACK_DUMP_MIN_BYTES = 6;

/**
 * The request a received dump answers, if mission control asked for it. A register dump
 * nobody asked for while the slot is halted was sent by a breakpoint.
 */
export function requestFor(f: ReceivedFrame, sent: readonly SentRecord[]): SentRecord | undefined {
  const dump = decodeDump(f.bytes);
  if (!dump || f.taken === undefined) return undefined;
  const kind = dumpSnapKind(dump);
  return sent.find((r) => r.unitId === f.unitId && !r.rejected && r.tick === f.taken && r.slot === dump.slot && snapKindOf(r.kind) === kind);
}

export function sentByBreakpoint(f: ReceivedFrame, sent: readonly SentRecord[]): boolean {
  const dump = decodeDump(f.bytes);
  return !!dump && dump.kind === 'regs' && dumpHalted(dump.state) && !requestFor(f, sent);
}

const SIZE_OF_CODE = [0, 1, 2, 4];
const bits = (b: number) => `${b >> 7}|${((b >> 3) & 15).toString(2).padStart(4, '0')}|${((b >> 1) & 3).toString(2).padStart(2, '0')}|${b & 1}`;
const DUMP_KIND_TEXT: Record<number, string> = {
  5: 'firmware registers',
  6: 'firmware stack',
  7: 'program registers',
  8: 'program stack',
};

/** `prog:0x026 → line 18` */
function addrValue(addr: number, slot: Slot, d: Dictionaries): string {
  const line = d[slot].lineAt(addr);
  return `${dictAddr(addr)}${line ? ` → line ${line}` : ''}`;
}

/**
 * Every byte of a received frame, explained (SPEC §3.8.3, §3.8.4): LOG and system
 * messages, register and stack dumps. The fields' bytes joined are exactly the frame.
 */
export function frameFields(b: readonly number[], d: Dictionaries): FrameField[] {
  const out: FrameField[] = [];
  const take = (at: number, n: number) => b.slice(at, at + n) as number[];
  const be = (at: number, n: number, signed: boolean) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + (b[at + i] ?? 0);
    if (signed && v >= 2 ** (8 * n - 1)) v -= 2 ** (8 * n);
    return v;
  };
  const dump = decodeDump(b);
  if (dump) {
    const slot = dump.slot;
    out.push({ bytes: take(0, 1), name: 'header', value: 'dump', note: `bits ${bits(b[0])}: system frame (tag 15) with a length byte` });
    out.push({ bytes: take(1, 1), name: 'kind', value: DUMP_KIND_TEXT[b[1]] ?? `kind ${b[1]}`, note: '5/6 firmware, 7/8 program; odd = registers, even = stack' });
    out.push({ bytes: take(2, 1), name: 'length', value: `${b[2]} bytes follow`, note: '' });
    if (dump.kind === 'regs') {
      const prog = slot === 'program';
      const running = dumpRunning(dump.state);
      out.push({ bytes: take(3, 1), name: 'state', value: dump.state, note: `${prog ? 'PRGST' : 'CPU'}: ${STATE_NOTES[dump.state] ?? '?'}` });
      out.push({ bytes: take(4, 2), name: 'PSW', value: `${oct6(dump.psw)} ${psWFlags(dump.psw)}`, note: `words low byte first · priority ${(dump.psw >> 5) & 7}, ${((dump.psw >> 14) & 3) === 3 ? 'user' : 'kernel'} mode; flags N Z V C (capital = set)` });
      dump.r.forEach((v, i) => {
        const name = i === 6 ? 'SP' : i === 7 ? 'PC' : `R${i}`;
        if (i === 7) {
          const line = d[slot].lineAt(v);
          const bptLine = dumpHalted(dump.state) ? d[slot].lineAt(v - 2) : 0; // BPT is one word
          out.push({
            bytes: take(6 + i * 2, 2),
            name,
            value: running ? addrValue(v, slot, d) : `${oct6(v)} (not running)`,
            note: !running
              ? 'means nothing while the program is not running'
              : bptLine
                ? `the instruction after the BPT on line ${bptLine}`
                : v >= PDP11.romBase && v < PDP11.ioBase
                  ? `in the ROM${romRoutineAt(v) ? `, routine ${romRoutineAt(v)}` : ''} (called from your code: Dump stack shows the return address)`
                  : 'address of the instruction it runs next',
            goto: running && line ? { slot, line } : undefined,
          });
        } else out.push({ bytes: take(6 + i * 2, 2), name, value: oct6(v), note: `${((v ^ 0x8000) - 0x8000)}.${i === 6 ? ' · the stack pointer (Dump stack shows the words)' : ''}` });
      });
      return out;
    }
    {
      out.push({ bytes: take(3, 2), name: 'SP', value: oct6(dump.sp), note: 'the stack pointer: the top of the stack (it grows down)' });
      out.push({ bytes: take(5, 1), name: 'words', value: `${dump.words.length} follow`, note: `from SP up, at most 8 (the stack ends at ${slot === 'program' ? 'the top of core' : 'the program base, 002000'})` });
      dump.words.forEach((w, i) => {
        const line = w >= 0o200 && w < 0o160000 ? d[slot].lineAt(w - 4) || d[slot].lineAt(w - 2) : 0;
        out.push({
          bytes: take(6 + i * 2, 2),
          name: oct6(dump.sp + i * 2),
          value: oct6(w),
          note: i === 0 ? 'top: the next (SP)+ gets this' : line ? `a return address? after the JSR on line ${line}` : '',
          goto: line ? { slot, line } : undefined,
        });
      });
      return out;
    }
  }
  const h = b[0] ?? 0;
  const tag = (h >> 3) & 15;
  const n = SIZE_OF_CODE[(h >> 1) & 3];
  const sys = tag === SYSTEM_TAG;
  const what = sys ? 'system message (tag 15)' : `LOG tag ${tag} ${tagName(tag, d).name}`;
  out.push({ bytes: take(0, 1), name: 'header', value: `${what}${n ? `, ${n}-byte value` : ', no value'}`, note: `bits ${bits(h)}: log, tag, value size (0/1/2/4 B)` });
  if (n) {
    const v = be(1, n, true);
    const boot = sys ? BOOT_REASON_NAMES[v] : undefined;
    out.push({ bytes: take(1, n), name: 'value', value: boot ? `${v} = rebooted: ${boot}` : String(v), note: sys ? 'boot reason' : n > 1 ? 'signed, high byte first' : 'signed' });
  }
  return out;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * Fields as a table: bytes | name | value ; comment (Comms, Reference → Radio).
 * `seenHeaders` (Comms): a header comment is shown only on the first row that explains
 * that header layout; later rows of the list leave it out (the bits differ, the
 * explanation does not).
 */
export function fieldsHtml(fields: readonly FrameField[], seenHeaders?: Set<string>, links = false): string {
  const rows = fields
    .map((f) => {
      if (!seenHeaders || f.name !== 'header' || !f.note) return f;
      const key = f.note.replace(/^bits [01|]+: /, '');
      if (seenHeaders.has(key)) return { ...f, note: '' };
      seenHeaders.add(key);
      return f;
    })
    .map((f) => {
      const v = links && f.goto
        ? `<button class="link" data-goto="${f.goto.slot}:${f.goto.line}" title="Show line ${f.goto.line} of the ${f.goto.slot} in the Code tab">${escHtml(f.value)}</button>`
        : `<span class="v">${escHtml(f.value)}</span>`;
      return `<tr><td class="fb">${hex(f.bytes)}</td><td class="fn">${escHtml(f.name)}</td><td class="fv">${v}${f.note ? ` <span class="fc">; ${escHtml(f.note)}</span>` : ''}</td></tr>`;
    })
    .join('');
  return `<table class="frame-fields">${rows}</table>`;
}

// ---------------------------------------------------------------- framed messages (TX / recorder)

const ERROR_BY_CODE: Record<number, string> = Object.fromEntries(Object.entries(ERROR_NAMES).map(([n, v]) => [v, n]));
const word = (b: readonly number[], at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const sword = (v: number): number => ((v & 0xffff) ^ 0x8000) - 0x8000;
const printable = (c: number): string => (c >= 32 && c < 127 ? String.fromCharCode(c) : c === 10 ? '⏎' : `\\${c.toString(8).padStart(3, '0')}`);

/** Name of a message type: `log`, `text`, or the number for the player's own (100–377). */
export const msgTypeName = (t: number | null): string => (t === null ? 'stray bytes' : (MSG_TYPE_NAMES[t] ?? `type ${t.toString(8).padStart(3, '0')}`));

/** A received message in one line, named from the dictionaries (`L.BAT = 87`). */
export function describeMessage(m: ReceivedMessage, d: Dictionaries): string {
  const b = m.body;
  const cut = m.status === 'incomplete' ? ' (incomplete: cut off by a reboot)' : m.status === 'broken' ? ' (broken: bytes were lost)' : '';
  switch (m.type) {
    case MsgType.TEXT:
      return `“${b.map(printable).join('')}”${cut}`;
    case MsgType.LOG: {
      const { name } = tagName(b[0] ?? 0, d);
      return b.length >= 3 ? `${name} = ${sword(word(b, 1))}${cut}` : `${name}${cut}`;
    }
    case MsgType.ERR: {
      const code = b[0] ?? 0;
      const at = b.length >= 3 ? ` at ${oct6(word(b, 1))}` : '';
      return `error ${ERROR_BY_CODE[code] ?? code}${at}${cut}`;
    }
    case MsgType.IMG:
      return `photo chunk ${(b[1] ?? 0) + 1}/${b[2] ?? '?'} (${Math.max(0, b.length - 3)} B)${cut}`;
    default:
      return `${msgTypeName(m.type)}: ${hex(b) || '(empty)'}${cut}`;
  }
}

/**
 * Every byte of a message as it went down: SOH, type, length, the body by type, ETX. A
 * broken or incomplete message shows what arrived.
 */
export function messageFields(m: ReceivedMessage, d: Dictionaries): FrameField[] {
  const b = m.body;
  const out: FrameField[] = [];
  if (m.type === null) return [{ bytes: b, name: 'stray', value: `${b.length} B`, note: 'bytes outside any message (its start was lost)' }];
  out.push({ bytes: [SOH], name: 'SOH', value: 'start', note: 'start of a message (001)' });
  out.push({ bytes: [m.type], name: 'type', value: msgTypeName(m.type), note: m.type >= 0o100 ? 'one of your own types (100–377)' : 'types 000–077 are the system\'s' });
  out.push({ bytes: [b.length & 255], name: 'length', value: `${b.length} B${m.status === 'ok' ? '' : ' arrived'}`, note: '' });
  if (m.type === MsgType.LOG && b.length >= 3) {
    const tag = b[0];
    const src = tagSource(tag, d);
    const fw = d.firmware.tags[tag]?.lines[0];
    const pr = d.program.tags[tag]?.lines[0];
    const goto = pr ? { slot: 'program' as Slot, line: pr } : fw ? { slot: 'firmware' as Slot, line: fw } : undefined;
    out.push({ bytes: [tag], name: 'tag', value: `${tag} ${tagName(tag, d).name}`, note: src.short, goto });
    out.push({ bytes: b.slice(1, 3), name: 'value', value: String(sword(word(b, 1))), note: `low byte first · ${oct6(word(b, 1))} octal` });
    if (b.length > 3) out.push({ bytes: b.slice(3), name: 'extra', value: `${b.length - 3} B`, note: 'more than a LOG message carries' });
  } else if (m.type === MsgType.ERR && b.length) {
    out.push({ bytes: [b[0]], name: 'code', value: ERROR_BY_CODE[b[0]] ?? String(b[0]), note: STATUS_NOTES[b[0]] ?? '' });
    if (b.length >= 3) {
      const a = word(b, 1);
      const line = d.program.lineAt(a) || d.firmware.lineAt(a);
      const slot: Slot = d.program.lineAt(a) ? 'program' : 'firmware';
      out.push({ bytes: b.slice(1, 3), name: 'address', value: oct6(a), note: line ? `line ${line} of the ${slot}` : 'where it happened', goto: line ? { slot, line } : undefined });
    }
    if (b.length > 3) out.push({ bytes: b.slice(3), name: 'more', value: `${b.length - 3} B`, note: '' });
  } else if (m.type === MsgType.TEXT) {
    for (let i = 0; i < b.length; i += 16) out.push({ bytes: b.slice(i, i + 16), name: i ? '' : 'text', value: b.slice(i, i + 16).map(printable).join(''), note: '' });
  } else if (m.type === MsgType.IMG && b.length >= 3) {
    out.push({ bytes: b.slice(0, 3), name: 'chunk', value: `${b[1] + 1} of ${b[2]} · photo type ${b[0]}`, note: `then up to ${IMG_CHUNK} pixel bytes; ground puts the photo back together` });
    if (b.length > 3) out.push({ bytes: b.slice(3), name: 'pixels', value: `${b.length - 3} B`, note: '' });
  } else if (b.length) {
    for (let i = 0; i < b.length; i += 16) out.push({ bytes: b.slice(i, i + 16), name: i ? '' : 'body', value: `${Math.min(16, b.length - i)} B`, note: '' });
  }
  if (m.status === 'ok') out.push({ bytes: [ETX], name: 'ETX', value: 'end', note: 'the length matched and the end code followed (003)' });
  else out.push({ bytes: [], name: m.status, value: m.status === 'incomplete' ? 'cut off by a reboot' : 'length and end code do not match', note: m.status === 'broken' ? 'bytes were lost: the TX FIFO was full (TXLOST counts them)' : '' });
  return out;
}
