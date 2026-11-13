import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { EditorState, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
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

export interface EditorPanelOptions {
  parent: HTMLElement;
  initial: string;
  compile: (src: string) => CompileResult;
  onUpload: () => void;
  onChange: (src: string, result: CompileResult) => void;
  /** The cursor moved to another line (1-based): the listing follows it. */
  onCursor?: (line: number) => void;
}

export class EditorPanel {
  readonly view: EditorView;
  private execLine = 0;
  private cursorLine = 1;

  constructor(opts: EditorPanelOptions) {
    const lint = linter(
      (view) => {
        const src = view.state.doc.toString();
        const res = opts.compile(src);
        opts.onChange(src, res);
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
          history(),
          highlightActiveLine(),
          roverAsm,
          roverAsmHighlight,
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

  /** Highlight the line the CPU will execute next (0 to clear). */
  setExecLine(line: number): void {
    if (line === this.execLine) return;
    this.execLine = line;
    this.view.dispatch({ effects: setExecLine.of(line) });
  }
}
