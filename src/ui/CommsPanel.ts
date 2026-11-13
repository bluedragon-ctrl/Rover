import { BALANCE } from '../core/balance';
import { BOOT_REASON_NAMES, decodeDump, decodeFrame, hex, PRODUCT_NAMES, productFrameBytes, SYSTEM_TAG, type ReceivedFrame, type ReceivedProduct } from '../core/downlink';
import type { SimulationEngine } from '../core/SimulationEngine';
import type { Unit } from '../core/Unit';
import { costText, DictionaryCache, fieldsHtml, frameFields, replyTo, sentByBrk, sentText, snapKindOf, tagName, tagSource, type Dictionaries } from './comms';
import type { Slot } from '../core/vm/Compiler';
import { hint } from './hint';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

type Filter = 'all' | 'sent' | 'log' | 'snap' | 'system' | 'science';

const HELP = (fifo: number, rate: number) => `Everything that went between mission control and the rover, oldest first.
  <br><br><b class="up">▲ Sent</b> (up): code uploads and requests from the <b>Code</b> tab. They need the dish to reach the
  orbiter and cost a little battery.
  <br><b class="down">▼ Received</b> (down), what the rover sends:
  <br>· <b>LOG</b>: your <code>LOG tag value</code> lines. Names like <code>T_BAT</code> come from the <code>CONST</code>s in the
  code you uploaded; <code>fw L55</code> = firmware line 55. Repeats are merged (×12).
  <br>· <b>DUMP</b>: the registers or stacks you asked for (Code tab, <i>Dump program state</i>), or that a <code>BRK</code>
  sent by itself, byte by byte. Underlined values (<code>fw L55</code>, addresses) open that line in the Code tab.
  <br>· <b>✗</b>: something you tried to send that the rover could not take (no power, battery, queue full).
  <br>· <b>SYS</b>: the rover itself, e.g. after a reboot.
  <br>· <b>SCI</b>: photos and spectra (shown in the <b>Gallery</b>).
  <br><br><b>Decode bytes</b> explains every byte of LOG and system messages too. All formats: <b>Reference → Radio</b>.
  <br><br>The rover sends dumps first, then the log, then science, ${rate} B per tick at full signal and nothing below
  signal ${BALANCE.linkMinSignal}. Log messages wait in a ${fifo} B queue; when it is full new ones are <b>lost</b>.
  <br><br>Goals, weather and supplies are in <b>Mission events</b> at the bottom.`;

/** One timeline entry before rendering. */
interface Item {
  tick: number;
  /** Tie-break inside a tick: sent before received, then arrival order. */
  order: number;
  cls: Exclude<Filter, 'all'>;
  unitId: number;
  /** Merge key for identical consecutive messages ('' = never merged). */
  merge: string;
  html: (count: number, lastTick: number) => string;
}

/**
 * Comms tab (M11; review page preview.html?editor=1): the radio link as one two-way
 * timeline. ▲ what mission control sent (commands, uploads) with the state of its reply,
 * ▼ what the rover sent (LOG, dumps byte by byte, system, science). Read-only: sending happens in the
 * Code tab. Replaced the M9 Console.
 */
export class CommsPanel {
  private decode = false;
  /** Header layouts already explained in this render (comment on the first row only). */
  private headerSeen = new Set<string>();
  private filter: Filter = 'all';
  private lastKey = '';
  private dicts: DictionaryCache;
  private list: HTMLElement;
  private linkEl: HTMLElement;
  private stick = true;
  /** Set by the game: show a source line of a slot in the Code tab. */
  onGoto?: (slot: Slot, line: number) => void;

  constructor(el: HTMLElement, private engine: SimulationEngine, private rover: () => Unit) {
    const ch = engine.units[0]?.chassis;
    this.dicts = new DictionaryCache(engine);
    el.classList.add('comms-panel');
    el.innerHTML = `
      <section class="panel-box link-box">
        <header><span><b>Radio link</b>${hint(HELP(ch?.logFifoBytes ?? 32, ch?.linkBytesPerTick ?? BALANCE.linkBytesPerTick))}</span></header>
        <div id="comms-link"></div>
      </section>
      <section class="panel-box grow">
        <div class="toolbar small">
          <span class="seg small" id="comms-filter">
            <button data-filter="all">All</button><button data-filter="sent" class="up" title="What you sent up: uploads and requests">▲ Sent</button><button data-filter="log" title="Your LOG lines">LOG</button><button data-filter="snap" title="Dumps of registers and stacks you asked for">Dumps</button><button data-filter="system" title="Reboots and other messages from the rover itself">System</button><button data-filter="science" title="Photos and spectra">Science</button>
          </span>
          <label title="Explain every byte of each received message (dumps always are)"><input type="checkbox" id="comms-raw" /> Decode bytes</label>
          <span class="spacer"></span>
          <button class="small" id="comms-newest" title="Scroll to the newest message">↓</button>
        </div>
        <div id="comms-list"></div>
      </section>`;
    this.list = el.querySelector('#comms-list')!;
    this.linkEl = el.querySelector('#comms-link')!;
    const filters = [...el.querySelectorAll<HTMLButtonElement>('button[data-filter]')];
    const setFilter = (f: Filter) => {
      this.filter = f;
      filters.forEach((b) => b.classList.toggle('active', b.dataset.filter === f));
      this.lastKey = '';
      this.stick = true;
      this.update();
    };
    filters.forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter as Filter)));
    el.querySelector<HTMLInputElement>('#comms-raw')!.addEventListener('change', (e) => {
      this.decode = (e.target as HTMLInputElement).checked;
      this.lastKey = '';
      this.update();
    });
    this.list.addEventListener('click', (ev) => {
      const g = (ev.target as HTMLElement).closest<HTMLElement>('[data-goto]')?.dataset.goto;
      if (!g) return;
      const [slot, line] = g.split(':');
      this.onGoto?.(slot as Slot, Number(line));
    });
    this.list.addEventListener('scroll', () => {
      if (this.list.clientHeight) this.stick = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
    });
    el.querySelector('#comms-newest')!.addEventListener('click', () => {
      this.stick = true;
      this.list.scrollTop = this.list.scrollHeight;
    });
    setFilter('all');
  }

  update(): void {
    const u = this.rover();
    this.linkEl.innerHTML = this.linkHtml(u);
    const { d, changed } = this.dicts.get(u);
    const e = this.engine;
    const g = e.gallery.at(-1);
    const key = [e.received.length, e.received.at(-1)?.tick, e.sent.length, e.sent.at(-1)?.tick, e.gallery.length, g?.arrived, g?.received, this.decode, this.filter, e.units.length].join(':');
    if (key !== this.lastKey || changed) {
      this.lastKey = key;
      this.list.innerHTML = this.rows(d).join('');
    }
    if (this.stick && this.list.clientHeight) this.list.scrollTop = this.list.scrollHeight;
  }

  private linkHtml(u: Unit): string {
    const e = this.engine;
    const sig = e.signalOf(u);
    const min = BALANCE.linkMinSignal;
    const ok = sig >= min;
    const link = u.link;
    const cost = e.commandCost(u);
    const meter = `<span class="sig-meter" title="Signal: how well the dish points at the relay orbiter (0–100). Below ${min} nothing goes up or down."><i style="width:${sig}%" class="${ok ? '' : 'low'}"></i><b style="left:${min}%"></b></span>`;
    return `
      <div class="link-row"><span class="dir down">▼ down</span>${meter}<span class="${ok ? '' : 'warn'}">signal ${sig}${ok ? '' : ` · needs ${min}: nothing arrives`}</span></div>
      <div class="link-row small dim"><span class="dir"></span>
        <span title="LOG messages waiting on the rover. When the queue is full, new ones are lost.">log queue ${link.used}/${u.chassis.logFifoBytes} B</span> ·
        <span title="Photos and spectra waiting on the rover (sent after the log)">science ${link.recUsed}/${u.chassis.recorderBytes} B</span> ·
        <span class="${link.lost ? 'warn' : ''}" title="LOG messages dropped since the last reboot (@LOG_LOST)">lost ${link.lost}</span></div>
      <div class="link-row small dim"><span class="dir up">▲ up</span>
        <span>${cost ? `each request ≈ ${costText(cost)}` : 'requests free (admin)'} · send code and requests from the <b>Code</b> tab</span></div>`;
  }

  // ---------------------------------------------------------------- timeline

  private items(d: Dictionaries): Item[] {
    const e = this.engine;
    const multi = e.units.length > 1;
    const who = (id: number) => (multi ? `<span class="who">${esc(e.getUnit(id)?.name ?? `#${id}`)}</span>` : '');
    const bytes = (b: readonly number[]) => (this.decode ? `<div class="row-fields">${fieldsHtml(frameFields(b, d), this.headerSeen, true)}</div>` : '');
    const out: Item[] = [];
    let order = 0;

    for (const r of e.sent) {
      const kind = snapKindOf(r.kind);
      const reply = kind ? replyTo(r, e.received) : null;
      out.push({
        tick: r.tick,
        order: order++,
        cls: 'sent',
        unitId: r.unitId,
        merge: '',
        html: () => {
          const chip = r.kind === 'PROGRAM' || r.kind === 'FIRMWARE' ? '<span class="chip code">CODE</span>' : '<span class="chip cmd">CMD</span>';
          if (r.rejected)
            return `<div class="row sent rejected"><span class="t">t${r.tick}</span><span class="dir up">✗</span>${chip}<span class="txt">${who(r.unitId)}${esc(sentText(r))} <span class="warn">· not sent: ${esc(r.rejected.replace(/\.$/, ''))}</span></span></div>`;
          let state = '';
          if (kind) state = reply ? `<span class="ok">✓ dump arrived t${reply.frame.tick}</span>` : '<span class="dim">… waiting for the dump</span>';
          return `<div class="row sent"><span class="t">t${r.tick}</span><span class="dir up">▲</span>${chip}<span class="txt">${who(r.unitId)}${esc(sentText(r))} <span class="dim">· ${costText(r.cost)}</span> ${state}</span></div>`;
        },
      });
    }

    let gap = 0;
    for (const f of e.received) {
      gap += f.gap ?? 0;
      if (gap) {
        const n = gap;
        out.push({ tick: f.tick, order: order++, cls: 'log', unitId: f.unitId, merge: '', html: () => `<div class="row lost"><span class="t"></span><span class="dir down">▼</span><span class="chip lost">LOST</span><span class="txt">${n} LOG message${n > 1 ? 's' : ''} dropped: the rover's queue was full</span></div>` });
        gap = 0;
      }
      out.push(this.frameItem(f, d, order++, who, bytes));
    }

    for (const p of e.gallery) out.push(this.scienceItem(p, order++, who));
    out.sort((a, b) => a.tick - b.tick || (a.cls === 'sent' ? 0 : 1) - (b.cls === 'sent' ? 0 : 1) || a.order - b.order);
    return out;
  }

  private frameItem(f: ReceivedFrame, d: Dictionaries, order: number, who: (id: number) => string, bytes: (b: readonly number[]) => string): Item {
    const base = { tick: f.tick, order, unitId: f.unitId };
    const dump = decodeDump(f.bytes);
    if (dump) {
      const what = `${dump.slot === 'program' ? 'Program' : 'Firmware'} ${dump.kind === 1 ? 'registers' : 'stacks'}`;
      const brk = sentByBrk(f, this.engine.sent);
      const at = f.taken === undefined ? '' : brk ? ` <span class="warn">· sent by BRK at t${f.taken}</span>` : ` <span class="dim">· dumped on the rover at t${f.taken}</span>`;
      return {
        ...base,
        cls: 'snap',
        merge: '',
        html: () => `<div class="row snap"><span class="t">t${f.tick}</span><span class="dir down">▼</span><span class="chip snap ${dump.slot}">DUMP</span><div class="txt">${who(f.unitId)}<span class="card-h">${what}</span>${at}</div><div class="row-fields">${fieldsHtml(frameFields(f.bytes, d), this.headerSeen, true)}</div></div>`,
      };
    }
    const fr = decodeFrame(f.bytes);
    const rep = (n: number) => (n > 1 ? `<span class="rep" title="${n} identical messages in a row">×${n}</span>` : '');
    const time = (n: number, last: number) => (n > 1 ? `t${f.tick}–${last}` : `t${f.tick}`);
    if (fr.tag === SYSTEM_TAG) {
      const text = fr.value !== null && BOOT_REASON_NAMES[fr.value] ? `Rover rebooted: ${BOOT_REASON_NAMES[fr.value]}` : `system${fr.value === null ? '' : ` ${fr.value}`}`;
      return { ...base, cls: 'system', merge: `${f.unitId}:${hex(f.bytes)}`, html: (n, last) => `<div class="row system"><span class="t">${time(n, last)}</span><span class="dir down">▼</span><span class="chip sys">SYS</span><span class="txt">${who(f.unitId)}${esc(text)}${rep(n)}</span>${bytes(f.bytes)}</div>` };
    }
    const { name } = tagName(fr.tag, d);
    const src = tagSource(fr.tag, d);
    const srcLinks = (['firmware', 'program'] as const)
      .flatMap((slot) => (d[slot].tags[fr.tag]?.lines ?? []).map((l) => `<button class="link" data-goto="${slot}:${l}">${slot === 'firmware' ? 'fw' : 'prog'} L${l}</button>`))
      .join(' ');
    const value = fr.value === null ? '' : ` = <b>${fr.value}</b>`;
    return {
      ...base,
      cls: 'log',
      merge: `${f.unitId}:${hex(f.bytes)}`,
      html: (n, last) => `<div class="row log"><span class="t">${time(n, last)}</span><span class="dir down">▼</span><span class="chip log">LOG</span><span class="txt">${who(f.unitId)}${esc(name)}${value}${rep(n)}<span class="src" title="${esc(src.long)} · click to show it in the Code tab">${srcLinks}</span></span>${bytes(f.bytes)}</div>`,
    };
  }

  private scienceItem(p: ReceivedProduct, order: number, who: (id: number) => string): Item {
    const size = productFrameBytes(p.type);
    const done = p.received >= size;
    const what = `${PRODUCT_NAMES[p.type] ?? `product ${p.type}`} #${p.seq}`;
    const text = done ? `${what} received (${size} B)${p.credits ? ` · +${p.credits} credits` : ''} · see Gallery` : `receiving ${what}: ${p.received}/${size} B`;
    return { tick: p.arrived, order, cls: 'science', unitId: p.unitId, merge: '', html: () => `<div class="row science"><span class="t">t${p.arrived}</span><span class="dir down">▼</span><span class="chip sci">SCI</span><span class="txt">${who(p.unitId)}${esc(text)}</span></div>` };
  }

  private rows(d: Dictionaries): string[] {
    const items = this.items(d).filter((i) => this.filter === 'all' || i.cls === this.filter);
    // Merge runs of identical LOG / system messages (heartbeats) into one row.
    const runs: { item: Item; count: number; last: number }[] = [];
    for (const it of items) {
      const prev = runs.at(-1);
      if (prev && it.merge && prev.item.merge === it.merge) {
        prev.count++;
        prev.last = it.tick;
      } else runs.push({ item: it, count: 1, last: it.tick });
    }
    this.headerSeen = new Set();
    const rows = runs.map((r) => r.item.html(r.count, r.last));
    if (!rows.length)
      rows.push(
        items.length || this.filter !== 'all'
          ? '<div class="dim empty">Nothing of this kind yet.</div>'
          : '<div class="dim empty">Nothing yet. Upload code or dump the registers in the <b>Code</b> tab (▲); the rover sends what your code <code>LOG</code>s (▼, the default firmware logs <code>T_BAT</code>, the battery, while idle) whenever the dish reaches the orbiter.</div>',
      );
    return rows;
  }
}
