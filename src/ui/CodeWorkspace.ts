import { FIRMWARE_TEMPLATES, PROGRAM_TEMPLATES } from '../core/programs';
import type { SimulationEngine, UplinkCommand } from '../core/SimulationEngine';
import type { Unit } from '../core/Unit';
import { runsProgram, snapsWithoutSend, type CompileResult, type Slot } from '../core/vm/Compiler';
import { formatAddr } from '../core/vm/isa';
import { EditorPanel } from './EditorPanel';
import { InspectPanel, type SnapMark } from './InspectPanel';
import { buildListing, chunk, LISTING_BYTES_PER_ROW } from './listing';

export interface CodeWorkspaceOptions {
  el: HTMLElement;
  engine: SimulationEngine;
  rover: () => Unit;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Show the machine-code listing pane (preview first: SPEC §5.7.1). */
  listing?: boolean;
  /** Draft shown in the Program slot while the rover has no program. */
  starterProgram?: string;
  onSlotChange?: (slot: Slot) => void;
  /**
   * Show the "Dump program state" box (M11): sends an uplink command for a slot and
   * returns why it was rejected, or null.
   */
  inspect?: (cmd: UplinkCommand, slot: Slot) => string | null;
}

interface SlotUi {
  editor: EditorPanel;
  host: HTMLElement;
  result: CompileResult | null;
  source: string;
}

/** Source column: `label:` padded to a tab stop, then the instruction, no indentation. */
function sourceCell(code: string): string {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*:)\s*(.*)$/.exec(code);
  return m ? `${m[1].padEnd(8)}${m[2]}`.trimEnd() : `${' '.repeat(8)}${code.trim()}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const SLOT_TEXT: Record<Slot, string> = {
  program:
    'Your task: drive, mine, photograph. The firmware runs it in time slices (<code>RUN</code>); finish with <code>END [value]</code>. Uploading is cheap and does not reboot.',
  firmware:
    'Advanced: keeps the rover alive (sun, dish, squalls, battery) and decides when the program runs with <code>RUN</code>. Uploading costs more and reboots the CPU.',
};

/**
 * Code tab (M10, SPEC §3.9): two sources, one flash. The Program slot is the default;
 * the Firmware slot is for advanced players. Each slot keeps its own editor (and undo).
 */
export class CodeWorkspace {
  slot: Slot = 'program';
  private slots: Record<Slot, SlotUi>;
  private q = <T extends HTMLElement>(s: string) => this.opts.el.querySelector(s) as T;
  private listingEl: HTMLElement | null;
  private cursorLine: Record<Slot, number> = { firmware: 1, program: 1 };
  private execLine: Record<Slot, number> = { firmware: 0, program: 0 };
  private snapMark: Record<Slot, SnapMark | null> = { firmware: null, program: null };
  private inspect: InspectPanel | null = null;

  constructor(private opts: CodeWorkspaceOptions) {
    const { el } = opts;
    el.classList.add('code-ws');
    el.innerHTML = `
      <div class="cw-head">
        <span class="seg" id="cw-slots">
          <button data-slot="program" title="Your program (default)">Program</button>
          <button data-slot="firmware" title="Firmware (advanced): keeps the rover alive and runs the program">Firmware <small>advanced</small></button>
        </span>
        <div class="cw-flash" id="cw-flash" title="Flash: firmware and program share it. The slot you edit counts its draft, the other slot what is on the rover.">
          <div class="flashbar"><i class="fw"></i><i class="prog"></i></div>
          <span id="cw-flash-text"></span>
        </div>
      </div>
      <p class="cw-hint small dim" id="cw-hint"></p>
      <div class="toolbar">
        <button id="cw-upload" class="primary" title="Ctrl+Enter / Ctrl+S"></button>
        <button id="cw-revert" title="Back to the code you last uploaded (mission control keeps a copy; nothing is sent)">Revert</button>
        <select id="cw-template"></select>
      </div>
      <div class="toolbar small"><span id="cw-state"></span><span class="dim" id="cw-cost"></span></div>
      <div class="cw-warn small" id="cw-warn" hidden></div>
      <div class="cw-editors">
        <div class="cw-editor" data-ed="program"></div>
        <div class="cw-editor" data-ed="firmware"></div>
      </div>
      ${opts.listing ? '<div class="cw-listing" id="cw-listing"></div>' : ''}
      ${opts.inspect ? '<section id="cw-inspect"></section>' : ''}`;
    this.listingEl = opts.listing ? this.q('#cw-listing') : null;

    const u = opts.rover();
    const make = (slot: Slot, initial: string): SlotUi => {
      const host = this.q<HTMLElement>(`[data-ed="${slot}"]`);
      const ui: SlotUi = { host, result: null, source: initial, editor: null! };
      ui.editor = new EditorPanel({
        parent: host,
        initial,
        compile: (src) => opts.engine.compileFor(opts.rover(), src, slot),
        onUpload: () => this.upload(),
        onChange: (src, res) => {
          ui.source = src;
          ui.result = res;
          if (slot === this.slot) this.refresh();
        },
        onCursor: (line) => {
          this.cursorLine[slot] = line;
          if (slot === this.slot) this.highlightRows();
        },
      });
      return ui;
    };
    this.slots = {
      program: make('program', u.programSource || opts.starterProgram || ''),
      firmware: make('firmware', u.sourceCode),
    };

    el.querySelectorAll<HTMLButtonElement>('#cw-slots button').forEach((b) => b.addEventListener('click', () => this.setSlot(b.dataset.slot as Slot)));
    this.q('#cw-upload').addEventListener('click', () => this.upload());
    this.q('#cw-revert').addEventListener('click', () => {
      const r = opts.rover();
      this.current.editor.setSource(this.slot === 'program' ? r.programSource : r.sourceCode);
    });
    const sel = this.q<HTMLSelectElement>('#cw-template');
    sel.addEventListener('change', () => {
      const t = (this.slot === 'program' ? PROGRAM_TEMPLATES : FIRMWARE_TEMPLATES)[sel.value];
      if (t !== undefined) this.current.editor.setSource(t);
      sel.value = '';
    });
    this.listingEl?.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-line]');
      if (row) this.current.editor.goToLine(Number(row.dataset.line));
    });
    if (opts.inspect) {
      const ins = new InspectPanel(this.q('#cw-inspect'), opts.engine, opts.rover, opts.inspect, (slot) => this.draftIsUploaded(slot));
      ins.onGoToLine = (line) => this.current.editor.goToLine(line);
      ins.onMark = (slot, mark) => {
        this.snapMark[slot] = mark;
        if (slot === this.slot) this.highlightRows(false);
      };
      this.inspect = ins;
    }
    this.setSlot('program');
  }

  /** True while the slot's editor holds exactly the code on the rover. */
  draftIsUploaded(slot: Slot): boolean {
    const u = this.opts.rover();
    return this.slots[slot].editor.source === (slot === 'program' ? u.programSource : u.sourceCode);
  }

  /** Look-inside box: copies received, requests waiting (called from the UI loop). */
  updateInspect(): void {
    this.inspect?.update();
  }

  get current(): SlotUi {
    return this.slots[this.slot];
  }

  editorOf(slot: Slot): EditorPanel {
    return this.slots[slot].editor;
  }

  setSlot(slot: Slot): void {
    this.slot = slot;
    this.opts.el.querySelectorAll<HTMLButtonElement>('#cw-slots button').forEach((b) => b.classList.toggle('active', b.dataset.slot === slot));
    for (const s of ['program', 'firmware'] as Slot[]) this.slots[s].host.hidden = s !== slot;
    this.current.editor.refresh();
    this.q('#cw-hint').innerHTML = SLOT_TEXT[slot];
    this.q('#cw-upload').textContent = slot === 'program' ? 'Upload program' : 'Upload firmware & reboot';
    const sel = this.q<HTMLSelectElement>('#cw-template');
    sel.innerHTML = '';
    sel.add(new Option(slot === 'program' ? 'Programs…' : 'Firmware…', ''));
    for (const name of Object.keys(slot === 'program' ? PROGRAM_TEMPLATES : FIRMWARE_TEMPLATES)) sel.add(new Option(name, name));
    sel.title = slot === 'program' ? 'Load a program template into the editor' : 'Load a firmware into the editor (the all-in-one examples do not run a program)';
    this.opts.el.classList.toggle('slot-firmware', slot === 'firmware');
    this.inspect?.setSlot(slot);
    this.refresh();
    this.opts.onSlotChange?.(slot);
  }

  /** Upload the selected slot over the uplink. */
  upload(): void {
    const { engine, rover, log } = this.opts;
    const u = rover();
    const src = this.current.editor.source;
    const res = this.slot === 'program' ? engine.uploadProgram(u, src) : engine.upload(u, src);
    if (!res.program) log('error', `Upload rejected: ${res.errors.length} compile error(s). First: line ${res.errors[0].line}: ${res.errors[0].message}`);
    else if (res.rejected) log('error', `Upload failed: ${res.rejected} Align the dish with @ANTENNA_ANGLE, or charge first.`);
    this.refresh();
  }

  private sizes(): { fw: number; prog: number; cap: number } {
    const u = this.opts.rover();
    const draft = this.current.result?.flashUsed ?? 0;
    return {
      fw: this.slot === 'firmware' ? draft : u.firmwareBytes,
      prog: this.slot === 'program' ? draft : u.programBytes,
      cap: u.chassis.flashBytes,
    };
  }

  private totalsHtml(): string {
    const s = this.sizes();
    const u = this.opts.rover();
    // M14: RAM taken by VARs, the edited slot counting its draft (shared RAM, like the flash).
    const draftRam = this.current.result?.ramUsed ?? 0;
    const fwRam = this.slot === 'firmware' ? draftRam : u.firmwareRam.high - u.firmwareRam.low;
    const progRam = this.slot === 'program' ? draftRam : u.programRam.high - u.programRam.low;
    const ram = fwRam || progRam ? ` · RAM ${fwRam} + ${progRam} = ${fwRam + progRam} / ${u.chassis.ramBytes} B` : '';
    return `<span class="fwc">firmware ${s.fw}</span> + <span class="progc">program ${s.prog}</span> = ${s.fw + s.prog} / ${s.cap} B${ram}`;
  }

  /** Flash bar, state, warnings and listing for the selected slot. */
  refresh(): void {
    const u = this.opts.rover();
    const ui = this.current;
    const res = ui.result;
    const s = this.sizes();
    const over = s.fw + s.prog > s.cap;
    const bar = this.q('#cw-flash');
    bar.classList.toggle('over', over);
    const pct = (n: number) => `${Math.min(100, (n * 100) / s.cap)}%`;
    this.q<HTMLElement>('.flashbar .fw').style.width = pct(s.fw);
    this.q<HTMLElement>('.flashbar .prog').style.width = pct(Math.max(0, Math.min(s.prog, s.cap - s.fw)));
    this.q('#cw-flash-text').innerHTML = this.totalsHtml();

    const onRover = this.slot === 'program' ? u.programSource : u.sourceCode;
    const st = this.q('#cw-state');
    if (res && res.errors.length) {
      st.className = 'small bad';
      st.textContent = `✗ ${res.errors.length} error${res.errors.length > 1 ? 's' : ''}`;
    } else if (ui.editor.source !== onRover) {
      st.className = 'small warn';
      st.textContent = '● not uploaded';
    } else {
      st.className = 'small ok';
      st.textContent = '✓ on the rover';
    }

    const warn = this.q('#cw-warn');
    const msgs: string[] = [];
    if (this.slot === 'firmware' && res?.program && !runsProgram(res))
      msgs.push('This firmware has no <code>CALL RUN</code> (or <code>CALL PROGRAM</code>): it never runs the program. Fine for an all-in-one firmware; load <i>Default firmware</i> to use the Program slot.');
    if (this.slot === 'program' && !runsProgram(this.opts.engine.compileFor(u, u.sourceCode, 'firmware')))
      msgs.push('The firmware on the rover has no <code>CALL RUN</code>, so no program runs. Switch to <b>Firmware</b> and upload <i>Default firmware</i> (or add <code>CALL RUN</code>).');
    const other = this.slot === 'program' ? this.opts.engine.compileFor(u, u.sourceCode, 'firmware') : u.programSource ? this.opts.engine.compileFor(u, u.programSource, 'program') : null;
    if (snapsWithoutSend(res, other))
      msgs.push('This code takes photos (<code>CALL SNAP</code>) but never sends them: a photo stays in image memory until <code>CALL SEND</code> records it for the downlink (Reference → Image).');
    warn.hidden = !msgs.length;
    warn.innerHTML = msgs.map((m) => `⚠ ${m}`).join('<br>');
    this.renderListing();
  }

  /** Upload cost for the selected slot (called from the UI loop: signal and battery change). */
  updateCost(): void {
    const { engine, rover } = this.opts;
    const u = rover();
    const bytes = this.current.result?.flashUsed ?? 0;
    const el = this.q('#cw-cost');
    const cost = this.slot === 'program' ? engine.programUploadCost(u, bytes) : engine.uploadCost(u, bytes);
    const sig = engine.signalOf(u);
    el.textContent = engine.cheats.freeUpload ? 'Upload cost: free (admin)' : `Upload ${this.slot} ≈ ${(cost / 1000).toFixed(1)}% battery · signal ${sig}`;
    el.classList.toggle('bad', sig < 50 || cost >= u.energy);
  }

  /** Admin debugger: the line each slot executes next (0 = none). */
  setExecLine(slot: Slot, line: number): void {
    this.slots[slot].editor.setExecLine(line);
    if (this.execLine[slot] !== line) {
      this.execLine[slot] = line;
      if (slot === this.slot) this.highlightRows();
    }
  }

  // ------------------------------------------------------------------ listing (SPEC §5.7.1)

  private renderListing(): void {
    const el = this.listingEl;
    const res = this.current.result;
    if (!el || !res) return;
    const l = buildListing(this.current.editor.source, res, this.slot);
    const rows: string[] = [];
    for (const r of l.rows) {
      const cls = `lst-row ${r.kind}${r.error ? ' err' : ''}`;
      const addr = r.addr === null ? '' : `<span class="pfx">${this.slot === 'firmware' ? 'fw:' : 'prog:'}</span>${formatAddr(r.addr)}`;
      const chunks = r.kind === 'instr' || r.kind === 'data' ? chunk(r.bytes ?? new Array(r.size).fill(-1)) : [''];
      const title = r.error ? ` title="${esc(r.error)}"` : '';
      chunks.forEach((c, i) => {
        if (i === 0)
          rows.push(
            `<div class="${cls}" data-line="${r.line}"${title}><span class="a">${addr}</span><span class="h">${c}</span><span class="s">${esc(sourceCell(r.code))}</span></div>`,
          );
        else rows.push(`<div class="lst-row cont" data-line="${r.line}"><span class="a"><span class="pfx">${this.slot === 'firmware' ? 'fw:' : 'prog:'}</span>${formatAddr(r.addr! + i * LISTING_BYTES_PER_ROW)}</span><span class="h">${c}</span><span class="s"></span></div>`);
      });
    }
    const name = this.slot === 'program' ? 'PROGRAM' : 'FIRMWARE';
    const range = l.bytes ? `${formatAddr(0, this.slot)}–${formatAddr(l.bytes - 1)}` : 'empty';
    const status = l.ok ? '' : ` · <span class="bad">not assembled (${res.errors.length} error${res.errors.length > 1 ? 's' : ''}), sizes estimated</span>`;
    const top = el.querySelector('.lst-body')?.scrollTop ?? 0;
    el.innerHTML = `<div class="lst-head"><b>Listing · ${name}</b><span>${range} · ${l.bytes} B${status}</span></div>
      <div class="lst-cols"><span class="a">address</span><span class="h">machine code</span><span class="s">source</span></div>
      <div class="lst-body">${rows.join('') || '<div class="dim">No instructions.</div>'}</div>
      <div class="lst-foot">${this.totalsHtml()}</div>`;
    el.querySelector('.lst-body')!.scrollTop = top;
    this.highlightRows(false);
  }

  private highlightRows(scroll = true): void {
    const el = this.listingEl;
    if (!el) return;
    const cur = this.cursorLine[this.slot];
    const ex = this.execLine[this.slot];
    const snap = this.snapMark[this.slot];
    let first: HTMLElement | null = null;
    el.querySelectorAll<HTMLElement>('.lst-row').forEach((r) => {
      const line = Number(r.dataset.line);
      r.classList.toggle('cursor', line === cur);
      r.classList.toggle('exec', line === ex && ex > 0);
      const isSnap = !!snap && line === snap.line && !r.classList.contains('cont');
      r.classList.toggle('snap', isSnap);
      if (isSnap) r.title = snap.title;
      else if (r.title.startsWith('◆')) r.removeAttribute('title');
      if (line === cur && !first) first = r;
    });
    if (scroll && first) (first as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}
