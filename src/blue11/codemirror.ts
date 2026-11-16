/**
 * Optional entry point: Blue-11 assembly syntax highlighting for CodeMirror 6. Kept out of
 * index.ts so the core library has no dependencies at all.
 */
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { BY_NAME } from './isa';

const REGS = new Set(['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'SP', 'PC']);

/** Tokenizer: labels, mnemonics, directives, registers, numbers (octal / decimal), text. */
export const blue11Asm = StreamLanguage.define<{ op: boolean; text: boolean }>({
  name: 'blue11-asm',
  startState: () => ({ op: false, text: false }),
  token(stream, state) {
    if (stream.sol()) { state.op = false; state.text = false; }
    if (stream.eatSpace()) return null;
    const ch = stream.peek();
    if (ch === ';') { stream.skipToEnd(); return 'comment'; }
    if (state.text && ch && ch !== '<' && ch !== ',') {
      // .ASCII /text/: anything up to the same delimiter.
      stream.next();
      while (!stream.eol() && stream.next() !== ch) { /* consume */ }
      return 'string';
    }
    if (stream.match(/^([A-Za-z0-9.$_]+)\s*::?(?!=)/)) return 'labelName';
    if (stream.match(/^[0-9]+\$(?![A-Za-z0-9.$_])/)) return 'labelName'; // local label reference: 1$
    if (stream.match(/^'./) || stream.match(/^"../)) return 'string';
    if (stream.match(/^\^[DOB][0-9]+/i) || stream.match(/^\^X[0-9A-F]+/i) || stream.match(/^[0-9]+\.?(?![A-Za-z0-9$_])/)) return 'number';
    if (stream.match(/^%[0-7]/)) return 'variableName';
    if (stream.match(/^[#@]/)) return 'operator';
    const word = stream.match(/^[A-Za-z.$_][A-Za-z0-9.$_]*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0].toUpperCase();
      if (!state.op) {
        state.op = true;
        if (w.startsWith('.')) {
          state.text = w === '.ASCII' || w === '.ASCIZ';
          return 'keyword';
        }
        if (BY_NAME.has(w)) return 'keyword';
      }
      if (REGS.has(w)) return 'variableName';
      return 'atom';
    }
    stream.next();
    return 'operator';
  },
});

export const blue11Highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.comment, color: '#5c6f86', fontStyle: 'italic' },
    { tag: t.keyword, color: '#3affc8', fontWeight: 'bold' },
    { tag: t.labelName, color: '#ffb020' },
    { tag: t.number, color: '#ff8a65' },
    { tag: t.string, color: '#a5d6a7' },
    { tag: t.atom, color: '#d4a0ff' },
    { tag: t.variableName, color: '#5ad0ff' },
    { tag: t.operator, color: '#8b949e' },
  ]),
);
