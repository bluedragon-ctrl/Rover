import { BALANCE } from '../core/balance';
import { BOOT_REASON_NAMES, decodeDump, decodeFrame, hex, SYSTEM_TAG, type DecodedDump, type ReceivedFrame } from '../core/downlink';
import type { SimulationEngine, UplinkCommand } from '../core/SimulationEngine';
import { Status } from '../core/types';
import type { Unit } from '../core/Unit';
import type { CompileResult, Slot } from '../core/vm/Compiler';
import { formatAddr } from '../core/vm/isa';
import { hint } from './hint';

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

type Filter = 'all' | 'log' | 'dumps' | 'system';
const frameClass = (f: ReceivedFrame): Exclude<Filter, 'all'> => {
  if (decodeDump(f.bytes)) return 'dumps';
  const d = decodeFrame(f.bytes);
  return d.kind === 0 && d.tag === SYSTEM_TAG ? 'system' : 'log';
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const SLOT_NAME: Record<Slot, string> = { firmware: 'firmware', program: 'program' };

/** One displayed row of the redesigned list: a frame, or a run of identical frames. */
interface Row {
  f: ReceivedFrame;
  cls: Exclude<Filter, 'all'>;
  count: number;
  lastTick: number;
  /** Frames lost before this one (FIFO full). */
  gap: number;
}

/** Where a log tag is logged: `fw L55` plus a readable tooltip. */
function tagSource(tag: number, d: Dictionaries): { short: string; long: string } {
  const parts: string[] = [];
  const long: string[] = [];
  for (const slot of ['firmware', 'program'] as const) {
    const lines = d[slot].tags[tag]?.lines ?? [];
    if (!lines.length) continue;
    parts.push(`${slot === 'firmware' ? 'fw' : 'prog'} L${lines.join(',')}`);
    long.push(`${SLOT_NAME[slot]} line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`);
  }
  return { short: parts.join(' · '), long: long.length ? `Sent by LOG in the ${long.join(' and the ')}` : 'No LOG with this tag in the uploaded code' };
}

/** Dump reply as a small card (redesigned console). */
function dumpCard(dump: DecodedDump, taken: number | undefined, d: Dictionaries): string {
  const who = dump.slot === 'program' ? 'Program' : 'Firmware';
  const at = taken === undefined ? '' : ` · snapshot at t${taken}`;
  if (dump.kind === 1) {
    const line = d[dump.slot].lineAt(dump.ip);
    const regs = dump.regs.map((v, i) => `<span><i>r${i}</i>${v}</span>`).join('');
    return `<div class="card"><div class="card-h">${who} registers${at}</div>
      <div class="kv2"><i>next</i>${esc(formatAddr(dump.ip, dump.slot))}${line ? ` <span class="dim">line ${line}</span>` : ''}</div>
      <div class="kv2"><i>state</i>${esc(dump.state)} <span class="dim">· @STATUS</span> ${esc(Status[dump.status] ?? String(dump.status))}</div>
      <div class="regs">${regs}</div>
      <div class="kv2"><i>stacks</i>data ${dump.dsDepth} <span class="dim">·</span> return ${dump.csDepth} <span class="dim">(Dump stacks shows them)</span></div></div>`;
  }
  const ds = dump.dataStack.length ? dump.dataStack.join(' ') : '<span class="dim">empty</span>';
  const cs = dump.callStack.length ? dump.callStack.map((a) => esc(addrText(a, dump.slot, d))).join(' ← ') : '<span class="dim">empty</span>';
  return `<div class="card"><div class="card-h">${who} stacks${at}</div>
    <div class="kv2"><i>data</i>${ds}</div>
    <div class="kv2"><i>returns</i>${cs}</div></div>`;
}

const UPLINK_HELP = `Commands travel <b>up</b> through the dish, so they need signal, and each costs a little battery.
  <br><br><b>Program / Firmware</b> picks which part of the rover a command talks to. The <b>firmware</b> keeps the rover
  alive and runs your <b>program</b> in time slices; each has its own position in the code, registers and stacks.
  <br><br><b>Dump registers</b>: where it is in the code, its state, <code>@STATUS</code> and its registers.
  <br><b>Dump stacks</b>: the data stack and the return addresses of <code>CALL</code>s.
  <br><b>Continue</b>: resume after a <code>BRK</code> breakpoint.
  <br><b>Run again</b>: restart the program from its first line.
  <br><br>Replies show up under <b>Received</b>, ahead of waiting log messages.`;

const downlinkHelp = (fifo: number, rate: number) => `Everything the rover sends <b>down</b>, oldest first.
  <br><br><b>Log</b>: your <code>LOG tag value</code> lines. Names like <code>T_BAT</code> come from the <code>CONST</code>s in the
  code you uploaded; <code>fw L55</code> means firmware line 55. Repeats are merged (×12).
  <br><b>Dumps</b>: replies to the Dump buttons.
  <br><b>System</b>: messages from the rover itself, such as reboots.
  <br><br>Messages wait in a ${fifo} B queue on the rover until the dish sends them (${rate} B per tick at full signal, nothing
  below ${BALANCE.linkMinSignal}). When the queue is full, new messages are <b>lost</b>.`;

/**
 * Mission control console (SPEC §3.8, §3.9.3): uplinked commands to one slot of the rover
 * and the frames received over the downlink. Only knows what the rover sent.
 * `redesign` (review in preview.html?editor=1, game ?console=2): labelled sections with
 * help hints, readable rows, merged repeats, dump cards, hex on request.
 */
export class ConsolePanel {
  private raw = false;
  private filter: Filter = 'all';
  slot: Slot = 'program';
  private lastKey = '';
  private dictKey = '\u0000';
  private dicts: Dictionaries = { firmware: emptyDictionary(), program: emptyDictionary() };
  private list: HTMLElement;
  private linkEl: HTMLElement;
  private cost: HTMLElement;
  private slotButtons: HTMLButtonElement[];
  private runAgain: HTMLButtonElement;
  private redesign: boolean;
  /** Follow the newest frame unless the player scrolled up. */
  private stick = true;

  constructor(
    el: HTMLElement,
    private engine: SimulationEngine,
    private rover: () => Unit,
    onCommand: (cmd: UplinkCommand, slot: Slot) => void,
    opts: { redesign?: boolean } = {},
  ) {
    const ch = engine.units[0]?.chassis;
    this.redesign = !!opts.redesign;
    el.classList.add('console-panel');
    el.classList.toggle('v2', this.redesign);
    el.innerHTML = this.redesign ? this.templateV2(ch?.logFifoBytes ?? 32, ch?.linkBytesPerTick ?? BALANCE.linkBytesPerTick) : this.templateV1(ch?.logFifoBytes ?? 32, ch?.linkBytesPerTick ?? BALANCE.linkBytesPerTick);
    this.list = el.querySelector('#console-list')!;
    this.linkEl = el.querySelector('#console-link')!;
    this.cost = el.querySelector('#console-cost')!;
    this.runAgain = el.querySelector('#console-run-again')!;
    el.querySelectorAll<HTMLButtonElement>('button[data-cmd]').forEach((b) =>
      b.addEventListener('click', () => {
        this.stick = true;
        onCommand(b.dataset.cmd as UplinkCommand, b.dataset.cmd === 'RUN_AGAIN' ? 'program' : this.slot);
      }),
    );
    this.slotButtons = [...el.querySelectorAll<HTMLButtonElement>('button[data-slot]')];
    this.slotButtons.forEach((b) => b.addEventListener('click', () => this.setSlot(b.dataset.slot as Slot)));
    this.setSlot(this.slot);
    const filters = [...el.querySelectorAll<HTMLButtonElement>('button[data-filter]')];
    const setFilter = (f: Filter) => {
      this.filter = f;
      filters.forEach((b) => b.classList.toggle('active', b.dataset.filter === f));
      this.lastKey = '';
      this.stick = true;
      this.update();
    };
    filters.forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter as Filter)));
    setFilter('all');
    el.querySelector<HTMLInputElement>('#console-raw')!.addEventListener('change', (e) => {
      this.raw = (e.target as HTMLInputElement).checked;
      this.lastKey = '';
      this.update();
    });
    this.list.addEventListener('scroll', () => {
      if (this.list.clientHeight) this.stick = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
    });
    el.querySelector('#console-newest')?.addEventListener('click', () => {
      this.stick = true;
      this.list.scrollTop = this.list.scrollHeight;
    });
  }

  private templateV1(fifo: number, rate: number): string {
    return `
      <section class="panel-box">
        <header><b>Uplink</b><span class="dim small" id="console-cost"></span></header>
        <div class="toolbar">
          <span class="seg small" title="Which context the commands address: each slot has its own IP, registers and stacks">
            <button data-slot="firmware">Firmware</button><button data-slot="program">Program</button>
          </span>
          <button data-cmd="DUMP" title="The rover replies with the selected slot's IP, @STATUS, state, registers and stack depths">Dump</button>
          <button data-cmd="DUMP_STACKS" title="The rover replies with the selected slot's data and call stacks">Dump stacks</button>
          <button data-cmd="CONTINUE" title="Resume after BRK. Firmware: the CPU runs on. Program: PROG_READY, the next RUN resumes it">Continue</button>
          <button data-cmd="RUN_AGAIN" id="console-run-again" title="Restart the program from the top (like the firmware writing PROG_READY). Always addresses the program">↻ Run again</button>
        </div>
      </section>
      <section class="panel-box grow">
        <header><b>Downlink</b><span class="dim small" id="console-link"></span></header>
        <div class="toolbar small">
          <span class="seg small" id="console-filter">
            <button data-filter="all">All</button><button data-filter="log">Log</button><button data-filter="dumps">Dumps</button><button data-filter="system">System</button>
          </span>
          <label><input type="checkbox" id="console-raw" /> Raw hex</label>
        </div>
        <div id="console-list"></div>
      </section>
      <details class="small dim help">
        <summary>How the console works</summary>
        <p>Mission control only knows what the rover sends. <code>LOG tag [value]</code> queues a frame in the
        ${fifo} B log FIFO; the dish sends ${rate} B/tick at full signal
        (none below ${BALANCE.linkMinSignal}). Tags are named from the <code>CONST</code>s of the uploaded firmware and program
        (<code>T_BAT|T_X</code> when the two name a tag differently).</p>
        <p><b>Dump</b> asks for a snapshot of the selected slot (sent before the log), with addresses like
        <code>prog:0x02A (L13)</code>. <code>BRK</code> in the firmware halts the CPU; in the program it halts only the
        program (<code>PROG_HALTED</code>). <b>Continue</b> resumes the selected slot. Every command costs energy like a small upload.</p>
      </details>`;
  }

  private templateV2(fifo: number, rate: number): string {
    return `
      <p class="small dim console-intro">Radio link to the rover: send commands up, read what it sends down.
        Game messages (goals, events, uploads) are in the <b>Mission log</b> at the bottom.</p>
      <section class="panel-box">
        <header><span><b>Send to rover</b>${hint(UPLINK_HELP)}</span><span class="dim small" id="console-cost"></span></header>
        <div class="toolbar small">
          <span class="dim">Talk to</span>
          <span class="seg small" title="Which part of the rover the commands below talk to">
            <button data-slot="program">Program</button><button data-slot="firmware">Firmware</button>
          </span>
          <span class="spacer"></span>
          <button data-cmd="RUN_AGAIN" id="console-run-again" title="Restart the program from its first line (whichever part is selected)">↻ Run program again</button>
        </div>
        <div class="toolbar">
          <button data-cmd="DUMP" title="Reply: where the selected part is in its code, its state, @STATUS and its registers">Dump registers</button>
          <button data-cmd="DUMP_STACKS" title="Reply: the selected part's data stack and return addresses">Dump stacks</button>
          <button data-cmd="CONTINUE" title="Resume the selected part after a BRK breakpoint">▶ Continue</button>
        </div>
      </section>
      <section class="panel-box grow">
        <header><span><b>Received from rover</b>${hint(downlinkHelp(fifo, rate))}</span>
          <span class="dim small" id="console-link" title="Signal: dish alignment (0–100). Queue: messages waiting on the rover. Lost: dropped because the queue was full."></span></header>
        <div class="toolbar small">
          <span class="seg small" id="console-filter">
            <button data-filter="all">All</button><button data-filter="log" title="Your LOG lines">Log</button><button data-filter="dumps" title="Replies to Dump">Dumps</button><button data-filter="system" title="Reboots and other messages from the rover itself">System</button>
          </span>
          <label title="Show the raw bytes of each message, as received"><input type="checkbox" id="console-raw" /> Bytes</label>
          <span class="spacer"></span>
          <button class="small" id="console-newest" title="Scroll to the newest message">↓ Newest</button>
        </div>
        <div id="console-list"></div>
      </section>`;
  }

  setSlot(slot: Slot): void {
    this.slot = slot;
    this.slotButtons.forEach((b) => b.classList.toggle('active', b.dataset.slot === slot));
  }

  /** Mission control knows the code it uploaded: both slots' dictionaries and addresses. */
  private dictionaries(u: Unit): Dictionaries {
    const key = `${u.sourceCode}\u0000${u.programSource}`;
    if (key !== this.dictKey) {
      this.dictKey = key;
      this.dicts = {
        firmware: slotDictionary(this.engine.compileFor(u, u.sourceCode, 'firmware')),
        program: u.programSource ? slotDictionary(this.engine.compileFor(u, u.programSource, 'program')) : emptyDictionary(),
      };
      this.lastKey = '';
    }
    return this.dicts;
  }

  update(): void {
    const u = this.rover();
    const link = u.link;
    this.linkEl.textContent = this.redesign
      ? `signal ${this.engine.signalOf(u)} · queue ${link.used}/${u.chassis.logFifoBytes} B · lost ${link.lost}`
      : `signal ${this.engine.signalOf(u)} · FIFO ${link.used}/${u.chassis.logFifoBytes} B · lost ${link.lost}`;
    const c = this.engine.commandCost(u);
    this.cost.textContent = c ? `each command ≈ ${(c / 1000).toFixed(1)}% battery` : 'commands free (admin)';
    this.runAgain.disabled = !u.programSource;
    const d = this.dictionaries(u);
    const rx = this.engine.received;
    const key = `${rx.length}:${rx.at(-1)?.tick ?? 0}:${this.raw}:${this.filter}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.list.innerHTML = (this.redesign ? this.rowsV2(d) : this.rowsV1(d)).join('');
    }
    // Follow the newest frame (also after the tab was hidden while frames arrived).
    if (this.stick && this.list.clientHeight) this.list.scrollTop = this.list.scrollHeight;
  }

  private rowsV1(d: Dictionaries): string[] {
    const rx = this.engine.received;
    const multi = this.engine.units.length > 1;
    const rows: string[] = [];
    for (const f of rx) {
      if (f.gap && this.filter !== 'dumps') rows.push(`<div class="warn">⚠ ${f.gap} frame${f.gap > 1 ? 's' : ''} lost (FIFO full)</div>`);
      const cls = frameClass(f);
      if (this.filter !== 'all' && this.filter !== cls) continue;
      const who = multi ? `${esc(this.engine.getUnit(f.unitId)?.name ?? `#${f.unitId}`)} ` : '';
      const dump = cls === 'dumps' ? decodeDump(f.bytes) : null;
      const badge = dump ? `<span class="badge ${dump.slot}">${dump.slot === 'program' ? 'PROG' : 'FW'}</span> ` : '';
      const text = this.raw ? '' : `${esc(describeFrame(f, d))} `;
      rows.push(`<div class="${cls}"><span class="dim">t${f.tick}</span> ${who}${badge}${text}<span class="hex">${hex(f.bytes)}</span></div>`);
    }
    if (!rows.length) rows.push(`<div class="dim">${rx.length ? 'No frames match the filter.' : 'No frames received yet.'}</div>`);
    return rows;
  }

  private rowsV2(d: Dictionaries): string[] {
    const rx = this.engine.received;
    const multi = this.engine.units.length > 1;
    // Merge runs of identical log/system frames (heartbeats) into one row.
    const runs: Row[] = [];
    let gap = 0;
    for (const f of rx) {
      gap += f.gap ?? 0;
      const cls = frameClass(f);
      if (this.filter !== 'all' && this.filter !== cls) continue;
      const prev = runs.at(-1);
      if (prev && !gap && cls !== 'dumps' && prev.cls === cls && prev.f.unitId === f.unitId && hex(prev.f.bytes) === hex(f.bytes)) {
        prev.count++;
        prev.lastTick = f.tick;
        continue;
      }
      runs.push({ f, cls, count: 1, lastTick: f.tick, gap });
      gap = 0;
    }
    const rows: string[] = [];
    for (const r of runs) {
      const f = r.f;
      if (r.gap) rows.push(`<div class="row lost"><span class="t"></span><span class="chip lost">LOST</span><span class="txt">${r.gap} message${r.gap > 1 ? 's' : ''} dropped: the rover's queue was full</span></div>`);
      const who = multi ? `<span class="who">${esc(this.engine.getUnit(f.unitId)?.name ?? `#${f.unitId}`)}</span>` : '';
      const time = r.count > 1 ? `t${f.tick}–${r.lastTick}` : `t${f.tick}`;
      const bytes = this.raw ? `<span class="hex">${hex(f.bytes)}</span>` : '';
      const dump = r.cls === 'dumps' ? decodeDump(f.bytes) : null;
      if (dump) {
        const chip = `<span class="chip dump ${dump.slot}">${dump.slot === 'program' ? 'PROG' : 'FW'}</span>`;
        rows.push(`<div class="row dumps"><span class="t">${time}</span>${chip}<div class="txt">${who}${dumpCard(dump, f.taken, d)}${bytes}</div></div>`);
        continue;
      }
      const fr = decodeFrame(f.bytes);
      const rep = r.count > 1 ? `<span class="rep" title="${r.count} identical messages in a row">×${r.count}</span>` : '';
      if (fr.kind === 1) {
        rows.push(`<div class="row log"><span class="t">${time}</span><span class="chip sci">SCI</span><span class="txt">${who}science data (type ${fr.tag}), see Gallery${rep}${bytes}</span></div>`);
      } else if (fr.tag === SYSTEM_TAG) {
        const text = fr.value !== null && BOOT_REASON_NAMES[fr.value] ? `Rover rebooted: ${BOOT_REASON_NAMES[fr.value]}` : `system${fr.value === null ? '' : ` ${fr.value}`}`;
        rows.push(`<div class="row system"><span class="t">${time}</span><span class="chip sys">SYS</span><span class="txt">${who}${esc(text)}${rep}${bytes}</span></div>`);
      } else {
        const { name } = tagName(fr.tag, d);
        const src = tagSource(fr.tag, d);
        const value = fr.value === null ? '' : ` = <b>${fr.value}</b>`;
        rows.push(
          `<div class="row log"><span class="t">${time}</span><span class="chip log">LOG</span><span class="txt">${who}${esc(name)}${value}${rep}<span class="src" title="${esc(src.long)}">${esc(src.short)}</span>${bytes}</span></div>`,
        );
      }
    }
    if (!rows.length)
      rows.push(
        rx.length
          ? '<div class="dim empty">No messages of this kind yet.</div>'
          : '<div class="dim empty">Nothing received yet. The rover sends what your code <code>LOG</code>s (the default firmware logs <code>T_BAT</code>, the battery, while idle) and replies to the Dump buttons above, whenever the dish points at the orbiter.</div>',
      );
    return rows;
  }
}
