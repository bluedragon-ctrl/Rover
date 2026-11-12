import { GOALS } from '../core/EventDirector';
import type { SimulationEngine } from '../core/SimulationEngine';

export class GoalsPanel {
  private last = '';
  constructor(private el: HTMLElement, private engine: SimulationEngine) {}

  update(): void {
    const done = this.engine.director.completed;
    const html =
      `<p class="small dim">Goals give the sandbox direction and award science credits (spent on upgrades in a later milestone).</p>` +
      GOALS.map((g) => {
        const p = Math.min(g.target, g.progress(this.engine));
        const ok = done.has(g.id);
        return `<div class="goal ${ok ? 'done' : ''}"><b>${ok ? '✔ ' : ''}${g.title}<span>+${g.reward}</span></b><p>${g.description}</p>
          <div class="bar"><i style="width:${(p / g.target) * 100}%"></i></div><div class="small dim">${p} / ${g.target}</div></div>`;
      }).join('');
    if (html !== this.last) this.el.innerHTML = this.last = html;
  }
}
