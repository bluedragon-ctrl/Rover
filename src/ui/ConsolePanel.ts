import { BALANCE } from '../core/balance';
import { decodeDump, decodeFrame, hex, SYSTEM_TAG, type ReceivedFrame } from '../core/downlink';
import type { SimulationEngine, UplinkCommand } from '../core/SimulationEngine';
import type { Unit } from '../core/Unit';
import type { Slot } from '../core/vm/Compiler';
import { DictionaryCache, describeFrame, type Dictionaries } from './comms';

type Filter = 'all' | 'log' | 'dumps' | 'system';
const frameClass = (f: ReceivedFrame): Exclude<Filter, 'all'> => {
  if (decodeDump(f.bytes)) return 'dumps';
  const d = decodeFrame(f.bytes);
  return d.kind === 0 && d.tag === SYSTEM_TAG ? 'system' : 'log';
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * Mission control console (SPEC §3.8, §3.9.3): uplinked commands to one slot of the rover
 * and the frames received over the downlink. Only knows what the rover sent.
 * Replaced by the Comms tab + the Code tab's Inspect box once the owner approves them
 * (game ?comms=1, preview.html?editor=1).
 */
export class ConsolePanel {
  private raw = false;
  private filter: Filter = 'all';
  slot: Slot = 'program';
  private lastKey = '';
  private dicts: DictionaryCache;
  private list: HTMLElement;
  private linkEl: HTMLElement;
  private cost: HTMLElement;
  private slotButtons: HTMLButtonElement[];
  private runAgain: HTMLButtonElement;
  /** Follow the newest frame unless the player scrolled up. */
  private stick = true;

  constructor(
    el: HTMLElement,
    private engine: SimulationEngine,
    private rover: () => Unit,
    onCommand: (cmd: UplinkCommand, slot: Slot) => void,
  ) {
    const ch = engine.units[0]?.chassis;
    this.dicts = new DictionaryCache(engine);
    el.classList.add('console-panel');
    el.innerHTML = this.template(ch?.logFifoBytes ?? 32, ch?.linkBytesPerTick ?? BALANCE.linkBytesPerTick);
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
  }

  private template(fifo: number, rate: number): string {
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

  setSlot(slot: Slot): void {
    this.slot = slot;
    this.slotButtons.forEach((b) => b.classList.toggle('active', b.dataset.slot === slot));
  }

  update(): void {
    const u = this.rover();
    const link = u.link;
    this.linkEl.textContent = `signal ${this.engine.signalOf(u)} · FIFO ${link.used}/${u.chassis.logFifoBytes} B · lost ${link.lost}`;
    const c = this.engine.commandCost(u);
    this.cost.textContent = c ? `each command ≈ ${(c / 1000).toFixed(1)}% battery` : 'commands free (admin)';
    this.runAgain.disabled = !u.programSource;
    const { d, changed } = this.dicts.get(u);
    if (changed) this.lastKey = '';
    const rx = this.engine.received;
    const key = `${rx.length}:${rx.at(-1)?.tick ?? 0}:${this.raw}:${this.filter}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.list.innerHTML = this.rows(d).join('');
    }
    // Follow the newest frame (also after the tab was hidden while frames arrived).
    if (this.stick && this.list.clientHeight) this.list.scrollTop = this.list.scrollHeight;
  }

  private rows(d: Dictionaries): string[] {
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
}
