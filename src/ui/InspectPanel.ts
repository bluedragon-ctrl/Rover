import { BALANCE } from '../core/balance';
import type { SentRecord, SimulationEngine, UplinkCommand } from '../core/SimulationEngine';
import { Status } from '../core/types';
import type { Unit } from '../core/Unit';
import type { Slot } from '../core/vm/Compiler';
import { formatAddr } from '../core/vm/isa';
import {
  addrText,
  costText,
  DictionaryCache,
  dumpHalted,
  dumpRunning,
  latestSnapshot,
  pendingRequests,
  registerDumpBytes,
  regLabel,
  replyTo,
  sentByBrk,
  snapKindOf,
  snapshotOutdated,
  STACK_DUMP_MIN_BYTES,
  STATE_NOTES,
  STATUS_NOTES,
  type Dictionaries,
  type Snapshot,
  type SnapKind,
} from './comms';
import { hint } from './hint';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const HELP = (slot: Slot) => `You cannot see inside the rover directly: you can only <b>ask</b> it for a <b>dump</b>.
  <br><br><b>▲ Dump registers</b> sends a small request <b>up</b> to the rover. The moment it arrives, the rover copies
  the ${slot}'s CPU state (the instruction it runs next, its state, <code>@STATUS</code> and the registers <code>r0</code>…)
  and sends it <b>down</b>, ahead of your <code>LOG</code> messages. It shows up here, and the next instruction is marked ◆ in the listing.
  <br><b>▲ Dump stacks</b> does the same for the data stack (<code>PUSH</code>) and the return addresses of <code>CALL</code>s.
  <br><br>A dump is only the ${slot}'s CPU, not the whole rover (battery, position… are ports: read them in code and <code>LOG</code> them).
  It is a photo of one moment: the ${slot} keeps running. Dump again to see it move.
  <br><br>The <b>Comms</b> tab shows every byte of a dump with a comment; <b>Reference → Radio</b> explains each field.
  <br><br><b>BRK</b> in your code is a breakpoint: it stops the ${slot}, and the rover sends a register dump by itself
  (<i>sent by BRK</i>), so you see where it stopped and its registers. <b>▶ Resume after BRK</b> lets it go on.
  ${slot === 'program' ? '<br><b>↻ Restart</b>: the program starts again from its first line.' : ''}
  <br><br>Every request costs a little battery and needs the dish to reach the orbiter.`;

/** Where a register dump says the code was, for the listing (0 = nothing to mark). */
export interface SnapMark {
  line: number;
  title: string;
}

/**
 * Code tab: "Dump program / firmware state" box (M11). Requests a dump of the edited slot's
 * registers or stacks (uplink DUMP / DUMP_STACKS), shows the newest dump that came down and what is
 * still on its way. Mission control only knows what the rover sent.
 */
export class InspectPanel {
  private cards: HTMLElement;
  private msg: HTMLElement;
  private cost: HTMLElement;
  private title: HTMLElement;
  private help: HTMLElement;
  private runAgain: HTMLButtonElement;
  private lastKey = '';
  private dicts: DictionaryCache;
  slot: Slot = 'program';
  /** Set by the Code tab: jump the editor to a line of the uploaded code. */
  onGoToLine?: (line: number) => void;
  /** Called when the register dump's line for the listing changes. */
  onMark?: (slot: Slot, mark: SnapMark | null) => void;
  private marks: Record<Slot, string> = { firmware: '', program: '' };

  constructor(
    el: HTMLElement,
    private engine: SimulationEngine,
    private rover: () => Unit,
    private send: (cmd: UplinkCommand, slot: Slot) => string | null,
    /** True while the editor holds exactly the code on the rover (line numbers match). */
    private draftIsUploaded: (slot: Slot) => boolean,
  ) {
    this.dicts = new DictionaryCache(engine);
    el.classList.add('panel-box', 'inspect');
    el.innerHTML = `
      <header><span><button class="fold" id="ins-fold" title="Fold the dumps away (the buttons stay)">▾</button><b id="ins-title"></b><span id="ins-help"></span></span>
        <span class="ins-ctl"><button data-cmd="CONTINUE" class="small" title="BRK pauses the code like a breakpoint: this lets it go on">▶ Resume after BRK</button><button data-cmd="RUN_AGAIN" class="small" id="ins-run-again" title="Start the program again from its first line">↻ Restart</button></span></header>
      <div class="ins-flow" aria-hidden="true">
        <span class="up">▲ you ask</span><i>→</i><span>the rover dumps its state at that moment</span><i>→</i><span class="down">▼ the dump comes down</span>
      </div>
      <div class="toolbar">
        <button data-cmd="DUMP" class="up" title="Ask the rover to send its registers: where it is in the code, its state, @STATUS and r0…">▲ Dump registers</button>
        <button data-cmd="DUMP_STACKS" class="up" title="Ask the rover to send the data stack and the CALL return addresses">▲ Dump stacks</button>
        <span class="dim small" id="ins-cost"></span>
      </div>
      <div class="ins-msg small" id="ins-msg" hidden></div>
      <div id="ins-cards"></div>`;
    this.cards = el.querySelector('#ins-cards')!;
    this.msg = el.querySelector('#ins-msg')!;
    this.cost = el.querySelector('#ins-cost')!;
    this.title = el.querySelector('#ins-title')!;
    this.help = el.querySelector('#ins-help')!;
    this.runAgain = el.querySelector('#ins-run-again')!;
    const fold = el.querySelector<HTMLButtonElement>('#ins-fold')!;
    fold.addEventListener('click', () => {
      const folded = el.classList.toggle('folded');
      fold.textContent = folded ? '▸' : '▾';
      fold.title = folded ? 'Show the dumps' : 'Fold the dumps away (the buttons stay)';
    });
    el.querySelectorAll<HTMLButtonElement>('button[data-cmd]').forEach((b) =>
      b.addEventListener('click', () => {
        const cmd = b.dataset.cmd as UplinkCommand;
        const err = this.send(cmd, cmd === 'RUN_AGAIN' ? 'program' : this.slot);
        this.msg.hidden = !err;
        this.msg.textContent = err ? `✗ Not sent: ${err}.` : '';
        this.lastKey = '';
        this.update();
      }),
    );
    this.cards.addEventListener('click', (e) => {
      const line = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]')?.dataset.goto;
      if (line) this.onGoToLine?.(Number(line));
    });
    this.setSlot('program');
  }

  setSlot(slot: Slot): void {
    this.slot = slot;
    this.title.textContent = `Dump ${slot} state`;
    this.help.innerHTML = hint(HELP(slot));
    this.runAgain.hidden = slot !== 'program';
    this.msg.hidden = true;
    this.lastKey = '';
    this.update();
  }

  update(): void {
    const u = this.rover();
    const c = this.engine.commandCost(u);
    this.cost.textContent = c ? `each ≈ ${costText(c)}` : 'requests free (admin)';
    this.runAgain.disabled = !u.programSource;
    const { d, changed } = this.dicts.get(u);
    const sig = this.engine.signalOf(u);
    const rx = this.engine.received;
    const key = `${this.slot}:${rx.length}:${rx.at(-1)?.tick}:${this.engine.sent.length}:${this.engine.sent.at(-1)?.tick}:${sig >= BALANCE.linkMinSignal}:${this.draftIsUploaded(this.slot)}:${Math.floor(this.engine.tick / 10)}`;
    if (key === this.lastKey && !changed) return;
    this.lastKey = key;
    this.cards.innerHTML = this.card('regs', u, d, sig) + this.card('stacks', u, d, sig);
    this.cards.hidden = !this.cards.innerHTML;
    this.updateMarks(u);
  }

  /** Waiting estimate: dumps go down first, one after the other, at the link's rate. */
  private eta(u: Unit, r: SentRecord, sig: number): string {
    const e = this.engine;
    const upTo = e.sent.indexOf(r);
    const ahead = e.sent.filter((x, i) => i <= upTo && x.unitId === u.id && !x.rejected && snapKindOf(x.kind) && !replyTo(x, e.received));
    if (!ahead.length) return '';
    let bytes = 0;
    let more = false;
    for (const x of ahead) {
      if (snapKindOf(x.kind) === 'regs') bytes += registerDumpBytes(u.chassis.registers);
      else {
        bytes += STACK_DUMP_MIN_BYTES;
        more = true;
      }
    }
    const perTick = (u.chassis.linkBytesPerTick * sig) / 100;
    const left = Math.ceil(bytes / perTick) - (e.tick - ahead[0].tick);
    return left > 0 ? `≈ ${left}${more ? '+' : ''} tick${left === 1 && !more ? '' : 's'} at signal ${sig}` : 'any moment now';
  }

  private card(kind: SnapKind, u: Unit, d: Dictionaries, sig: number): string {
    const e = this.engine;
    const slot = this.slot;
    const snap = latestSnapshot(e.received, u.id, slot, kind);
    const pending = pendingRequests(e.sent, e.received, u.id, slot, kind).filter((r) => !snap || r.tick > snap.taken);
    if (!snap && !pending.length) return '';
    const name = kind === 'regs' ? 'Registers' : 'Stacks';
    let wait = '';
    if (pending.length) {
      const r = pending[pending.length - 1];
      const why = sig < BALANCE.linkMinSignal ? `<span class="warn">no downlink: signal ${sig}, needs ${BALANCE.linkMinSignal}</span>` : this.eta(u, r, sig);
      wait = `<div class="ins-wait">▲ asked at t${r.tick}${pending.length > 1 ? ` (+${pending.length - 1} more)` : ''}: the dump is waiting on the rover · ${why}</div>`;
    }
    if (!snap) return `<div class="ins-card empty"><div class="snap-h">${name}</div>${wait}</div>`;
    const age = e.tick - snap.taken;
    const outdated = snapshotOutdated(snap, e.sent, u.id);
    const by = sentByBrk(snap.frame, e.sent) ? `<span class="warn">sent by BRK</span> at t${snap.taken}` : `dumped on the rover at t${snap.taken}`;
    const head = `<div class="snap-h">${name} <span class="dim">· ${by}, ${age} tick${age === 1 ? '' : 's'} ago</span></div>`;
    const old = outdated ? `<div class="warn small">New ${slot} code was uploaded since: addresses point into the old code.</div>` : '';
    return `<div class="ins-card ${outdated ? 'old' : ''}">${head}${old}${this.body(snap, d, outdated)}${wait}</div>`;
  }

  /** `line 9` as a link while the editor holds the uploaded code, else plain text. */
  private lineRef(line: number, slot: Slot): string {
    if (!line) return '';
    return this.draftIsUploaded(slot)
      ? `<button class="link" data-goto="${line}" title="Show this line in the editor">line ${line}</button>`
      : `<span class="dim" title="Your draft differs from the code on the rover">line ${line} of the uploaded code</span>`;
  }

  private body(s: Snapshot, d: Dictionaries, outdated: boolean): string {
    const dump = s.dump;
    const slot = dump.slot;
    if (dump.kind === 1) {
      const running = dumpRunning(dump.state);
      let next: string;
      if (!running) next = `<span class="dim">not running (finished or not started)</span>`;
      else {
        const line = outdated ? 0 : d[slot].lineAt(dump.ip);
        const brkLine = dumpHalted(dump.state) && !outdated ? d[slot].lineAt(dump.ip - 1) : 0;
        next = brkLine
          ? `stopped at the BRK on ${this.lineRef(brkLine, slot)}; continues at ${esc(formatAddr(dump.ip, slot))} ${this.lineRef(line, slot)}`
          : `${esc(formatAddr(dump.ip, slot))} ${this.lineRef(line, slot)}`;
      }
      const regs = dump.regs.map((v, i) => `<span><i>${esc(regLabel(i, slot, d))}</i>${v}</span>`).join('');
      const notes = [STATE_NOTES[dump.state], dump.status !== Status.OK ? `@STATUS: ${STATUS_NOTES[dump.status] ?? ''}` : ''].filter((x) => x);
      return `<div class="kv2"><i>next</i>${next}</div>
        <div class="kv2"><i>state</i>${esc(dump.state)} <span class="dim">· @STATUS</span> ${esc(Status[dump.status] ?? String(dump.status))} <span class="dim">· stacks ${dump.dsDepth}/${dump.csDepth}</span></div>
        ${notes.length ? `<div class="kv2 fc"><i></i>; ${esc(notes.join(' · '))}</div>` : ''}
        <div class="regs">${regs}</div>`;
    }
    const ds = dump.dataStack.length ? dump.dataStack.join(' ') : '<span class="dim">empty</span>';
    const cs = dump.callStack.length ? dump.callStack.map((a) => esc(outdated ? formatAddr(a, slot) : addrText(a, slot, d))).join(' ← ') : '<span class="dim">empty</span>';
    return `<div class="kv2"><i>data</i>${ds} <span class="dim">(top last)</span></div><div class="kv2"><i>returns</i>${cs}</div>`;
  }

  /** The listing marks the instruction the newest register dump of each slot says is next. */
  private updateMarks(u: Unit): void {
    const { d } = this.dicts.get(u);
    for (const slot of ['firmware', 'program'] as Slot[]) {
      const s = latestSnapshot(this.engine.received, u.id, slot, 'regs');
      let mark: SnapMark | null = null;
      if (s && s.dump.kind === 1 && dumpRunning(s.dump.state) && !snapshotOutdated(s, this.engine.sent, u.id) && this.draftIsUploaded(slot)) {
        const line = d[slot].lineAt(s.dump.ip);
        if (line) mark = { line, title: `◆ The ${slot} was about to run this instruction when the rover dumped its registers (t${s.taken}).` };
      }
      const key = mark ? `${mark.line}:${mark.title}` : '';
      if (key !== this.marks[slot]) {
        this.marks[slot] = key;
        this.onMark?.(slot, mark);
      }
    }
  }
}
