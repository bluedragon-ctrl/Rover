import { BALANCE } from '../core/balance';
import { BOOT_REASON_NAMES, decodeDump, decodeFrame, hex, SYSTEM_TAG, type DecodedDump, type ReceivedFrame } from '../core/downlink';
import type { SimulationEngine, UplinkCommand } from '../core/SimulationEngine';
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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * Mission control console (SPEC §3.8, §3.9.3): uplinked commands to one slot of the rover
 * and the frames received over the downlink. Only knows what the rover sent.
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

  constructor(
    el: HTMLElement,
    private engine: SimulationEngine,
    private rover: () => Unit,
    onCommand: (cmd: UplinkCommand, slot: Slot) => void,
  ) {
    const ch = engine.units[0]?.chassis;
    el.classList.add('console-panel');
    el.innerHTML = `
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
        ${ch?.logFifoBytes ?? 32} B log FIFO; the dish sends ${ch?.linkBytesPerTick ?? BALANCE.linkBytesPerTick} B/tick at full signal
        (none below ${BALANCE.linkMinSignal}). Tags are named from the <code>CONST</code>s of the uploaded firmware and program
        (<code>T_BAT|T_X</code> when the two name a tag differently).</p>
        <p><b>Dump</b> asks for a snapshot of the selected slot (sent before the log), with addresses like
        <code>prog:0x02A (L13)</code>. <code>BRK</code> in the firmware halts the CPU; in the program it halts only the
        program (<code>PROG_HALTED</code>). <b>Continue</b> resumes the selected slot. Every command costs energy like a small upload.</p>
      </details>`;
    this.list = el.querySelector('#console-list')!;
    this.linkEl = el.querySelector('#console-link')!;
    this.cost = el.querySelector('#console-cost')!;
    this.runAgain = el.querySelector('#console-run-again')!;
    el.querySelectorAll<HTMLButtonElement>('button[data-cmd]').forEach((b) =>
      b.addEventListener('click', () => onCommand(b.dataset.cmd as UplinkCommand, b.dataset.cmd === 'RUN_AGAIN' ? 'program' : this.slot)),
    );
    this.slotButtons = [...el.querySelectorAll<HTMLButtonElement>('button[data-slot]')];
    this.slotButtons.forEach((b) => b.addEventListener('click', () => this.setSlot(b.dataset.slot as Slot)));
    this.setSlot(this.slot);
    const filters = [...el.querySelectorAll<HTMLButtonElement>('button[data-filter]')];
    const setFilter = (f: Filter) => {
      this.filter = f;
      filters.forEach((b) => b.classList.toggle('active', b.dataset.filter === f));
      this.lastKey = '';
      this.update();
    };
    filters.forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter as Filter)));
    setFilter('all');
    el.querySelector<HTMLInputElement>('#console-raw')!.addEventListener('change', (e) => {
      this.raw = (e.target as HTMLInputElement).checked;
      this.lastKey = '';
      this.update();
    });
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
    this.linkEl.textContent = `signal ${this.engine.signalOf(u)} · FIFO ${link.used}/${u.chassis.logFifoBytes} B · lost ${link.lost}`;
    const c = this.engine.commandCost(u);
    this.cost.textContent = c ? `each command ≈ ${(c / 1000).toFixed(1)}% battery` : 'commands free (admin)';
    this.runAgain.disabled = !u.programSource;
    const d = this.dictionaries(u);
    const rx = this.engine.received;
    const key = `${rx.length}:${rx.at(-1)?.tick ?? 0}:${this.raw}:${this.filter}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
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
    const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
    this.list.innerHTML = rows.join('');
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;
  }
}
