/**
 * Shipped example code teaches line by line: every instruction (and data line) carries a
 * comment. Returns the lines that lack one. Bare labels, `NAME = value` assignments and
 * `.END` are exempt.
 */
export function uncommentedLines(src: string): string[] {
  return src.split('\n').filter((line) => {
    if (line.includes(';')) return false;
    const code = line.trim();
    return code !== '' && !/^[\w.$]+:$/.test(code) && !/^[\w.$]+\s*=/.test(code) && !/^\.END\b/i.test(code);
  });
}
