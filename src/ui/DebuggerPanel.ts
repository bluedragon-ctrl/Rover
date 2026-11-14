import { PORTS } from '../core/ports';
import type { SimulationEngine } from '../core/SimulationEngine';
import { CpuState, Dir, ProgState, Status } from '../core/types';
import type { Slot } from '../core/vm/Compiler';
import type { Unit } from '../core/Unit';
import { TOOLS } from '../core/tools';
import { formatAddr } from '../core/vm/isa';

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Admin-only, omniscient read-only view of a unit's CPU and hardware state (SPEC §3.8.4). */
export class DebuggerPanel {
  private lastHtml = '';

  constructor(private el: HTMLElement, private engine: SimulationEngine) {}

  /** `slot`: the context to show (the Code tab's slot). */
  update(u: Unit, slot: Slot = 'firmware'): void {
    const vm = slot === 'program' ? u.prog : u.vm;
    const ctx0 = slot === 'program' ? `PROGRAM${u.slice > 0 ? ` · slice ${u.slice}t left` : u.slice === 0 ? ' · no time limit' : ''}` : `FIRMWARE${u.slice >= 0 ? ' · in CALL PROGRAM' : ''}`;
    const progCls: Record<number, string> = { [ProgState.PROG_RUNNING]: 'ok', [ProgState.PROG_READY]: 'info', [ProgState.PROG_HALTED]: 'warn', [ProgState.PROG_FAULT]: 'bad' };
    const stateText = slot === 'program' ? ProgState[u.progState] : vm.state;
    const stateClass =
      vm.state === CpuState.RUNNING ? 'ok' : vm.state === CpuState.BLOCKED ? 'info' : vm.state === CpuState.HALTED ? 'warn' : 'bad';
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
    // M14 devices: what is working right now.
    const busy: string[] = [];
    if (u.action?.kind === 'TOOL') busy.push(`${u.action.tool} ${u.action.ticksLeft}t`);
    else if (u.action?.kind === 'STEP') busy.push(`drive ${Dir[u.action.dir]} (${u.action.tilesLeft} left, ${u.action.ticksLeft}t${u.action.stop ? ', stopping' : ''})`);
    if (u.radarTicks) busy.push(`radar ${Dir[u.radarDir]}`);
    if (u.imgOp) busy.push(`${u.imgOp.kind} ${u.imgOp.ticksLeft}t`);
    if (vm.timer) busy.push(`timer ${vm.timer}t`);
    const action = busy.length ? busy.join(' · ') : 'devices idle';
    const batPct = (u.energy * 100) / u.chassis.batteryCapacity;

    const html = `
      <div class="dbg-row">
        <span class="pill ${slot === 'program' ? (progCls[u.progState] ?? 'dim') : stateClass}">${stateText}</span>
        <span class="pill ${vm.status === Status.OK ? 'dim' : 'warn'}">@STATUS ${Status[vm.status]}</span>
        <span class="pill dim">${ctx0}</span>
        <span class="dim">next ${formatAddr(vm.nextIp, slot)} L${vm.nextLine || '-'} · ${action}</span>
      </div>
      ${vm.state === CpuState.FAULT ? `<div class="fault">FAULT: ${esc(vm.faultReason)} — watchdog ${vm.watchdog}t</div>` : ''}
      <div class="meters">
        <div class="meter"><label>BAT ${batPct.toFixed(1)}%</label><div><i style="width:${batPct}%;background:${batPct < 15 ? '#ff4d4d' : '#3affc8'}"></i></div></div>
        <div class="meter"><label>HULL ${u.hull}</label><div><i style="width:${u.hull}%;background:${u.hull < 30 ? '#ff4d4d' : '#5ad0ff'}"></i></div></div>
        <div class="meter"><label>SOLAR ${u.solarHealth}</label><div><i style="width:${u.solarHealth}%;background:${u.solarHealth < 50 ? '#ff4d4d' : '#5a7dff'}"></i></div></div>
        <div class="meter"><label>DISH ${u.antennaHealth}</label><div><i style="width:${u.antennaHealth}%;background:${u.antennaHealth < 50 ? '#ff4d4d' : '#3affc8'}"></i></div></div>
      </div>
      <div class="dim small" style="margin-top:4px">${u.temp} °C${u.heater ? ' · heaters on' : ''} · dust ${u.solarDust}% · watchdog ${u.wdt ? `${u.wdt}t` : 'off'}${u.preemptMask ? ` · preempt ${u.preemptMask}${u.batAlarm ? ` <${u.batAlarm}%` : ''}` : ''}</div>
      <div class="dim small">solar ${u.solarDeployed ? `+${u.lastSolarGain}/tick` : u.solarDeploy > 0 ? 'moving…' : 'stowed'} · signal ${this.engine.signalOf(u)} · log FIFO ${u.link.used}/${u.chassis.logFifoBytes} B · recorder ${u.link.recUsed}/${u.chassis.recorderBytes} B</div>
      <h4>RAM <small>${u.ram.length} B, shared</small></h4>
      <div class="dim small mono">${Array.from(u.ram, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}</div>
      <h4>Cargo <small>${u.cargo.filter((c) => !c).length} free · science ready ${u.link.products.length}</small></h4>
      <div class="stack">${u.cargo.map((c, i) => `<span class="slot cargo ${c ? 'full' : ''}" title="slot ${i}">${c ? esc(this.engine.registry.get(c)?.constName ?? String(c)) : '·'}</span>`).join('')}</div>
      <h4>Hardpoints</h4>
      <div class="stack">${u.chassis.tools.map((t, i) => `<span class="slot tool ${t ? 'full' : ''} ${u.action?.kind === 'TOOL' && u.action.tool === t ? 'busy' : ''}" title="TOOL_${i}">${i}:${t ? esc(TOOLS[t].name) : 'empty'}</span>`).join('')}</div>
      <h4>Registers</h4><div class="grid4">${regs}</div>
      <h4>Data stack <small>${vm.dataStack.length}/${u.chassis.dataStack}</small></h4><div class="stack">${stack(vm.dataStack, u.chassis.dataStack, String)}</div>
      <h4>Call stack <small>${vm.callStack.length}/${u.chassis.callStack}</small></h4><div class="stack">${stack(vm.callStack, u.chassis.callStack, ipLine)}</div>
      <h4>Ports</h4><div class="grid2">${ports}</div>
      <div class="dim small">instructions executed: ${vm.instructionsExecuted} · ${u.chassis.name}: ${u.chassis.cyclesPerTick} cycles/tick</div>
    `;
    if (html !== this.lastHtml) {
      this.el.innerHTML = html;
      this.lastHtml = html;
    }
  }
}
