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

/** Names that became ROM routines, the program gate or the new WAIT instruction in M14: reserved since save v18. */
const M14_RESERVED = ['SLEEP', 'STEP', 'SCAN', 'ACT', 'USE', 'SNAP', 'SEND', 'ERASE', 'RUN', 'PROGRAM', 'WAIT', 'ABS', 'DIR_TO', 'PUT16', 'GET16', 'PLOT'];

/**
 * M14 (save v18, docs/ASSEMBLER_CORE.md §10): the hardware instructions became device ports
 * and ROM routines. Rewrite them mechanically: `STEP d n` → `CALL STEP d n`, `SCAN d -> a b` →
 * `CALL SCAN d` + `MOV a @RADAR_HIT` + `MOV b @RADAR_DIST`, `PEEK s -> d` → `LDB d [CARGO+s]`,
 * `MOV @TX_DATA v` → `LOG 0 v`, … A label stays on the first line of a rewrite, the comment too.
 * Player names that are now ROM routines (a label `step`) are renamed first (`step_`).
 */
export function migrateHardwareOps(src: string): string {
  const lines = src.split('\n');
  const split = (line: string) => {
    const semi = line.indexOf(';');
    return { code: semi >= 0 ? line.slice(0, semi) : line, comment: semi >= 0 ? line.slice(semi) : '' };
  };
  const HEAD = /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s*)?)([A-Za-z]+)(?![A-Za-z0-9_:])(.*)$/;

  // 1. Player names that clash with the new ROM routines.
  const clash = new Set<string>();
  for (const line of lines) {
    const { code } = split(line);
    const lm = /^\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(code);
    if (lm) clash.add(lm[1]);
    const dm = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s*)?(CONST|VAR|ALIAS)\s+(\S+)(?:\s+(\S+))?/i.exec(code);
    if (dm) clash.add(dm[1].toUpperCase() === 'ALIAS' ? (dm[3] ?? '') : dm[2]);
  }
  const renames = [...clash].filter((n) => M14_RESERVED.includes(n.toUpperCase()));
  const rename = (text: string) => renames.reduce((t, n) => t.replace(new RegExp(`(?<![@\\w])${n}(?!\\w)`, 'gi'), `${n}_`), text);

  const out: string[] = [];
  for (const line of lines) {
    const { code: raw, comment } = split(line);
    const m = HEAD.exec(raw);
    if (!m) {
      out.push(line);
      continue;
    }
    const prefix = rename(m[1]);
    const op = m[2].toUpperCase();
    const rest = rename(m[3]);
    const t = rest.trim().split(/[\s,]+/).filter((x) => x && x !== '->');
    const col = ' '.repeat(prefix.replace(/\t/g, '        ').length);
    let code: string[] | null = null;
    switch (op) {
      case 'SLEEP':
        code = [`CALL SLEEP ${t[0]}`];
        break;
      case 'STEP':
      case 'SNAP':
        code = [`CALL ${op} ${t[0]} ${t[1] ?? 1}`];
        break;
      case 'ACT':
        code = [`CALL ACT ${t[0]} ${t[1] ?? 0}`];
        break;
      case 'USE':
        code = [`CALL USE ${t[0]} ${t[1] ?? 'SYS_HULL'}`];
        break;
      case 'SEND':
        code = [`CALL SEND ${t[0] ?? 0}`];
        break;
      case 'ERASE':
        code = ['CALL ERASE'];
        break;
      case 'RUN':
        code = [`CALL RUN ${t[0]}`];
        break;
      case 'SCAN':
        code = [`CALL SCAN ${t[0]}`, `MOV ${t[1]} @RADAR_HIT`, `MOV ${t[2]} @RADAR_DIST`];
        break;
      case 'PEEK':
        code = [`LDB ${t[1]} [CARGO+${t[0]}]`];
        break;
      case 'MOV':
        if (t[0]?.toUpperCase() === '@TX_DATA' && t.length === 2) code = [`LOG 0 ${t[1]}`];
        break;
    }
    if (!code) {
      out.push(`${prefix}${m[2]}${rest}${comment}`);
      continue;
    }
    const first = `${prefix}${code[0]}`;
    // Keep the comment's column when the new code fits in front of it.
    const pad = first.length < raw.length ? ' '.repeat(raw.length - first.length) : ' ';
    out.push(comment ? `${first}${pad}${comment}` : first);
    for (const c of code.slice(1)) out.push(`${col}${c}`);
  }
  return out.join('\n');
}
