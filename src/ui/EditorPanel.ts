import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { Diag, ListingLine } from './toolchain';

const setExecLine = StateEffect.define<number>();

const execLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setExecLine)) {
        const b = new RangeSetBuilder<Decoration>();
        if (e.value > 0 && e.value <= tr.state.doc.lines) {
          const line = tr.state.doc.line(e.value);
          b.add(line.from, line.from, Decoration.line({ class: 'cm-exec-line' }));
        }
        deco = b.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The listing column shows at most this many words; a longer line ends in `…+n` (all of them on hover). */
const LISTING_WORDS = 3;

const setListing = StateEffect.define<ReadonlyMap<number, ListingLine>>();
const listingField = StateField.define<ReadonlyMap<number, ListingLine>>({
  create: () => new Map(),
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setListing) ? e.value : acc), v),
});

class ListingMarker extends GutterMarker {
  constructor(readonly l: ListingLine) {
    super();
  }
  override eq(o: ListingMarker): boolean {
    return o.l.addr === this.l.addr && o.l.words.join() === this.l.words.join();
  }
  override toDOM(): Node {
    const el = document.createElement('span');
    const { addr, words } = this.l;
    const shown = words.length > LISTING_WORDS ? [...words.slice(0, LISTING_WORDS - 1), `…+${words.length - LISTING_WORDS + 1}`] : words;
    el.innerHTML = `<span class="a">${addr}</span>${shown.length ? ` <span class="w">${shown.join(' ')}</span>` : ''}`;
    if (words.length > LISTING_WORDS) el.title = `${addr}  ${words.join(' ')}`;
    return el;
  }
}

/** Machine code beside each line: the address and the words in octal (toggled). */
const listingGutter = gutter({
  class: 'cm-listing-gutter',
  lineMarker(view, line) {
    const l = view.state.field(listingField).get(view.state.doc.lineAt(line.from).number);
    return l && (l.addr || l.words.length) ? new ListingMarker(l) : null;
  },
  lineMarkerChange: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setListing))),
  domEventHandlers: {
    mousedown(view, line) {
      view.dispatch({ selection: { anchor: line.from } });
      view.focus();
      return true;
    },
  },
});

/** Where a register dump says the code is: ◆ in the margin and a tint, with an explanation on hover. */
interface SnapLine {
  line: number;
  title: string;
}
const setSnap = StateEffect.define<SnapLine | null>();
const snapField = StateField.define<SnapLine | null>({
  create: () => null,
  update: (v, tr) => tr.effects.reduce((acc, e) => (e.is(setSnap) ? e.value : acc), v),
  provide: (f) =>
    EditorView.decorations.compute([f], (state) => {
      const s = state.field(f);
      if (!s || s.line < 1 || s.line > state.doc.lines) return Decoration.none;
      const from = state.doc.line(s.line).from;
      return Decoration.set([Decoration.line({ class: 'cm-snap-line', attributes: { title: s.title } }).range(from)]);
    }),
});

class SnapMarker extends GutterMarker {
  constructor(readonly title: string) {
    super();
  }
  override eq(o: SnapMarker): boolean {
    return o.title === this.title;
  }
  override toDOM(): Node {
    const el = document.createElement('span');
    el.textContent = '◆';
    el.title = this.title;
    return el;
  }
}
const snapGutter = gutter({
  class: 'cm-snap-gutter',
  lineMarker(view, line) {
    const s = view.state.field(snapField);
    return s && view.state.doc.lineAt(line.from).number === s.line ? new SnapMarker(s.title) : null;
  },
  lineMarkerChange: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setSnap))),
  initialSpacer: () => new SnapMarker(''),
});

/** What the linter needs from a build: the assembler's errors and warnings. */
export interface Lintable {
  errors: readonly Diag[];
  warnings?: readonly Diag[];
}

export interface EditorPanelOptions<R extends Lintable = Lintable> {
  parent: HTMLElement;
  initial: string;
  compile: (src: string) => R;
  onUpload: () => void;
  onChange: (src: string, result: R) => void;
  /** Syntax highlighting. */
  language: Extension[];
  /** The cursor moved to another line (1-based). */
  onCursor?: (line: number) => void;
}

export class EditorPanel<R extends Lintable = Lintable> {
  readonly view: EditorView;
  private execLine = 0;
  private cursorLine = 1;
  private listingOn = new Compartment();

  constructor(opts: EditorPanelOptions<R>) {
    const lint = linter(
      (view) => {
        const src = view.state.doc.toString();
        const res = opts.compile(src);
        opts.onChange(src, res);
        const diag = (e: Diag, severity: 'error' | 'warning'): Diagnostic => {
          const line = view.state.doc.line(Math.min(Math.max(1, e.line), view.state.doc.lines));
          return { from: line.from, to: line.to, severity, message: e.message };
        };
        return [...res.errors.map((e) => diag(e, 'error')), ...(res.warnings ?? []).map((e) => diag(e, 'warning'))];
      },
      { delay: 250 },
    );

    this.view = new EditorView({
      parent: opts.parent,
      state: EditorState.create({
        doc: opts.initial,
        extensions: [
          lineNumbers(),
          snapField,
          snapGutter,
          listingField,
          this.listingOn.of([]),
          history(),
          highlightActiveLine(),
          ...opts.language,
          lint,
          lintGutter(),
          execLineField,
          EditorView.updateListener.of((u) => {
            if (!opts.onCursor || (!u.selectionSet && !u.docChanged)) return;
            const line = u.state.doc.lineAt(u.state.selection.main.head).number;
            if (line !== this.cursorLine) opts.onCursor((this.cursorLine = line));
          }),
          keymap.of([
            { key: 'Mod-Enter', run: () => (opts.onUpload(), true) },
            { key: 'Mod-s', run: () => (opts.onUpload(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.theme(
            {
              '&': { height: '100%', backgroundColor: '#0b0f17', color: '#e6edf3', fontSize: '13px' },
              '.cm-content': { fontFamily: 'var(--mono)', caretColor: '#3affc8' },
              '.cm-gutters': { backgroundColor: '#0b0f17', color: '#4a5a70', border: 'none' },
              '.cm-activeLine': { backgroundColor: '#ffffff08' },
              '.cm-activeLineGutter': { backgroundColor: '#ffffff10' },
              '&.cm-focused .cm-cursor': { borderLeftColor: '#3affc8' },
              '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#3affc830 !important' },
              '.cm-exec-line': { backgroundColor: '#3affc822', boxShadow: 'inset 3px 0 0 #3affc8' },
              '.cm-snap-line': { backgroundColor: '#5ad0ff1c', boxShadow: 'inset 3px 0 0 #5ad0ff' },
              '.cm-snap-gutter .cm-gutterElement': { color: '#5ad0ff', padding: '0 2px', cursor: 'default' },
              '.cm-listing-gutter .cm-gutterElement': {
                fontSize: '11px',
                whiteSpace: 'pre',
                padding: '0 10px 0 4px',
                minWidth: '27ch',
                cursor: 'pointer',
              },
              '.cm-listing-gutter': { borderRight: '1px solid #1c2636' },
              '.cm-listing-gutter .a': { color: '#8796ad' },
              '.cm-listing-gutter .w': { color: '#ffd23a' },
            },
            { dark: true },
          ),
        ],
      }),
    });
  }

  get source(): string {
    return this.view.state.doc.toString();
  }

  setSource(src: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: src } });
  }

  /** Put the cursor on `line` (1-based), scroll it into view and focus the editor. */
  goToLine(line: number): void {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    this.view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
    this.view.focus();
  }

  /** Re-measure after the editor was hidden (slot switch). */
  refresh(): void {
    this.view.requestMeasure();
  }

  /** Show or hide the listing column (address and words in octal beside each line). */
  showListing(on: boolean): void {
    this.view.dispatch({ effects: this.listingOn.reconfigure(on ? listingGutter : []) });
  }

  /** The listing of the current build, by source line (1-based). */
  setListing(lines: ReadonlyMap<number, ListingLine>): void {
    this.view.dispatch({ effects: setListing.of(lines) });
  }

  /** Mark the line a register dump says runs next (null to clear). */
  setSnapMark(mark: SnapLine | null): void {
    this.view.dispatch({ effects: setSnap.of(mark) });
  }

  /** Highlight the line the CPU will execute next (0 to clear). */
  setExecLine(line: number): void {
    if (line === this.execLine) return;
    this.execLine = line;
    this.view.dispatch({ effects: setExecLine.of(line) });
  }
}
