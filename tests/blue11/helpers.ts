import { assemble, SimpleMachine, type AssembleOptions, type MachineOptions } from '../../src/blue11';

/** Assemble at 001000, boot a SimpleMachine, run until HALT (or the budget). */
export function runAsm(src: string, opts: MachineOptions & { asm?: AssembleOptions; budget?: number } = {}) {
  const asm = assemble(src, opts.asm);
  if (!asm.ok) throw new Error(asm.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  const m = new SimpleMachine(opts);
  m.boot(asm);
  const result = m.run(opts.budget ?? 100000);
  return { m, cpu: m.cpu, asm, result };
}

/** Words of a one-line program. */
export function words(src: string, opts?: AssembleOptions): number[] {
  const a = assemble(src, opts);
  if (!a.ok) throw new Error(a.errors.map((e) => `${e.line}:${e.column} ${e.message}`).join('\n'));
  const out: number[] = [];
  for (let i = 0; i < a.bytes.length; i += 2) out.push(a.bytes[i] | (a.bytes[i + 1] << 8));
  return out;
}

export const o = (s: string): number => parseInt(s, 8);
