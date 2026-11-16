import type { SimulationEngine, Slot, UplinkCommand } from '../core/SimulationEngine';
import type { Unit } from '../core/Unit';
import { EditorPanel } from './EditorPanel';
import { InspectPanel } from './InspectPanel';
import { listingByLine, coreRegions, toolchain, type SlotBuild, type Toolchain } from './toolchain';

export interface CodeWorkspaceOptions {
  el: HTMLElement;
  engine: SimulationEngine;
  rover: () => Unit;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Offer the machine-code listing column (a checkbox, off until the player turns it on: SPEC §5.7.1). */
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
  editor: EditorPanel<SlotBuild>;
  host: HTMLElement;
  result: SlotBuild | null;
  source: string;
}

/** The listing checkbox is remembered in this browser. */
const LISTING_KEY = 'rover.listing';
const SLOT_TEXT: Record<Slot, string> = {
  program:
    'Your task: drive, mine, photograph, in Blue-11 assembly. The firmware runs it in time slices (<code>JSR PC, RUN</code>); finish with <code>HALT</code> (the result in <code>R0</code>). Uploading is cheap and does not reboot.',
  firmware:
    'Advanced: keeps the rover alive (sun, dish, squalls, battery) and runs the program through the gate (<code>PRGCS</code>, or the ROM\'s <code>RUN</code>). Uploading costs more and reboots the CPU.',
};

/**
 * Code tab (M10, SPEC §3.9): two sources, two regions of core. The Program slot is the default;
 * the Firmware slot is for advanced players. Each slot keeps its own editor (and undo).
 */
export class CodeWorkspace {
  slot: Slot = 'program';
  private slots: Record<Slot, SlotUi>;
  private q = <T extends HTMLElement>(s: string) => this.opts.el.querySelector(s) as T;
  private listingOn = false;
  private inspect: InspectPanel | null = null;
  /** Assembling, templates and the listing. */
  readonly tc: Toolchain;

  constructor(private opts: CodeWorkspaceOptions) {
    this.tc = toolchain(opts.engine);
    const { el } = opts;
    el.classList.add('code-ws');
    el.innerHTML = `
      <div class="cw-head">
        <span class="seg" id="cw-slots">
          <button data-slot="program" title="Your program (default)">Program</button>
          <button data-slot="firmware" title="Firmware (advanced): keeps the rover alive and runs the program">Firmware <small>advanced</small></button>
        </span>
        <div class="cw-flash" id="cw-flash">
          <div class="flashbar"><i class="fw"></i><i class="prog"></i></div>
          <span id="cw-flash-text"></span>
        </div>
      </div>
      <p class="cw-hint small dim" id="cw-hint"></p>
      <div class="toolbar">
        <button id="cw-upload" class="primary" title="Ctrl+Enter / Ctrl+S"></button>
        <button id="cw-revert" title="Back to the code you last uploaded (mission control keeps a copy; nothing is sent)">Revert</button>
        <select id="cw-template"></select>
        ${opts.listing ? '<label class="cw-lst-toggle small" title="Show the machine code beside each line: its address and words in octal, as the assembler writes them"><input type="checkbox" id="cw-listing"> Listing</label>' : ''}
      </div>
      <div class="toolbar small"><span id="cw-state"></span><span class="dim" id="cw-range"></span><span class="dim" id="cw-cost"></span></div>
      <div class="cw-warn small" id="cw-warn" hidden></div>
      <div class="cw-editors">
        <div class="cw-editor" data-ed="program"></div>
        <div class="cw-editor" data-ed="firmware"></div>
      </div>
      ${opts.inspect ? '<section id="cw-inspect"></section>' : ''}`;

    const u = opts.rover();
    const make = (slot: Slot, initial: string): SlotUi => {
      const host = this.q<HTMLElement>(`[data-ed="${slot}"]`);
      const ui: SlotUi = { host, result: null, source: initial, editor: null! };
      ui.editor = new EditorPanel<SlotBuild>({
        parent: host,
        initial,
        language: this.tc.language,
        compile: (src) => this.tc.build(opts.rover(), src, slot),
        onUpload: () => this.upload(),
        onChange: (src, res) => {
          ui.source = src;
          ui.result = res;
          if (this.listingOn) ui.editor.setListing(listingByLine(res));
          if (slot === this.slot) this.refresh();
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
      const t = this.tc.templates(this.slot)[sel.value];
      if (t !== undefined) this.current.editor.setSource(t);
      sel.value = '';
    });
    if (opts.listing) {
      const box = this.q<HTMLInputElement>('#cw-listing');
      box.checked = readListingPref();
      box.addEventListener('change', () => {
        writeListingPref(box.checked);
        this.setListing(box.checked);
      });
      this.setListing(box.checked);
    }
    if (opts.inspect) {
      const ins = new InspectPanel(this.q('#cw-inspect'), opts.engine, opts.rover, opts.inspect, (slot) => this.draftIsUploaded(slot));
      ins.onGoToLine = (line) => this.current.editor.goToLine(line);
      ins.onMark = (slot, mark) => this.slots[slot].editor.setSnapMark(mark);
      this.inspect = ins;
    }
    this.setSlot('program');
  }

  /** Show or hide the listing column in both slots' editors. */
  setListing(on: boolean): void {
    this.listingOn = on;
    for (const ui of Object.values(this.slots)) {
      if (on && ui.result) ui.editor.setListing(listingByLine(ui.result));
      ui.editor.showListing(on);
    }
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
    for (const name of Object.keys(this.tc.templates(slot))) sel.add(new Option(name, name));
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
    const dish = 'Align the dish (ANTANG)';
    if (res.errors.length) log('error', `Upload rejected: ${res.errors.length} assembly error(s). First: line ${res.errors[0].line}: ${res.errors[0].message}`);
    else if (res.rejected) log('error', `Upload failed: ${res.rejected} ${dish}, or charge first.`);
    this.refresh();
  }

  private sizes(): { fw: number; prog: number; cap: number } {
    const u = this.opts.rover();
    const draft = this.current.result?.bytes ?? 0;
    const r = coreRegions(u);
    return { fw: this.slot === 'firmware' ? draft : u.firmwareBytes, prog: this.slot === 'program' ? draft : u.programBytes, cap: r.fw + r.prog };
  }

  private totalsHtml(): string {
    const s = this.sizes();
    const u = this.opts.rover();
    // Two regions of core (BLUE11_CPU.md §6).
    const r = coreRegions(u);
    const kb = u.machine.coreBytes / 1024;
    return `<span class="fwc">firmware ${s.fw} / ${r.fw}</span> · <span class="progc">program ${s.prog} / ${r.prog}</span> B · core ${kb} KB`;
  }

  /** Core bar, state, warnings and listing for the selected slot. */
  refresh(): void {
    const u = this.opts.rover();
    const ui = this.current;
    const res = ui.result;
    const s = this.sizes();
    const regions = coreRegions(u);
    const over = s.fw > regions.fw || s.prog > regions.prog;
    const bar = this.q('#cw-flash');
    bar.classList.toggle('over', over);
    const pct = (n: number) => `${Math.min(100, (n * 100) / s.cap)}%`;
    this.q<HTMLElement>('.flashbar .fw').style.width = pct(s.fw);
    this.q<HTMLElement>('.flashbar .prog').style.width = pct(Math.max(0, Math.min(s.prog, s.cap - s.fw)));
    bar.title = 'Core: the firmware region (000200–001777) and the program region (002000 up to the program\'s stack at the top of core). The slot you edit counts its draft, the other slot what is on the rover.';
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
    const range = this.q('#cw-range');
    const asm = res?.result.asm;
    const n = asm?.bytes.length ?? 0;
    range.textContent = asm && n ? `${this.tc.addr(asm.origin, this.slot)}–${this.tc.addr(asm.origin + n - 1, this.slot)} · ${n} B` : '';
    range.title = 'Where the code goes in core and how many bytes it takes (octal addresses)';

    const warn = this.q('#cw-warn');
    const msgs: string[] = [];
    const tc = this.tc;
    const run = '<code>JSR PC, RUN</code> (or a write to <code>PRGCS</code>)';
    if (this.slot === 'firmware' && res?.ok && !tc.runsProgram(res))
      msgs.push(`This firmware has no ${run}: it never runs the program. Fine for an all-in-one firmware; load <i>Default firmware</i> to use the Program slot.`);
    const fwOnRover = tc.build(u, u.sourceCode, 'firmware');
    if (this.slot === 'program' && !tc.runsProgram(fwOnRover))
      msgs.push(`The firmware on the rover has no ${run}, so no program runs. Switch to <b>Firmware</b> and upload <i>Default firmware</i>.`);
    const other = this.slot === 'program' ? fwOnRover : u.programSource ? tc.build(u, u.programSource, 'program') : null;
    if (tc.snapsWithoutSend(res, other))
      msgs.push('This code takes photos (<code>JSR PC, SNAP</code>) but never sends them: a photo stays in image memory until <code>JSR PC, SNDIMG</code> records it for the downlink (Reference → Image).');
    warn.hidden = !msgs.length;
    warn.innerHTML = msgs.map((m) => `⚠ ${m}`).join('<br>');
  }

  /** Upload cost for the selected slot (called from the UI loop: signal and battery change). */
  updateCost(): void {
    const { engine, rover } = this.opts;
    const u = rover();
    const bytes = this.current.result?.bytes ?? 0;
    const el = this.q('#cw-cost');
    const cost = this.slot === 'program' ? engine.programUploadCost(u, bytes) : engine.uploadCost(u, bytes);
    const sig = engine.signalOf(u);
    el.textContent = engine.cheats.freeUpload ? 'Upload cost: free (admin)' : `Upload ${this.slot} ≈ ${(cost / 1000).toFixed(1)}% battery · signal ${sig}`;
    el.classList.toggle('bad', sig < 50 || cost >= u.energy);
  }

  /** Admin debugger: the line each slot executes next (0 = none). */
  setExecLine(slot: Slot, line: number): void {
    this.slots[slot].editor.setExecLine(line);
  }
}

function readListingPref(): boolean {
  try {
    return localStorage.getItem(LISTING_KEY) === '1';
  } catch {
    return false;
  }
}

function writeListingPref(on: boolean): void {
  try {
    localStorage.setItem(LISTING_KEY, on ? '1' : '0');
  } catch {
    // private mode: not remembered
  }
}
