/**
 * Standalone Blue-11 simulator page (simulator.html): write Blue-11 assembly, assemble, step or
 * run, and watch registers, flags, memory and the console. Uses only the library in
 * src/blue11/ (plus CodeMirror), never the game: it is also a check that the library
 * stands on its own.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { assemble, disassemble, octal, SimpleMachine, type AssembleResult, type CycleModel, type RunResult } from '../blue11';
import { blue11Asm, blue11Highlight } from '../blue11/codemirror';
import { EXAMPLES, SIM_SYMBOLS } from './examples';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const STORE = 'blue11-sim-source';

// ------------------------------------------------------------------ editor

const setPcLine = StateEffect.define<number | null>();
const pcLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setPcLine)) {
        if (e.value === null || e.value > tr.state.doc.lines) return Decoration.none;
        const line = tr.state.doc.line(e.value);
        const b = new RangeSetBuilder<Decoration>();
        b.add(line.from, line.from, Decoration.line({ class: 'cm-pc-line' }));
        return b.finish();
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const toggleBp = StateEffect.define<number>(); // a document position
const clearBps = StateEffect.define<null>();
class BpMarker extends GutterMarker {
  override toDOM(): Node {
    const s = document.createElement('span');
    s.textContent = '●';
    s.style.color = '#ff6b6b';
    return s;
  }
}
const bpMarker = new BpMarker();
const bpField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearBps)) set = RangeSet.empty;
      if (e.is(toggleBp)) {
        let has = false;
        set.between(e.value, e.value, () => { has = true; });
        set = has ? set.update({ filter: (from) => from !== e.value }) : set.update({ add: [bpMarker.range(e.value)] });
      }
    }
    return set;
  },
});

const editor = new EditorView({
  parent: $('editor'),
  state: EditorState.create({
    doc: localStorage.getItem(STORE) ?? EXAMPLES[0].source,
    extensions: [
      gutter({
        class: 'cm-bp-gutter',
        markers: (v) => v.state.field(bpField),
        initialSpacer: () => bpMarker,
        domEventHandlers: { mousedown: (view, line) => { view.dispatch({ effects: toggleBp.of(line.from) }); onBreakpointsChanged(); return true; } },
      }),
      lineNumbers({ domEventHandlers: { mousedown: (view, line) => { view.dispatch({ effects: toggleBp.of(line.from) }); onBreakpointsChanged(); return true; } } }),
      history(),
      highlightActiveLine(),
      lintGutter(),
      bpField,
      pcLineField,
      blue11Asm,
      blue11Highlight,
      keymap.of([
        { key: 'Mod-Enter', run: () => { load(); return true; } },
        indentWithTab, ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) localStorage.setItem(STORE, u.state.doc.toString());
      }),
      EditorView.theme({
        '&': { color: '#e2e8f0', backgroundColor: 'transparent', fontSize: '12.5px' },
        '.cm-content': { fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, monospace", caretColor: '#3affc8' },
        '.cm-gutters': { backgroundColor: 'transparent', color: '#475569', border: 'none' },
        '.cm-activeLine': { backgroundColor: 'rgba(56, 189, 248, 0.06)' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#94a3b8' },
        '.cm-lineNumbers .cm-gutterElement': { cursor: 'pointer' },
        '.cm-bp-gutter .cm-gutterElement': { cursor: 'pointer', width: '12px' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#3affc830 !important' },
      }, { dark: true }),
    ],
  }),
});

// ------------------------------------------------------------------ machine

let machine = new SimpleMachine();
let asm: AssembleResult | null = null;
let breakpoints = new Set<number>();
let running = false;
let lastStop = '';
let prevRegs: number[] = [];
let prevMem: Uint8Array = new Uint8Array(0);
let memFollow: 'pc' | 'sp' | null = null;

function machineOptions(): { eis: boolean; cycles: CycleModel } {
  return { eis: $<HTMLInputElement>('eis').checked, cycles: $<HTMLSelectElement>('cycles').value as CycleModel };
}

function load(): void {
  stop();
  const src = editor.state.doc.toString();
  asm = assemble(src, { symbols: SIM_SYMBOLS });
  const found = [
    ...asm.errors.map((e) => ({ ...e, severity: 'error' as const })),
    ...asm.warnings.map((e) => ({ ...e, severity: 'warning' as const })),
  ].sort((a, b) => a.line - b.line);
  const diagnostics: Diagnostic[] = found.map((e) => {
    const line = editor.state.doc.line(Math.min(e.line, editor.state.doc.lines));
    const from = Math.min(line.from + Math.max(0, e.column - 1), line.to);
    return { from, to: Math.max(from, line.to), severity: e.severity, message: e.message };
  });
  editor.dispatch(setDiagnostics(editor.state, diagnostics));
  const errs = $('errors');
  errs.replaceChildren(...found.map((e) => {
    const d = document.createElement('div');
    d.textContent = `line ${e.line}: ${e.severity === 'warning' ? 'warning: ' : ''}${e.message}`;
    if (e.severity === 'warning') d.className = 'warn';
    d.onclick = () => {
      const l = editor.state.doc.line(e.line);
      editor.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
      editor.focus();
    };
    return d;
  }));
  machine = new SimpleMachine(machineOptions());
  machine.onOutput = () => renderTty();
  prevRegs = [];
  prevMem = new Uint8Array(0);
  if (!asm.ok) {
    lastStop = `${asm.errors.length} error${asm.errors.length > 1 ? 's' : ''}: not loaded`;
    asm = null;
    render(true);
    return;
  }
  machine.boot(asm);
  $<HTMLInputElement>('memaddr').value = octal(asm.origin);
  lastStop = `loaded ${asm.bytes.length} bytes at ${octal(asm.origin)}, start ${octal(asm.start)}`;
  onBreakpointsChanged();
  prevRegs = [...machine.cpu.r];
  prevMem = machine.ram.slice();
  render(false);
}

function onBreakpointsChanged(): void {
  breakpoints = new Set();
  if (!asm) return;
  const byLine = new Map<number, number>();
  for (const [addr, line] of asm.lineAt) if (!byLine.has(line)) byLine.set(line, addr);
  const set = editor.state.field(bpField);
  const iter = set.iter();
  while (iter.value) {
    const line = editor.state.doc.lineAt(iter.from).number;
    const addr = byLine.get(line);
    if (addr !== undefined) breakpoints.add(addr);
    iter.next();
  }
}

function describe(r: RunResult): string {
  switch (r.reason) {
    case 'halt': return `HALT at ${octal((machine.cpu.r[7] - 2) & 0xffff)}`;
    case 'wait': return 'WAIT: asleep, nothing will wake it (no interrupts enabled)';
    case 'breakpoint': return `breakpoint at ${octal(machine.cpu.r[7])}`;
    case 'double-fault': return `double fault (trap ${octal(r.trap!.vector, 3)} could not push on the stack): CPU halted`;
    case 'trap': return `trap ${octal(r.trap!.vector, 3)}`;
    default: return '';
  }
}

function step(): void {
  if (!asm) { load(); if (!asm) return; }
  stop();
  snapshot();
  const r = machine.step();
  lastStop = r.reason === 'budget' ? (r.instructions ? '' : 'interrupt taken') : describe(r);
  render(false);
}

let slowTimer = 0;
function run(): void {
  if (!asm) { load(); if (!asm) return; }
  if (running) { stop(); return; }
  if (machine.cpu.halted) machine.cpu.halted = false; // continue after HALT
  running = true;
  lastStop = 'running…';
  $('run').textContent = 'Stop';
  const speed = $<HTMLSelectElement>('speed').value;
  if (speed === 'slow') {
    slowTimer = window.setInterval(() => {
      snapshot();
      const r = machine.run(1, breakpoints);
      if (r.reason !== 'budget' && !(r.reason === 'wait' && interruptsOn())) { stop(); lastStop = describe(r); }
      render(false);
    }, 200);
    render(false);
    return;
  }
  const cycles = Number(speed);
  const frame = (): void => {
    if (!running) return;
    snapshot();
    const r = machine.run(cycles, breakpoints);
    if (r.reason !== 'budget' && !(r.reason === 'wait' && interruptsOn())) {
      stop();
      lastStop = describe(r);
    }
    render(false);
    if (running) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function interruptsOn(): boolean {
  return (machine.read(0o177546, false) & 0o100) !== 0 || (machine.read(0o177560, false) & 0o100) !== 0;
}

function stop(): void {
  running = false;
  clearInterval(slowTimer);
  $('run').textContent = 'Run';
  if (lastStop === 'running…') lastStop = 'stopped';
}

function snapshot(): void {
  prevRegs = [...machine.cpu.r];
  prevMem = machine.ram.slice();
}

// ------------------------------------------------------------------ rendering

const REG_NAMES = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'SP', 'PC'];

function render(error: boolean): void {
  const cpu = machine.cpu;
  const regs = $('regs');
  regs.replaceChildren(...cpu.r.map((v, i) => {
    const tr = document.createElement('tr');
    const changed = prevRegs.length && prevRegs[i] !== v ? ' changed' : '';
    const signed = v & 0x8000 ? v - 0x10000 : v;
    tr.innerHTML = `<td>${REG_NAMES[i]}</td><td class="oct${changed}">${octal(v)}</td><td class="dec">${signed}.</td>`;
    return tr;
  }));
  $('flags').replaceChildren(...(['N', 'Z', 'V', 'C', 'T'] as const).map((f) => {
    const on = f === 'N' ? cpu.n : f === 'Z' ? cpu.z : f === 'V' ? cpu.v : f === 'C' ? cpu.c : (cpu.psw & 0o20) !== 0;
    const s = document.createElement('span');
    s.className = `flag${on ? ' on' : ''}`;
    s.textContent = f;
    return s;
  }));
  $('psw').textContent = octal(cpu.psw);
  $('pri').textContent = String(cpu.priority);
  $('cyc').textContent = String(machine.cycles);
  $('ins').textContent = String(machine.instructions);
  const readWord = (a: number): number => machine.read(a & 0xfffe, false) & 0xffff;
  const names = new Map<number, string>();
  if (asm) for (const l of asm.labels) names.set(asm.symbols.get(l)!, l);
  for (const [k, v] of Object.entries(SIM_SYMBOLS)) names.set(v, k);
  const d = asm ? disassemble(readWord, cpu.r[7], { nameOf: (a) => names.get(a) }) : null;
  $('next').textContent = d ? `next  ${d.text}\n      ${octal(d.address)}: ${d.words.map((w) => octal(w)).join(' ')}` : 'next  —';
  const st = $('status');
  st.textContent = (cpu.waiting && !running ? 'asleep in WAIT\n' : '') + lastStop;
  st.className = error || /fault|error/.test(lastStop) ? 'err' : '';
  renderMemory();
  renderListing();
  renderTty();
  const line = asm?.lineAt.get(cpu.r[7]) ?? null;
  editor.dispatch({ effects: setPcLine.of(line) });
}

function renderMemory(): void {
  const cpu = machine.cpu;
  const input = $<HTMLInputElement>('memaddr');
  let start: number;
  if (memFollow) {
    start = Math.max(0, (cpu.r[memFollow === 'pc' ? 7 : 6] & 0xfff0) - 0o40);
    input.value = octal(start);
  } else {
    start = parseInt(input.value, 8);
    if (!Number.isFinite(start)) start = 0;
  }
  start &= 0xfff0;
  const rows: HTMLTableRowElement[] = [];
  for (let r = 0; r < 16; r++) {
    const base = (start + r * 16) & 0xffff;
    const tr = document.createElement('tr');
    let html = `<td class="addr">${octal(base)}</td>`;
    let ascii = '';
    for (let k = 0; k < 8; k++) {
      const a = (base + k * 2) & 0xffff;
      const w = machine.read(a, false);
      if (w < 0) { html += '<td class="w">······</td>'; ascii += '  '; continue; }
      const cls = ['w'];
      if (w) cls.push('nz');
      if (a === cpu.r[7]) cls.push('pc');
      if (a === cpu.r[6]) cls.push('sp');
      if (a < prevMem.length && (prevMem[a] | (prevMem[a + 1] << 8)) !== w) cls.push('changed');
      html += `<td class="${cls.join(' ')}" title="${octal(a)}: ${w}.">${octal(w)}</td>`;
      for (const b of [w & 0xff, w >> 8]) ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '·';
    }
    html += `<td class="ascii">${ascii.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`;
    tr.innerHTML = html;
    rows.push(tr);
  }
  $('mem').replaceChildren(...rows);
}

function renderListing(): void {
  const el = $('listing');
  if (!asm) { el.textContent = 'Assemble to see the listing.'; return; }
  const cur = asm.lineAt.get(machine.cpu.r[7]);
  let curEl: HTMLElement | null = null;
  el.replaceChildren(...asm.listingRows.map((row) => {
    const div = document.createElement('div');
    div.textContent = row.text || ' ';
    if (row.line === cur && curEl === null) { div.className = 'cur'; curEl = div; }
    return div;
  }));
  if (running || !curEl) return;
  (curEl as HTMLElement).scrollIntoView({ block: 'nearest' });
}

function renderTty(): void {
  const tty = $('tty');
  tty.textContent = machine.output.replace(/\r\n?/g, '\n');
  const c = document.createElement('span');
  c.className = 'cursor';
  c.textContent = '█';
  tty.appendChild(c);
  const body = $('tty-body');
  body.scrollTop = body.scrollHeight;
}

// ------------------------------------------------------------------ controls

const exampleSel = $<HTMLSelectElement>('example');
exampleSel.append(new Option('Examples…', ''), ...EXAMPLES.map((e, i) => new Option(e.name, String(i))));
exampleSel.onchange = () => {
  const ex = EXAMPLES[Number(exampleSel.value)];
  exampleSel.value = '';
  if (!ex) return;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: ex.source }, effects: clearBps.of(null) });
  if (ex.eis) $<HTMLInputElement>('eis').checked = true;
  load();
};
$('assemble').onclick = load;
$('reset').onclick = load;
$('step').onclick = step;
$('run').onclick = run;
$('eis').onchange = load;
$('cycles').onchange = load;
$('speed').onchange = () => { if (running) { stop(); run(); } };
$('memaddr').onchange = () => { memFollow = null; setFollowButtons(); renderMemory(); };
const setFollowButtons = (): void => {
  $('mem-pc').classList.toggle('on', memFollow === 'pc');
  $('mem-sp').classList.toggle('on', memFollow === 'sp');
};
$('mem-pc').onclick = () => { memFollow = memFollow === 'pc' ? null : 'pc'; setFollowButtons(); renderMemory(); };
$('mem-sp').onclick = () => { memFollow = memFollow === 'sp' ? null : 'sp'; setFollowButtons(); renderMemory(); };
$('tab-tty').onclick = () => { $('tty-body').hidden = false; $('list-body').hidden = true; $('tab-tty').classList.add('on'); $('tab-list').classList.remove('on'); $('tty-help').hidden = false; };
$('tab-list').onclick = () => { $('tty-body').hidden = true; $('list-body').hidden = false; $('tab-list').classList.add('on'); $('tab-tty').classList.remove('on'); $('tty-help').hidden = true; };
$('tty').addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  let code: number | null = null;
  if (e.key.length === 1) code = e.key.charCodeAt(0);
  else if (e.key === 'Enter') code = 13;
  else if (e.key === 'Backspace') code = 0o177;
  else if (e.key === 'Escape') code = 0o33;
  if (code === null) return;
  e.preventDefault();
  machine.type(code);
  if (!running) render(false);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F10') { e.preventDefault(); step(); }
  if (e.key === 'F5') { e.preventDefault(); run(); }
});

load();
