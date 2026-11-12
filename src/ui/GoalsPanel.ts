import { GOALS } from '../core/EventDirector';
import { describeRequirements, EVENT_DEFS } from '../core/events';
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
      }).join('') +
      `<h4 class="evh">Storyteller events</h4><p class="small dim">Events unlock as you progress. Training versions come first and always arrive with a long warning on @ALERT.</p>` +
      EVENT_DEFS.map((d) => {
        const dir = this.engine.director;
        const open = dir.isUnlocked(d);
        const seen = dir.history[d.id] ?? 0;
        return `<div class="goal ${open ? 'done' : 'locked'}"><b>${open ? '' : '🔒 '}${d.title}${d.teaching ? ' <em>training</em>' : ''}<span>${seen ? `seen ×${seen}` : open ? 'unlocked' : ''}</span></b>
          <p>${d.description}</p><div class="small dim">${open ? `warning ${d.warnTicks} ticks · ${d.ticks} ticks long` : `requires ${describeRequirements(d.requires, (id) => GOALS.find((g) => g.id === id)?.title ?? id)}`}</div></div>`;
      }).join('');
    if (html !== this.last) this.el.innerHTML = this.last = html;
  }
}
