/**
 * Mechanical rewrites of player source code when the language changes, applied to saved
 * code on load (SaveManager) and kept small and line-based: labels, spacing and comments
 * stay where they were.
 */

/** One line: `[label:] OP a, b ; comment`, with the parts needed to rebuild it. */
const LINE = /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s*)?)([A-Za-z]+)(\s+)([^\s,;]+)([\s,]+)([^\s,;]+)(.*)$/;

/**
 * M14 (save v17): image memory moved into the data address space at IMG, and LDB / STB take a
 * bracketed address. `LDB d a` → `LDB d [IMG+a]`, `STB a v` → `STB [IMG+a] v`. Old addresses
 * wrapped modulo the memory size; the new ones fault outside it.
 */
export function migrateImageMemory(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const m = LINE.exec(line);
      if (!m) return line;
      const op = m[2].toUpperCase();
      if (op === 'LDB' && !m[6].startsWith('[')) return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}[IMG+${m[6]}]${m[7]}`;
      if (op === 'STB' && !m[4].startsWith('[')) return `${m[1]}${m[2]}${m[3]}[IMG+${m[4]}]${m[5]}${m[6]}${m[7]}`;
      return line;
    })
    .join('\n');
}
