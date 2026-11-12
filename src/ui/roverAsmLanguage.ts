import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { OPCODES } from '../core/vm/Compiler';

const OPS = new Set([...OPCODES, 'ALIAS', 'CONST']);

/** Minimal tokenizer for syntax highlighting. */
export const roverAsm = StreamLanguage.define<{ start: boolean }>({
  name: 'rover-asm',
  startState: () => ({ start: true }),
  token(stream, state) {
    if (stream.sol()) state.start = true;
    if (stream.eatSpace()) return null;
    if (stream.peek() === ';') {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^[A-Za-z_]\w*:/)) return 'labelName';
    if (stream.match('->')) return 'operator';
    if (stream.match(/^@[A-Za-z_]\w*/)) return 'propertyName';
    if (stream.match(/^-?(0x[0-9a-fA-F]+|\d+)/)) return 'number';
    const word = stream.match(/^[A-Za-z_]\w*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0].toUpperCase();
      if (state.start && OPS.has(w)) {
        state.start = false;
        return 'keyword';
      }
      state.start = false;
      if (/^R\d+$/.test(w)) return 'variableName';
      if (/^[A-Z][A-Z0-9_]*$/.test(word[0]) && word[0].length > 1) return 'atom';
      return 'variableName.special';
    }
    stream.next();
    return null;
  },
});

export const roverAsmHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.comment, color: '#5c6f86', fontStyle: 'italic' },
    { tag: t.keyword, color: '#3affc8', fontWeight: 'bold' },
    { tag: t.labelName, color: '#ffb020' },
    { tag: t.propertyName, color: '#5ad0ff' },
    { tag: t.number, color: '#ff8a65' },
    { tag: t.atom, color: '#d4a0ff' },
    { tag: t.variableName, color: '#e6edf3' },
    { tag: t.special(t.variableName), color: '#c9d1d9' },
    { tag: t.operator, color: '#8b949e' },
  ]),
);
