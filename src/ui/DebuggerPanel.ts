import { PORTS } from '../core/ports';
import type { SimulationEngine } from '../core/SimulationEngine';
import { CpuState, Dir, ProgState, Status } from '../core/types';
import type { Slot } from '../core/vm/Compiler';
import type { Unit } from '../core/Unit';
import { TOOLS } from '../core/tools';
import { formatAddr } from '../core/vm/isa';
import { disassemble } from '../pdp11';
import { IO_REGISTERS } from '../core/machine/iopage';
import { ROM_EXPORTS } from '../core/machine/rom';
import { STACK11_WORDS } from '../core/downlink';
import { oct6, type RoverBuilds } from './toolchain';

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

  /** `builds`: the code on the rover (M15: source lines for the PDP-11 view). */
  constructor(private el: HTMLElement, private engine: SimulationEngine, private builds?: RoverBuilds) {}

  /** `slot`: the context to show (the Code tab's slot). */
  update(u: Unit, slot: Slot = 'firmware'): void {
    const html = u.machine ? this.pdpHtml(u, slot) : this.rasmHtml(u, slot);
    if (html !== this.lastHtml) {
      this.el.innerHTML = html;
      this.lastHtml = html;
    }
  }

  /** Devices working right now. */
  private busy(u: Unit, timer = 0): string {
    const busy: string[] = [];
    if (u.action?.kind === 'TOOL') busy.push(`${u.action.tool} ${u.action.ticksLeft}t`);
    else if (u.action?.kind === 'STEP') busy.push(`drive ${Dir[u.action.dir]} (${u.action.tilesLeft} left, ${u.action.ticksLeft}t${u.action.stop ? ', stopping' : ''})`);
    if (u.radarTicks) busy.push(`radar ${Dir[u.radarDir]}`);
    if (u.imgOp) busy.push(`${u.imgOp.kind} ${u.imgOp.ticksLeft}t`);
    if (timer) busy.push(`timer ${timer}t`);
    return busy.length ? busy.join(' · ') : 'devices idle';
  }

  /** Battery, hull and the other systems, cargo and hardpoints (both cores). */
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
    const st = u.vm.state;
    const cls = st === CpuState.RUNNING ? 'ok' : st === CpuState.BLOCKED ? 'info' : st === CpuState.HALTED ? 'warn' : 'bad';
    return `<span class="pill ${slot === 'program' ? (progCls[u.progState] ?? 'dim') : cls}">${slot === 'program' ? ProgState[u.progState] : st}</span>`;
  }

  // ---------------------------------------------------------------- M15: PDP-11 core

  private pdpHtml(u: Unit, slot: Slot): string {
    const m = u.machine!;
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
    const where = inRom ? `ROM ${[...PDP_NAMES].filter(([a]) => a <= pc && a >= 0o160000).sort((x, y) => y[0] - x[0])[0]?.[1] ?? ''}` : line ? `L${line}` : '';
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
      ${u.vm.state === CpuState.FAULT ? `<div class="fault">FAULT: ${esc(u.vm.faultReason)} — watchdog ${u.vm.watchdog}t</div>` : ''}
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

  // ---------------------------------------------------------------- Rover-ASM (until M15 slice 6)

  private rasmHtml(u: Unit, slot: Slot): string {
    const vm = slot === 'program' ? u.prog : u.vm;
    const ctx0 = slot === 'program' ? `PROGRAM${u.slice > 0 ? ` · slice ${u.slice}t left` : u.slice === 0 ? ' · no time limit' : ''}` : `FIRMWARE${u.slice >= 0 ? ' · in CALL PROGRAM' : ''}`;
    const regs = Array.from(vm.regs)
      .map((v, i) => `<div class="kv"><span>r${i}</span><b>${v}</b></div>`)
      .join('');
    const stack = (arr: number[], size: number, fmt: (v: number) => string) =>
      Array.from({ length: size }, (_, i) => `<span class="slot ${i < arr.length ? 'full' : ''}">${i < arr.length ? fmt(arr[i]) : '·'}</span>`).join('');
    const ipLine = (ip: number) => `${formatAddr(ip)} L${vm.lineAt(ip) || '?'}`;
    const ctx = this.engine.portCtx;
    const ports = PORTS.map((p) => {
      const v = p.read ? p.read(u, ctx) : '—';
      return `<div class="kv" title="${esc(p.description)}"><span>@${p.name}${p.write ? '<i>w</i>' : ''}</span><b>${v}</b></div>`;
    }).join('');
    return `
      <div class="dbg-row">
        ${this.statePill(u, slot)}
        <span class="pill ${vm.status === Status.OK ? 'dim' : 'warn'}">@STATUS ${Status[vm.status]}</span>
        <span class="pill dim">${ctx0}</span>
        <span class="dim">next ${formatAddr(vm.nextIp, slot)} L${vm.nextLine || '-'} · ${this.busy(u, vm.timer)}</span>
      </div>
      ${vm.state === CpuState.FAULT ? `<div class="fault">FAULT: ${esc(vm.faultReason)} — watchdog ${vm.watchdog}t</div>` : ''}
      ${this.hardwareHtml(u)}
      <h4>RAM <small>${u.ram.length} B, shared</small></h4>
      <div class="dim small mono">${Array.from(u.ram, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}</div>
      ${this.cargoHtml(u)}
      <h4>Registers</h4><div class="grid4">${regs}</div>
      <h4>Data stack <small>${vm.dataStack.length}/${u.chassis.dataStack}</small></h4><div class="stack">${stack(vm.dataStack, u.chassis.dataStack, String)}</div>
      <h4>Call stack <small>${vm.callStack.length}/${u.chassis.callStack}</small></h4><div class="stack">${stack(vm.callStack, u.chassis.callStack, ipLine)}</div>
      <h4>Ports</h4><div class="grid2">${ports}</div>
      <div class="dim small">instructions executed: ${vm.instructionsExecuted} · ${u.chassis.name}: ${u.chassis.cyclesPerTick} cycles/tick</div>
    `;
  }
}
