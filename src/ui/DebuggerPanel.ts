import type { SimulationEngine, Slot } from '../core/SimulationEngine';
import { CpuState, Dir, ProgState } from '../core/types';
import type { Unit } from '../core/Unit';
import { TOOLS } from '../core/tools';
import { disassemble } from '../pdp11';
import { IO_REGISTERS } from '../core/machine/iopage';
import { ROM_EXPORTS } from '../core/machine/rom';
import { STACK11_WORDS } from '../core/downlink';
import { oct6, type RoverBuilds } from './toolchain';
import { romRoutineAt } from './comms';

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Names the disassembler shows for addresses: I/O registers and ROM routines. */
const PDP_NAMES = new Map<number, string>([...IO_REGISTERS.filter((r) => !r.alias).map((r) => [r.addr, r.name] as [number, string]), ...Object.entries(ROM_EXPORTS).map(([n, a]) => [a, n] as [number, string])]);

/** PSW flag bits, high to low as DEC prints them. */
const FLAGS: [string, number, string][] = [
  ['T', 0o20, 'trace: trap after every instruction'],
  ['N', 0o10, 'negative: the last result had bit 15 set'],
  ['Z', 0o4, 'zero: the last result was 0'],
  ['V', 0o2, 'overflow: the last signed result did not fit'],
  ['C', 0o1, 'carry: the last unsigned result carried or borrowed'],
];

const signed = (v: number): number => ((v & 0xffff) ^ 0x8000) - 0x8000;

/** Admin-only, omniscient read-only view of a unit's CPU and hardware state (SPEC §3.8.4). */
export class DebuggerPanel {
  private lastHtml = '';

  /** `builds`: the code on the rover (source lines). */
  constructor(private el: HTMLElement, private engine: SimulationEngine, private builds?: RoverBuilds) {}

  /** `slot`: the context to show (the Code tab's slot). */
  update(u: Unit, slot: Slot = 'firmware'): void {
    const html = this.machineHtml(u, slot);
    if (html !== this.lastHtml) {
      this.el.innerHTML = html;
      this.lastHtml = html;
    }
  }

  /** Devices working right now. */
  private busy(u: Unit): string {
    const busy: string[] = [];
    if (u.action?.kind === 'TOOL') busy.push(`${u.action.tool} ${u.action.ticksLeft}t`);
    else if (u.action?.kind === 'STEP') busy.push(`drive ${Dir[u.action.dir]} (${u.action.tilesLeft} left, ${u.action.ticksLeft}t${u.action.stop ? ', stopping' : ''})`);
    if (u.radarTicks) busy.push(`radar ${Dir[u.radarDir]}`);
    if (u.imgOp) busy.push(`${u.imgOp.kind} ${u.imgOp.ticksLeft}t`);
    return busy.length ? busy.join(' · ') : 'devices idle';
  }

  /** Battery, hull and the other systems. */
  private hardwareHtml(u: Unit): string {
    const batPct = (u.energy * 100) / u.chassis.batteryCapacity;
    return `
      <div class="meters">
        <div class="meter"><label>BAT ${batPct.toFixed(1)}%</label><div><i style="width:${batPct}%;background:${batPct < 15 ? '#ff4d4d' : '#3affc8'}"></i></div></div>
        <div class="meter"><label>HULL ${u.hull}</label><div><i style="width:${u.hull}%;background:${u.hull < 30 ? '#ff4d4d' : '#5ad0ff'}"></i></div></div>
        <div class="meter"><label>SOLAR ${u.solarHealth}</label><div><i style="width:${u.solarHealth}%;background:${u.solarHealth < 50 ? '#ff4d4d' : '#5a7dff'}"></i></div></div>
        <div class="meter"><label>DISH ${u.antennaHealth}</label><div><i style="width:${u.antennaHealth}%;background:${u.antennaHealth < 50 ? '#ff4d4d' : '#3affc8'}"></i></div></div>
      </div>
      <div class="dim small" style="margin-top:4px">${u.temp} °C${u.heater ? ' · heaters on' : ''} · dust ${u.solarDust}% · watchdog ${u.wdt ? `${u.wdt}t` : 'off'}${u.preemptMask ? ` · preempt ${u.preemptMask}${u.batAlarm ? ` <${u.batAlarm}%` : ''}` : ''}</div>
      <div class="dim small">solar ${u.solarDeployed ? `+${u.lastSolarGain}/tick` : u.solarDeploy > 0 ? 'moving…' : 'stowed'} · signal ${this.engine.signalOf(u)} · log FIFO ${u.link.used}/${u.chassis.logFifoBytes} B · recorder ${u.link.recUsed}/${u.recorderBytes} B</div>`;
  }

  private cargoHtml(u: Unit): string {
    return `
      <h4>Cargo <small>${u.cargo.filter((c) => !c).length} free · science ready ${u.link.products.length}</small></h4>
      <div class="stack">${u.cargo.map((c, i) => `<span class="slot cargo ${c ? 'full' : ''}" title="slot ${i}">${c ? esc(this.engine.registry.get(c)?.constName ?? String(c)) : '·'}</span>`).join('')}</div>
      <h4>Hardpoints</h4>
      <div class="stack">${u.chassis.tools.map((t, i) => `<span class="slot tool ${t ? 'full' : ''} ${u.action?.kind === 'TOOL' && u.action.tool === t ? 'busy' : ''}" title="TOOL_${i}">${i}:${t ? esc(TOOLS[t].name) : 'empty'}</span>`).join('')}</div>`;
  }

  private statePill(u: Unit, slot: Slot): string {
    const progCls: Record<number, string> = { [ProgState.PROG_RUNNING]: 'ok', [ProgState.PROG_READY]: 'info', [ProgState.PROG_HALTED]: 'warn', [ProgState.PROG_FAULT]: 'bad' };
    const st = u.cpu.state;
    const cls = st === CpuState.RUNNING ? 'ok' : st === CpuState.BLOCKED ? 'info' : st === CpuState.HALTED ? 'warn' : 'bad';
    return `<span class="pill ${slot === 'program' ? (progCls[u.progState] ?? 'dim') : cls}">${slot === 'program' ? ProgState[u.progState] : st}</span>`;
  }

  private machineHtml(u: Unit, slot: Slot): string {
    const m = u.machine;
    const { r, psw } = m.registers(slot);
    const pc = r[7];
    const ctxName = m.context;
    const here = slot === 'program' ? ctxName === 'program' : ctxName !== 'program';
    const ctx0 =
      slot === 'program'
        ? `PROGRAM${u.slice > 0 ? ` · slice ${u.slice}t left` : u.slice === 0 ? ' · no time limit' : ''}${ctxName === 'handler' ? ' · a firmware handler runs' : ''}`
        : `FIRMWARE${ctxName === 'handler' ? ' · handler in the program\'s time' : u.slice >= 0 ? ' · the program has the CPU' : ''}`;
    const line = this.builds?.lineAt(u, slot, pc) ?? 0;
    const inRom = pc >= 0o160000 && pc < 0o170000;
    const dis = disassemble((a) => m.peek(a) ?? 0, pc, { nameOf: (a) => PDP_NAMES.get(a) });
    const where = inRom ? `ROM ${romRoutineAt(pc)}` : line ? `L${line}` : '';
    const reg = (i: number) => {
      const name = i === 6 ? 'SP' : i === 7 ? 'PC' : `R${i}`;
      return `<div class="kv" title="${signed(r[i])} (signed decimal), ${r[i]} unsigned"><span>${name}</span><b>${oct6(r[i])}</b></div>`;
    };
    const flags = FLAGS.map(([n, bit, t]) => `<span class="flag ${psw & bit ? 'on' : ''}" title="${n}: ${t}">${n}</span>`).join('');
    const mode = (psw >> 14) & 3;
    const st = m.stackWords(slot, STACK11_WORDS);
    const stack = st.words.length
      ? st.words.map((w, i) => `<span class="slot full" title="${oct6(st.sp + 2 * i)}${i === 0 ? ' (SP)' : ''}">${oct6(w)}</span>`).join('')
      : '<span class="dim small">empty</span>';
    const io = m.ioSnapshot()
      .map(({ reg, value }) => `<div class="kv" title="${oct6(reg.addr)} ${reg.access}: ${esc(reg.description)}"><span>${reg.name}${reg.access === 'RO' ? '' : '<i>w</i>'}</span><b>${oct6(value)}</b></div>`)
      .join('');
    const meter = m.meter;
    const budget = this.engine.cyclesPerTick(u);
    return `
      <div class="dbg-row">
        ${this.statePill(u, slot)}
        <span class="pill dim">${ctx0}</span>
        <span class="dim">${here ? 'next' : 'resumes at'} ${oct6(pc)}${where ? ` ${esc(where)}` : ''} · ${this.busy(u)}</span>
      </div>
      <div class="dbg-next mono small"><span class="dim">${oct6(pc)}</span> ${esc(dis.text)}</div>
      ${u.cpu.state === CpuState.FAULT ? `<div class="fault">FAULT: ${esc(u.cpu.faultReason)} — watchdog ${u.cpu.watchdog}t</div>` : ''}
      ${this.hardwareHtml(u)}
      <h4>Registers <small>octal; hover for decimal</small></h4><div class="grid4">${[0, 1, 2, 3, 4, 5, 6, 7].map(reg).join('')}</div>
      <div class="dbg-psw small"><span class="dim">PSW</span> <b class="mono">${oct6(psw)}</b> · priority ${(psw >> 5) & 7} · ${mode === 3 ? 'user (program mode)' : 'kernel'} · <span class="flags">${flags}</span></div>
      <h4>Stack <small>SP ${oct6(st.sp)} · ${st.words.length} word${st.words.length === 1 ? '' : 's'} up to ${slot === 'program' ? 'the top of core' : 'the program base'}${st.words.length === STACK11_WORDS ? ' (first ' + STACK11_WORDS + ')' : ''}</small></h4>
      <div class="stack">${stack}</div>
      ${this.cargoHtml(u)}
      <h4>I/O page <small>w = writable</small></h4><div class="grid2">${io}</div>
      <div class="dim small">cycles this tick ${meter.tick}/${budget} · peak ${meter.peak} · ${u.chassis.name}: core ${m.coreBytes / 1024} KB</div>
    `;
  }
}
