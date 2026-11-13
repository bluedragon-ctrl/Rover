/**
 * M10 slice 2 UI preview (preview.html?editor=1): the redesigned Code tab with the
 * machine-code listing pane (SPEC §5.7.1) and the Console, on a live headless engine,
 * at the game's panel widths. Kept as the review page for later Code tab / Console changes.
 * Options: &slot=firmware, &program=<template name>, &width=<px>.
 */
import '../style.css';
import { DEFAULT_FIRMWARE, PROGRAM_TEMPLATES } from '../core/programs';
import { SimulationEngine } from '../core/SimulationEngine';
import { CodeWorkspace } from '../ui/CodeWorkspace';
import { ConsolePanel } from '../ui/ConsolePanel';

export function mountUiLab(el: HTMLElement, q: URLSearchParams): void {
  const e = new SimulationEngine({ seed: 42 });
  const u = e.spawnUnit('Rover-1', 0, 0);
  e.cheats.freeUpload = true;
  e.upload(u, DEFAULT_FIRMWARE, { factory: true });
  const program = PROGRAM_TEMPLATES[q.get('program') ?? 'Explorer'] ?? PROGRAM_TEMPLATES.Explorer;
  e.uploadProgram(u, program, { factory: true });
  const run = (n: number) => {
    for (let i = 0; i < n; i++) e.advanceTick();
  };
  run(260);
  e.command(u, 'DUMP', 'program');
  e.command(u, 'DUMP_STACKS', 'firmware');
  run(80);

  const width = Number(q.get('width')) || 520;
  el.hidden = false;
  el.innerHTML = `
    <div class="pl-head"><b>M10 SLICE 2 · CODE TAB + LISTING · CONSOLE</b>
      <span class="dim">live engine, seed 42, tick ${e.tick}: default firmware + ${q.get('program') ?? 'Explorer'} program · click a listing row to jump to its line</span></div>
    <div class="ui-lab">
      <aside class="ui-side" style="width:${width}px"><div class="tabs"><button class="tab active">Code</button><button class="tab">Console</button></div>
        <div class="tabpane active"><div id="lab-code"></div></div></aside>
      <aside class="ui-side" style="width:${width}px"><div class="tabs"><button class="tab">Code</button><button class="tab active">Console</button></div>
        <div class="tabpane active"><div id="lab-console"></div></div></aside>
    </div>
    <pre class="ui-log" id="lab-log"></pre>`;
  const logEl = el.querySelector('#lab-log')!;
  const log = (level: string, m: string) => (logEl.textContent = `[${level}] ${m}\n${logEl.textContent}`);
  const code = new CodeWorkspace({ el: el.querySelector('#lab-code')!, engine: e, rover: () => u, log, listing: true });
  if (q.get('slot') === 'firmware') code.setSlot('firmware');
  code.updateCost();
  const con = new ConsolePanel(el.querySelector('#lab-console')!, e, () => u, (cmd, slot) => {
    const err = e.command(u, cmd, slot);
    if (err) log('warn', `Uplink rejected: ${err}.`);
  });
  con.update();
  setInterval(() => {
    code.updateCost();
    con.update();
  }, 250);
}
