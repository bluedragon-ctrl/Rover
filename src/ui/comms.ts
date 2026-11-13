/**
 * Mission control's view of the radio link (no DOM): what it knows about the uploaded code
 * (tag names, source lines), how received frames read, and which reply answers which
 * request. Shared by the Comms tab, the Code tab's dump box and Reference → Radio.
 */
import { BOOT_REASON_NAMES, decodeDump, decodeFrame, hex, SYSTEM_TAG, type DecodedDump, type ReceivedFrame } from '../core/downlink';
import type { SentKind, SentRecord, SimulationEngine } from '../core/SimulationEngine';
import { Status } from '../core/types';
import type { Unit } from '../core/Unit';
import type { CompileResult, Slot } from '../core/vm/Compiler';
import { formatAddr } from '../core/vm/isa';

export type LogDictionary = CompileResult['logTags'];

/** What mission control knows about one uploaded slot: its log tags and where its instructions are. */
export interface SlotDictionary {
  tags: LogDictionary;
  /** `ALIAS` names per register number. */
  regs: Record<number, string[]>;
  /** Source line of the instruction at a byte address (0 if none). */
  lineAt: (addr: number) => number;
}

export type Dictionaries = Record<Slot, SlotDictionary>;

export const emptyDictionary = (): SlotDictionary => ({ tags: {}, regs: {}, lineAt: () => 0 });

/** Dictionary of a compiled slot. */
export function slotDictionary(res: CompileResult): SlotDictionary {
  const p = res.program;
  return {
    tags: res.logTags,
    regs: res.regNames ?? {},
    lineAt: (addr) => {
      const k = p?.indexAt.get(addr);
      return k === undefined ? 0 : p!.instrs[k].line;
    },
  };
}

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

/** `fw:0x02A (L13)`: a byte address in a slot, with its source line if mission control knows it. */
export function addrText(addr: number, slot: Slot, d: Dictionaries): string {
  const line = d[slot].lineAt(addr);
  return `${formatAddr(addr, slot)}${line ? ` (L${line})` : ''}`;
}

export function describeDump(dump: DecodedDump, taken: number | undefined, d: Dictionaries): string {
  const at = `snapshot t${taken ?? '?'}`;
  const who = dump.slot === 'program' ? 'PROGRAM' : 'FIRMWARE';
  if (dump.kind === 1) {
    const regs = dump.regs.map((v, i) => `r${i}=${v}`).join(' ');
    return `${who} DUMP (${at}): next ${addrText(dump.ip, dump.slot, d)} · ${dump.state} · @STATUS ${Status[dump.status] ?? dump.status} · ${regs} · stacks ${dump.dsDepth}/${dump.csDepth}`;
  }
  const ds = dump.dataStack.length ? `[${dump.dataStack.join(' ')}]` : '(empty)';
  const cs = dump.callStack.length ? `[${dump.callStack.map((a) => addrText(a, dump.slot, d)).join(' ')}]` : '(empty)';
  return `${who} STACKS (${at}): data ${ds} · return to ${cs}`;
}

/**
 * Decoded text of a received frame, like a defmt / spacecraft-EVR dictionary: tags are
 * named from the CONSTs the uploaded code logged them with (SPEC §3.8.3, §3.9.3).
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
    this.dicts = {
      firmware: slotDictionary(this.engine.compileFor(u, u.sourceCode, 'firmware')),
      program: u.programSource ? slotDictionary(this.engine.compileFor(u, u.programSource, 'program')) : emptyDictionary(),
    };
    return { d: this.dicts, changed: true };
  }
}

// ---------------------------------------------------------------- snapshots (memory dumps)

/** What a snapshot request asks the rover to copy. */
export type SnapKind = 'regs' | 'stacks';

export const snapKindOf = (k: SentKind): SnapKind | null => (k === 'DUMP' ? 'regs' : k === 'DUMP_STACKS' ? 'stacks' : null);

const dumpSnapKind = (d: DecodedDump): SnapKind => (d.kind === 1 ? 'regs' : 'stacks');

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
      return `Dump the ${s}'s stacks`;
    case 'CONTINUE':
      return `Resume the ${s} after BRK`;
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
  PROG_READY: 'waiting for its next time slice (RUN); continues at "next"',
  PROG_RUNNING: 'running in a time slice right now',
  PROG_DONE: 'finished with END; the firmware has not acknowledged it yet',
  PROG_FAULT: 'crashed; the firmware took over',
  PROG_HALTED: 'stopped by BRK; ▶ Resume after BRK continues at "next"',
  RUNNING: 'running',
  BLOCKED: 'waiting: for a hardware instruction (STEP, SLEEP…) to finish, or in RUN while the program has its slice',
  HALTED: 'stopped by BRK; ▶ Resume after BRK continues at "next"',
  FAULT: 'crashed; the watchdog reboots it',
};

/** What each @STATUS value says about the last instruction that set it. */
export const STATUS_NOTES: Record<number, string> = {
  [Status.OK]: 'the last hardware instruction worked',
  [Status.ERR_INVALID]: 'bad argument or nothing usable there (bad direction or slot, DIV by 0…)',
  [Status.ERR_FULL]: 'no room: cargo, recorder or log queue full',
  [Status.ERR_LOW_POWER]: 'not enough battery for it',
  [Status.ERR_BLOCKED]: 'STEP hit an obstacle',
  [Status.ERR_NO_TOOL]: 'no tool in that hardpoint',
  [Status.ERR_NO_SIGNAL]: 'the dish does not reach the orbiter',
  [Status.ERR_HAZARD]: 'STEP moved onto a hazard',
  [Status.ERR_DEPLOYED]: 'STEP refused: the solar array is open',
};

/** False for a program that is not running (finished or never started): its "next" means nothing. */
export const dumpRunning = (state: string): boolean => state !== 'PROG_NONE' && state !== 'PROG_DONE';
/** Stopped by BRK (only BRK halts a CPU). */
export const dumpHalted = (state: string): boolean => state === 'HALTED' || state === 'PROG_HALTED';

/** Bytes on the air of a register dump for a chassis with `registers` registers. */
export const registerDumpBytes = (registers: number): number => 9 + 4 * registers;
/** Smallest stack dump (both stacks empty); each value adds 4 B, each return 2 B. */
export const STACK_DUMP_MIN_BYTES = 5;

/**
 * The request a received dump answers, if mission control asked for it. A register dump
 * nobody asked for while the slot is halted was sent by BRK.
 */
export function requestFor(f: ReceivedFrame, sent: readonly SentRecord[]): SentRecord | undefined {
  const dump = decodeDump(f.bytes);
  if (!dump || f.taken === undefined) return undefined;
  const kind = dumpSnapKind(dump);
  return sent.find((r) => r.unitId === f.unitId && !r.rejected && r.tick === f.taken && r.slot === dump.slot && snapKindOf(r.kind) === kind);
}

export function sentByBrk(f: ReceivedFrame, sent: readonly SentRecord[]): boolean {
  const dump = decodeDump(f.bytes);
  return !!dump && dump.kind === 1 && dumpHalted(dump.state) && !requestFor(f, sent);
}

const SIZE_OF_CODE = [0, 1, 2, 4];
const bits = (b: number) => `${b >> 7}|${((b >> 3) & 15).toString(2).padStart(4, '0')}|${((b >> 1) & 3).toString(2).padStart(2, '0')}|${b & 1}`;
const DUMP_KIND_TEXT: Record<number, string> = { 1: 'firmware registers', 2: 'firmware stacks', 3: 'program registers', 4: 'program stacks' };

/** `prog:0x026 → line 18` */
function addrValue(addr: number, slot: Slot, d: Dictionaries): string {
  const line = d[slot].lineAt(addr);
  return `${formatAddr(addr, slot)}${line ? ` → line ${line}` : ''}`;
}

/** Register name with its ALIASes: `r1 seen`. */
export function regLabel(i: number, slot: Slot, d: Dictionaries): string {
  const names = d[slot].regs[i];
  return names?.length ? `r${i} ${names.join('/')}` : `r${i}`;
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
    out.push({ bytes: take(1, 1), name: 'kind', value: DUMP_KIND_TEXT[b[1]] ?? `kind ${b[1]}`, note: '1/2 firmware, 3/4 program; odd = registers, even = stacks' });
    out.push({ bytes: take(2, 1), name: 'length', value: `${b[2]} bytes follow`, note: '' });
    if (dump.kind === 1) {
      const prog = slot === 'program';
      const running = dumpRunning(dump.state);
      const line = d[slot].lineAt(dump.ip);
      const brkLine = dumpHalted(dump.state) ? d[slot].lineAt(dump.ip - 1) : 0; // BRK is 1 byte
      out.push({
        bytes: take(3, 2),
        name: 'next',
        value: running ? addrValue(dump.ip, slot, d) : `${formatAddr(dump.ip, slot)} (not running)`,
        note: !running ? 'means nothing while the program is not running' : brkLine ? `the instruction after the BRK on line ${brkLine}` : 'address of the instruction it runs next',
        goto: running && line ? { slot, line } : undefined,
      });
      out.push({ bytes: take(5, 1), name: '@STATUS', value: Status[dump.status] ?? String(dump.status), note: STATUS_NOTES[dump.status] ?? 'result of its last hardware instruction' });
      out.push({ bytes: take(6, 1), name: 'state', value: dump.state, note: `${prog ? '@PROG_STATE' : 'CPU'}: ${STATE_NOTES[dump.state] ?? '?'}` });
      dump.regs.forEach((v, i) => {
        const note = i === 0 ? '4 bytes per register, signed, high byte first' : v < 0 ? 'negative: counted down from FF FF FF FF = -1' : '';
        out.push({ bytes: take(7 + i * 4, 4), name: regLabel(i, slot, d), value: String(v), note });
      });
      const at = 7 + dump.regs.length * 4;
      out.push({ bytes: take(at, 1), name: 'data stack', value: `${dump.dsDepth} value${dump.dsDepth === 1 ? '' : 's'}`, note: 'how many PUSHed values wait (Dump stacks shows them)' });
      out.push({ bytes: take(at + 1, 1), name: 'call stack', value: `${dump.csDepth} return${dump.csDepth === 1 ? '' : 's'}`, note: 'how many CALLs have not RETurned yet' });
      return out;
    }
    let at = 3;
    const nd = dump.dataStack.length;
    out.push({ bytes: take(at, 1), name: 'data stack', value: `${nd} value${nd === 1 ? '' : 's'} follow`, note: '4 bytes each, bottom first' });
    at++;
    dump.dataStack.forEach((v, i) => {
      out.push({ bytes: take(at, 4), name: `data ${i}`, value: String(v), note: i === nd - 1 ? 'top: the next POP gets this' : '' });
      at += 4;
    });
    const nc = dump.callStack.length;
    out.push({ bytes: take(at, 1), name: 'call stack', value: `${nc} return${nc === 1 ? '' : 's'} follow`, note: '2-byte addresses, oldest CALL first' });
    at++;
    dump.callStack.forEach((a, i) => {
      const line = d[slot].lineAt(a);
      out.push({ bytes: take(at, 2), name: `return ${i}`, value: addrValue(a, slot, d), note: i === nc - 1 ? 'the next RET continues here' : '', goto: line ? { slot, line } : undefined });
      at += 2;
    });
    return out;
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
