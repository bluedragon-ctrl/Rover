import type { SimulationEngine } from '../core/SimulationEngine';
import type { Unit } from '../core/Unit';
import { UPGRADE_BY_ID, UPGRADES } from '../core/upgrades';

/** Shop: spend credits; each purchase arrives as a supply crate to pick up with the grabber. */
export class UpgradesPanel {

  constructor(private el: HTMLElement, private engine: SimulationEngine, private unit: () => Unit, onBuy: (msg: string | null, id: string) => void) {
    el.addEventListener('click', (ev) => {
      const id = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-buy]')?.dataset.buy;
      if (id) onBuy(this.engine.buyUpgrade(this.unit(), id), id);
    });
  }

  private built = false;
  private header!: HTMLElement;
  private cells = new Map<string, { card: HTMLElement; state: HTMLElement; html: string }>();

  /** Build the cards once; afterwards only changed parts are touched, so buttons never vanish under the cursor. */
  private build(): void {
    this.el.innerHTML = `
      <p class="small dim">Credits come from delivered science and goals. A purchase is dropped by parachute 3–6 tiles from the rover
      (@DROPS, @DROP_X, @DROP_Y) and is installed the moment the grabber picks it up (ACT TOOL_1 dir). Try the "Fetch supply crate" template.</p>
      <p class="small" id="upg-header"></p>`;
    this.header = this.el.querySelector('#upg-header')!;
    for (const up of UPGRADES) {
      const card = document.createElement('div');
      card.className = 'goal';
      const req = up.requires ? `<span class="dim"> · after ${UPGRADE_BY_ID[up.requires].title}</span>` : '';
      card.innerHTML = `<b>${up.title}<span>◆${up.cost}</span></b><p>${up.description}${req}</p><div class="small"></div>`;
      this.el.appendChild(card);
      this.cells.set(up.id, { card, state: card.querySelector('div.small')!, html: '' });
    }
    this.built = true;
  }

  update(): void {
    if (!this.built) this.build();
    const u = this.unit();
    const e = this.engine;
    const c = u.chassis;
    const head = `◆ <b>${e.credits}</b> credits · ${u.name}: Flash ${c.flashLines} · r0–r${c.registers - 1} · ${c.cyclesPerTick} cycles/tick · cargo ${c.cargoSlots} · battery ${c.batteryCapacity / 1000}% · LIDAR ${c.sensorRange} · solar ${c.solarPercent}% · TOOL_3 ${c.tools[3] ?? 'empty'}`;
    if (this.header.innerHTML !== head) this.header.innerHTML = head;
    for (const up of UPGRADES) {
      const cell = this.cells.get(up.id)!;
      const drop = e.drops.find((d) => d.upgrade === up.id);
      const installed = u.upgrades.includes(up.id);
      const blocker = e.upgradeBlocker(u, up.id);
      let html: string;
      if (installed) html = '<span class="ok">✔ installed</span>';
      else if (drop && !drop.landed) html = `<span class="info">in flight · lands in ${drop.landTick - e.tick}t at (${drop.x}, ${drop.y})</span>`;
      else if (drop) html = `<span class="warn">landed at (${drop.x}, ${drop.y}) — grab it</span>`;
      else html = `<button data-buy="${up.id}" ${blocker ? 'disabled' : ''} title="${blocker ?? 'Order a supply crate'}">Buy ◆${up.cost}</button>${blocker && !blocker.startsWith(`needs ${up.cost}`) ? ` <span class="dim">${blocker}</span>` : ''}`;
      if (html !== cell.html) {
        cell.state.innerHTML = cell.html = html;
        cell.card.classList.toggle('done', installed);
      }
    }
  }
}
