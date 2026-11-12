import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { EditorState, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, gutter, GutterMarker, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import type { CompileResult } from '../core/vm/Compiler';
import { roverAsm, roverAsmHighlight } from './roverAsmLanguage';

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

/** Bytes per source line from the last compile (docs/SPEC.md §5.7). */
const setLineBytes = StateEffect.define<Record<number, number>>();
const lineBytesField = StateField.define<Record<number, number>>({
  create: () => ({}),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setLineBytes)) v = e.value;
    return v;
  },
});

class BytesMarker extends GutterMarker {
  constructor(readonly n: number) {
    super();
  }
  override eq(o: BytesMarker): boolean {
    return o.n === this.n;
  }
  override toDOM(): Node {
    return document.createTextNode(`${this.n}`);
  }
}

/** Gutter with each instruction's machine-code size; blank for comments, labels, directives. */
const bytesGutter = gutter({
  class: 'cm-bytes-gutter',
  lineMarker(view, line) {
    const n = view.state.field(lineBytesField)[view.state.doc.lineAt(line.from).number];
    return n ? new BytesMarker(n) : null;
  },
  lineMarkerChange: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setLineBytes))),
  initialSpacer: () => new BytesMarker(88),
});

export interface EditorPanelOptions {
  parent: HTMLElement;
  initial: string;
  compile: (src: string) => CompileResult;
  onUpload: () => void;
  onChange: (src: string, result: CompileResult) => void;
  /** Show the bytes-per-line gutter (in preview until approved for the game). */
  showBytes?: boolean;
}

export class EditorPanel {
  readonly view: EditorView;
  private execLine = 0;

  constructor(opts: EditorPanelOptions) {
    const lint = linter(
      (view) => {
        const src = view.state.doc.toString();
        const res = opts.compile(src);
        opts.onChange(src, res);
        if (opts.showBytes) view.dispatch({ effects: setLineBytes.of(res.lineBytes) });
        return res.errors.map((e): Diagnostic => {
          const line = view.state.doc.line(Math.min(Math.max(1, e.line), view.state.doc.lines));
          return { from: line.from, to: line.to, severity: 'error', message: e.message };
        });
      },
      { delay: 250 },
    );

    this.view = new EditorView({
      parent: opts.parent,
      state: EditorState.create({
        doc: opts.initial,
        extensions: [
          lineNumbers(),
          ...(opts.showBytes ? [lineBytesField, bytesGutter] : []),
          history(),
          highlightActiveLine(),
          roverAsm,
          roverAsmHighlight,
          lint,
          lintGutter(),
          execLineField,
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
              '.cm-bytes-gutter .cm-gutterElement': { color: '#7d8ca3', fontSize: '11px', padding: '0 6px 0 2px', textAlign: 'right' },
              '.cm-exec-line': { backgroundColor: '#3affc822', boxShadow: 'inset 3px 0 0 #3affc8' },
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

  /** Highlight the line the CPU will execute next (0 to clear). */
  setExecLine(line: number): void {
    if (line === this.execLine) return;
    this.execLine = line;
    this.view.dispatch({ effects: setExecLine.of(line) });
  }
}
