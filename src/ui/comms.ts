/**
 * Mission control's view of the radio link (no DOM): what it knows about the uploaded code
 * (tag names, source lines), how received frames read, and which reply answers which
 * request. Shared by the Comms tab, the Code tab's Inspect box and the old Console.
 */
import { BOOT_REASON_NAMES, decodeDump, decodeFrame, SYSTEM_TAG, type DecodedDump, type ReceivedFrame } from '../core/downlink';
import type { SentKind, SentRecord, SimulationEngine } from '../core/SimulationEngine';
import { Status } from '../core/types';
import type { Unit } from '../core/Unit';
import type { CompileResult, Slot } from '../core/vm/Compiler';
import { formatAddr } from '../core/vm/isa';

export type LogDictionary = CompileResult['logTags'];

/** What mission control knows about one uploaded slot: its log tags and where its instructions are. */
export interface SlotDictionary {
  tags: LogDictionary;
  /** Source line of the instruction at a byte address (0 if none). */
  lineAt: (addr: number) => number;
}

export type Dictionaries = Record<Slot, SlotDictionary>;

export const emptyDictionary = (): SlotDictionary => ({ tags: {}, lineAt: () => 0 });

/** Dictionary of a compiled slot. */
export function slotDictionary(res: CompileResult): SlotDictionary {
  const p = res.program;
  return {
    tags: res.logTags,
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
  if (!want) return null;
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
    if (r.unitId !== unitId || r.slot !== slot || snapKindOf(r.kind) !== kind) continue;
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
  const req = sent.findIndex((r) => r.unitId === unitId && r.tick === s.taken && r.slot === s.dump.slot && snapKindOf(r.kind) === kind);
  return sent.some((r, i) => r.unitId === unitId && r.kind === upload && (r.tick > s.taken || (r.tick === s.taken && i > req)));
}

// ---------------------------------------------------------------- wording

export const SLOT_WORD: Record<Slot, string> = { program: 'program', firmware: 'firmware' };

/** Player-facing name of a sent record (the word "dump" only appears in help texts). */
export function sentText(r: SentRecord): string {
  const s = SLOT_WORD[r.slot];
  switch (r.kind) {
    case 'DUMP':
      return `Request a copy of the ${s}'s registers`;
    case 'DUMP_STACKS':
      return `Request a copy of the ${s}'s stacks`;
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
