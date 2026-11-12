import { BALANCE } from '../core/balance';
import { BOOT_REASON_NAMES, decodeDump, decodeFrame, hex, SYSTEM_TAG, type ReceivedFrame } from '../core/downlink';
import type { SimulationEngine, UplinkCommand } from '../core/SimulationEngine';
import { Status } from '../core/types';
import type { Unit } from '../core/Unit';
import type { CompileResult } from '../core/vm/Compiler';

export type LogDictionary = CompileResult['logTags'];

/**
 * Decoded text of a received frame, like a defmt / spacecraft-EVR dictionary: tags are
 * named from the CONSTs the uploaded program logged them with (SPEC §3.8.3).
 */
export function describeFrame(f: ReceivedFrame, dict: LogDictionary, lineOf: (ip: number) => number = () => 0): string {
  const dump = decodeDump(f.bytes);
  if (dump) {
    const at = `snapshot t${f.taken ?? '?'}`;
    const ipText = (ip: number) => (lineOf(ip) ? `L${lineOf(ip)}` : `ip ${ip}`);
    if (dump.kind === 1) {
      const regs = dump.regs.map((v, i) => `r${i}=${v}`).join(' ');
      return `DUMP (${at}): next ${ipText(dump.ip)} · ${dump.state} · @STATUS ${Status[dump.status] ?? dump.status} · ${regs} · stacks ${dump.dsDepth}/${dump.csDepth}`;
    }
    const ds = dump.dataStack.length ? dump.dataStack.join(' ') : '(empty)';
    const cs = dump.callStack.length ? dump.callStack.map(ipText).join(' ') : '(empty)';
    return `STACKS (${at}): data [${ds}] · return to [${cs}]`;
  }
  const d = decodeFrame(f.bytes);
  if (d.kind === 1) return `science (type ${d.tag})`;
  if (d.tag === SYSTEM_TAG) {
    if (d.value !== null && BOOT_REASON_NAMES[d.value]) return `BOOT: ${BOOT_REASON_NAMES[d.value]}`;
    return `SYSTEM${d.value === null ? '' : ` = ${d.value}`}`;
  }
  const e = dict[d.tag];
  const name = e?.names.length ? e.names.join('/') : `tag ${d.tag}`;
  const lines = e?.lines.length ? ` (${e.lines.map((l) => `L${l}`).join(', ')})` : '';
  return `${name}${d.value === null ? '' : ` = ${d.value}`}${lines}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Mission control console: frames received over the downlink. */
export class ConsolePanel {
  private raw = false;
  private lastKey = '';
  private dictFor = { source: '\u0000', dict: {} as LogDictionary, lines: [] as number[] };
  private list: HTMLElement;
  private status: HTMLElement;
  private cost: HTMLElement;

  constructor(
    el: HTMLElement,
    private engine: SimulationEngine,
    private rover: () => Unit,
    onCommand: (cmd: UplinkCommand) => void,
  ) {
    el.innerHTML = `<div class="toolbar small">
        <label><input type="checkbox" id="console-raw" /> Raw hex</label>
        <span class="dim" id="console-status"></span>
      </div>
      <div class="toolbar small">
        <button data-cmd="DUMP" title="Uplink: the rover replies with IP, @STATUS, CPU state, registers and stack depths">Dump</button>
        <button data-cmd="DUMP_STACKS" title="Uplink: the rover replies with both stacks">Dump stacks</button>
        <button data-cmd="CONTINUE" title="Uplink: resume a CPU halted by BRK">Continue</button>
        <span class="dim" id="console-cost"></span>
      </div>
      <div id="console-list"></div>
      <p class="small dim">Mission control only knows what the rover sends. <code>LOG tag [value]</code> queues a frame in the
      ${engine.units[0]?.chassis.logFifoBytes ?? 32} B log FIFO; the dish sends ${BALANCE.linkBytesPerTick} B/tick at full signal
      (none below ${BALANCE.linkMinSignal}). Tags are named from your <code>CONST</code>s.
      <b>Dump</b> asks the rover for a snapshot of its CPU (sent before the log); <code>BRK</code> halts the CPU until
      <b>Continue</b>. Commands cost energy like a small upload.</p>`;
    this.list = el.querySelector('#console-list')!;
    this.status = el.querySelector('#console-status')!;
    this.cost = el.querySelector('#console-cost')!;
    el.querySelectorAll<HTMLButtonElement>('button[data-cmd]').forEach((b) => b.addEventListener('click', () => onCommand(b.dataset.cmd as UplinkCommand)));
    el.querySelector<HTMLInputElement>('#console-raw')!.addEventListener('change', (e) => {
      this.raw = (e.target as HTMLInputElement).checked;
      this.lastKey = '';
      this.update();
    });
  }

  /** Mission control knows the program it uploaded: its log dictionary and instruction lines. */
  private dictionary(u: Unit): typeof this.dictFor {
    if (this.dictFor.source !== u.sourceCode) {
      const res = this.engine.compileFor(u, u.sourceCode);
      this.dictFor = { source: u.sourceCode, dict: res.logTags, lines: res.program?.instrs.map((i) => i.line) ?? [] };
    }
    return this.dictFor;
  }

  update(): void {
    const u = this.rover();
    const link = u.link;
    this.status.textContent = `FIFO ${link.used}/${u.chassis.logFifoBytes} B · lost ${link.lost} · signal ${this.engine.signalOf(u)}`;
    const c = this.engine.commandCost(u);
    this.cost.textContent = c ? `uplink ≈ ${(c / 1000).toFixed(1)}% battery` : 'uplink free (admin)';
    const rx = this.engine.received;
    const key = `${rx.length}:${rx.at(-1)?.tick ?? 0}:${this.raw}:${u.sourceCode.length}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const { dict, lines } = this.dictionary(u);
    const lineOf = (ip: number) => lines[ip] ?? 0;
    const multi = this.engine.units.length > 1;
    const rows: string[] = [];
    for (const f of rx) {
      if (f.gap) rows.push(`<div class="warn">⚠ ${f.gap} frame${f.gap > 1 ? 's' : ''} lost (FIFO full)</div>`);
      const who = multi ? `${esc(this.engine.getUnit(f.unitId)?.name ?? `#${f.unitId}`)} ` : '';
      const text = this.raw ? '' : `${esc(describeFrame(f, dict, lineOf))} `;
      rows.push(`<div${f.taken !== undefined ? ' class="dump"' : ''}><span class="dim">t${f.tick}</span> ${who}${text}<span class="hex">${hex(f.bytes)}</span></div>`);
    }
    if (!rows.length) rows.push('<div class="dim">No frames received yet.</div>');
    const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
    this.list.innerHTML = rows.join('');
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;
  }
}
