/**
 * Code tab / Comms review page (preview.html?editor=1): the Code tab with the machine-code
 * listing pane (SPEC §5.7.1) and the M11 "Dump program state" box, the Comms tab and the Mission
 * events strip, on a live headless engine at the game's panel widths.
 * Options: &slot=firmware, &program=<template name>, &width=<px>,
 * &comms=0 (the current game: old Console, no Dump box).
 */
import '../style.css';
import { DEFAULT_FIRMWARE, PROGRAM_TEMPLATES } from '../core/programs';
import { SimulationEngine, type UplinkCommand } from '../core/SimulationEngine';
import type { Slot } from '../core/vm/Compiler';
import { CodeWorkspace } from '../ui/CodeWorkspace';
import { CommsPanel } from '../ui/CommsPanel';
import { ConsolePanel } from '../ui/ConsolePanel';
import { hint, MISSION_EVENTS_HELP } from '../ui/hint';

export function mountUiLab(el: HTMLElement, q: URLSearchParams): void {
  const comms = q.get('comms') !== '0';
  const e = new SimulationEngine({ seed: 42 });
  const u = e.spawnUnit('Rover-1', 0, 0);
  e.cheats.freeUpload = true;
  const events: string[] = [];
  e.events.on('LOG', (m) => {
    if (!comms || m.category !== 'sent') events.push(`<div class="${m.level}">[t${e.tick}] ${m.message}</div>`);
  });
  events.push(`<div class="info">[t0] World seed 42. (Goals, weather and supplies appear here.)</div>`);
  e.upload(u, DEFAULT_FIRMWARE, { factory: true });
  const name = q.get('program') ?? 'Explorer';
  const program = PROGRAM_TEMPLATES[name] ?? PROGRAM_TEMPLATES.Explorer;
  const run = (n: number) => {
    for (let i = 0; i < n; i++) e.advanceTick();
  };
  run(5);
  e.uploadProgram(u, program);
  run(255);
  e.command(u, 'DUMP', 'program');
  e.command(u, 'DUMP_STACKS', 'firmware');
  run(80);
  // One request still on its way: shows the "waiting" state.
  e.command(u, 'DUMP', 'program');

  const width = Number(q.get('width')) || 520;
  el.hidden = false;
  el.innerHTML = `
    <div class="pl-head"><b>M11 · CODE TAB (DUMP STATE) · COMMS · REFERENCE RADIO · MISSION EVENTS</b>
      <span class="dim">live engine, seed 42, tick ${e.tick}: default firmware + ${name} program · ${comms ? '&comms=0 shows the current game' : 'current game (old Console)'}</span></div>
    <div class="ui-lab">
      <aside class="ui-side" style="width:${width}px"><div class="tabs"><button class="tab active">Code</button><button class="tab">${comms ? 'Comms' : 'Console'}</button></div>
        <div class="tabpane active"><div id="lab-code"></div></div></aside>
      <aside class="ui-side" style="width:${width}px"><div class="tabs"><button class="tab">Code</button><button class="tab active">${comms ? 'Comms' : 'Console'}</button></div>
        <div class="tabpane active"><div id="lab-console"></div></div>
        ${comms ? `<div id="log-head">Mission events${hint(MISSION_EVENTS_HELP, 'up')}</div>` : ''}<div id="log" class="lab-log"></div></aside>
    </div>`;
  const logEl = el.querySelector<HTMLElement>('#log')!;
  const log = (level: string, m: string) => events.push(`<div class="${level}">[t${e.tick}] ${m}</div>`);
  const send = (cmd: UplinkCommand, slot: Slot) => {
    const err = e.command(u, cmd, slot);
    if (err) log('warn', `Not sent: ${err}.`);
    return err;
  };
  const code = new CodeWorkspace({ el: el.querySelector('#lab-code')!, engine: e, rover: () => u, log, listing: true, inspect: comms ? send : undefined });
  if (q.get('slot') === 'firmware') code.setSlot('firmware');
  const con: { update(): void } = comms ? new CommsPanel(el.querySelector('#lab-console')!, e, () => u) : new ConsolePanel(el.querySelector('#lab-console')!, e, () => u, send);
  let shown = -1;
  const update = () => {
    e.advanceTick(); // 4 ticks/s, so requests sent from the page come back
    code.updateCost();
    code.updateInspect();
    con.update();
    if (events.length !== shown) {
      shown = events.length;
      logEl.innerHTML = events.slice(-200).join('');
      logEl.scrollTop = logEl.scrollHeight;
    }
  };
  update();
  setInterval(update, 250);
}
