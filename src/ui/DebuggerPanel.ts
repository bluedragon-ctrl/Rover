import { BALANCE } from '../core/balance';
import { PORTS } from '../core/ports';
import type { SimulationEngine } from '../core/SimulationEngine';
import { CpuState, Dir, Status } from '../core/types';
import type { Unit } from '../core/Unit';
import { TOOLS } from '../core/tools';

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

/** Read-only view of a unit's CPU and hardware state. */
export class DebuggerPanel {
  private lastHtml = '';

  constructor(private el: HTMLElement, private engine: SimulationEngine) {}

  update(u: Unit): void {
    const vm = u.vm;
    const prog = vm.program;
    const stateClass =
      vm.state === CpuState.RUNNING ? 'ok' : vm.state === CpuState.BLOCKED ? 'info' : vm.state === CpuState.FAULT ? 'bad' : 'bad';
    const regs = Array.from(vm.regs)
      .map((v, i) => `<div class="kv"><span>r${i}</span><b>${v}</b></div>`)
      .join('');
    const stack = (arr: number[], size: number, fmt: (v: number) => string) =>
      Array.from({ length: size }, (_, i) => `<span class="slot ${i < arr.length ? 'full' : ''}">${i < arr.length ? fmt(arr[i]) : '·'}</span>`).join('');
    const ipLine = (ip: number) => `L${prog?.instrs[ip]?.line ?? (prog?.instrs[0]?.line ?? '?')}`;
    const ctx = this.engine.portCtx;
    const ports = PORTS.map((p) => {
      const v = p.read ? p.read(u, ctx) : '—';
      return `<div class="kv" title="${esc(p.description)}"><span>@${p.name}${p.write ? '<i>w</i>' : ''}</span><b>${v}</b></div>`;
    }).join('');
    let action = 'idle';
    if (u.action?.kind === 'WAIT') action = `waiting ${u.action.ticksLeft}t`;
    else if (u.action?.kind === 'TOOL') action = `${u.action.tool} ${u.action.ticksLeft}t`;
    else if (u.action?.kind === 'STEP') action = `STEP ${Dir[u.action.dir]} (${u.action.tilesLeft} left, ${u.action.ticksLeft}t)`;
    const batPct = (u.energy * 100) / BALANCE.batteryCapacity;

    const html = `
      <div class="dbg-row">
        <span class="pill ${stateClass}">${vm.state}</span>
        <span class="pill ${vm.status === Status.OK ? 'dim' : 'warn'}">@STATUS ${Status[vm.status]}</span>
        <span class="dim">next L${vm.nextLine || '-'} · ${action}</span>
      </div>
      ${vm.state === CpuState.FAULT ? `<div class="fault">FAULT: ${esc(vm.faultReason)} — watchdog ${vm.watchdog}t</div>` : ''}
      <div class="meters">
        <div class="meter"><label>BAT ${batPct.toFixed(1)}%</label><div><i style="width:${batPct}%;background:${batPct < 15 ? '#ff4d4d' : '#3affc8'}"></i></div></div>
        <div class="meter"><label>HULL ${u.hull}</label><div><i style="width:${u.hull}%;background:${u.hull < 30 ? '#ff4d4d' : '#5ad0ff'}"></i></div></div>
      </div>
      <div class="dim small" style="margin-top:4px">solar ${u.solarDeployed ? `+${u.lastSolarGain}/tick` : u.solarDeploy > 0 ? 'moving…' : 'stowed'} · signal ${this.engine.signalOf(u)} · TX packets ${u.packetsSent}${u.lastTx ? ` · last TX ${u.lastTx.value} ${u.lastTx.ok ? 'ok' : 'failed'} @t${u.lastTx.tick}` : ''}</div>
      <h4>Cargo <small>${u.cargo.filter((c) => !c).length} free · science ready ${u.scienceReady}</small></h4>
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
