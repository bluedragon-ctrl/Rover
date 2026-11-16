/**
 * The Reference tab's shell (section tabs, panes, the filter box) and the sections that do not
 * depend on the instruction set: Tools and Image. The rest is in ReferenceBlue11.ts.
 */
import { BALANCE, CHASSIS_MK1, BLUE11 } from '../core/balance';
import { DEVICE_BLOCKS } from '../core/machine/iopage';
import { PHOTO_FORMATS_2X, photoBytes } from '../core/photos';
import { PROGRAM_TEMPLATES } from '../core/programs';
import { TOOLS } from '../core/tools';
import { imageBytes } from '../core/Unit';
import { ERROR_NAMES } from '../core/machine/names';
import { STATUS_NOTES } from './comms';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const o = (v: number) => (v & 0xffff).toString(8).padStart(6, '0');
const block = (key: string) => DEVICE_BLOCKS.find((b) => b.key === key)!;

/** A complete tool use, step by step (the Tools tab; a test runs it). */
export const TOOL_EXAMPLE = `      MOV  #EAST, R0  ; 1. what: the tile to the east
      MOV  #F.T0, R1  ; 2. which tool: the drill
      JSR  PC, ACT    ; 3. use it, wait until done
      BNE  FAILED     ; 4. not OK? R0 says why
      MOV  @#CRGFRE, R2 ;  OK: one cargo slot fewer`;

/** Tools: the hardpoints, the camera and field repair, from the tool table. */
export function toolsHtml(): string {
  const cost = (t: { ticks: number; energy: number }) => `<span class="dim">Takes ${t.ticks} ticks and ${t.energy / 1000}% of the battery.</span>`;
  const eg = (code: string, what: string) => `<br><span class="dim">e.g. <code>${esc(code)}</code> ; ${esc(what)}</span>`;
  const argCode = (arg: string) => (arg === 'dir' ? 'MOV #EAST, R0' : 'CLR R0');
  const argText = (arg: string) => (arg === 'dir' ? 'R0 = a direction' : 'R0 = a cargo slot');
  const hardpoints = CHASSIS_MK1.tools
    .map((id, i) => {
      if (!id)
        return `<tr><td><code>F.T${i}</code></td><td class="small">Empty on Mk-I: <code>ACT</code> answers <code>E.NOTL</code> (no tool). The upgrade fits the <b>${TOOLS.SEISMIC.name}</b> (R0 = a direction): ${esc(TOOLS.SEISMIC.description)} ${cost(TOOLS.SEISMIC)}${eg(`MOV #NORTH, R0 · MOV #F.T${i}, R1 · JSR PC, ACT`, 'listen for ore to the north')}</td></tr>`;
      const t = TOOLS[id];
      const what = t.arg === 'dir' ? `use the ${t.name.toLowerCase()} to the east` : `use the ${t.name.toLowerCase()} on cargo slot 0`;
      return `<tr><td><code>F.T${i}</code></td><td class="small"><b>${t.name}</b> (${argText(t.arg)}): ${esc(t.description)} ${cost(t)}${eg(`${argCode(t.arg)} · MOV #F.T${i}, R1 · JSR PC, ACT`, what)}</td></tr>`;
    })
    .join('');
  const errors = ['OK', 'E.INV', 'E.FULL', 'E.LOWP', 'E.NOTL', 'E.BUSY']
    .map((n) => `<tr><td><code>${n}</code></td><td class="small">${esc(STATUS_NOTES[ERROR_NAMES[n]])}</td></tr>`)
    .join('');
  return `
    <p class="small">The rover's arm carries its tools on <b>hardpoints</b>, numbered places where a tool can be mounted:
    <code>F.T0</code> … <code>F.T3</code>. Use a tool with the ROM routine <code>ACT</code>, in four steps:</p>
    <ol class="small">
      <li>Put in <code>R0</code> what the tool should work on: a <b>direction</b> (<code>NORTH</code>…<code>WEST</code>: the tile next
      to the rover that way) or a <b>cargo slot</b> (0, 1, …: an item the rover carries).</li>
      <li>Put in <code>R1</code> which tool: <code>F.T0</code> … <code>F.T3</code>.</li>
      <li><code>JSR PC, ACT</code>: it starts the tool and waits until the tool is done.</li>
      <li>Check <code>R0</code>: <code>OK</code>, or an error code saying why not (the table at the bottom).</li>
    </ol>
<pre class="small">${esc(TOOL_EXAMPLE)}</pre>
    <h4>Hardpoints (Mk-I)</h4>
    <table>${hardpoints}</table>
    <h4>Built in</h4>
    <table>
      <tr><td><code>JSR PC, SNAP</code></td><td class="small"><b>${TOOLS.CAMERA.name}</b> (R0 = a direction, R1 = the camera mode
      <code>F.M1</code>…<code>F.M5</code>): ${esc(TOOLS.CAMERA.description)} ${cost(TOOLS.CAMERA)}${eg('MOV #NORTH, R0 · MOV #F.M1, R1 · JSR PC, SNAP', 'a grey photo to the north')}</td></tr>
      <tr><td><code>JSR PC, USE</code></td><td class="small"><b>${TOOLS.USE_ITEM.name}</b> (R0 = a cargo slot, R1 = the part):
      ${esc(TOOLS.USE_ITEM.description)} ${cost(TOOLS.USE_ITEM)}${eg('CLR R0 · MOV #F.HULL, R1 · JSR PC, USE', 'mend the hull with what is in slot 0')}</td></tr>
    </table>
    <h4>One job at a time</h4>
    <p class="small">Driving, the tools, repair and the camera share the rover's body, so only one of them can work at a time:
    starting another answers <code>E.BUSY</code>. The radar is separate and can sweep while the rover drives.</p>
    <h4>What R0 can say</h4>
    <table>${errors}</table>
    <p class="small dim">Under the hood <code>ACT</code> writes <code>TOLARG</code>, then <code>GO</code> with the hardpoint as FN into
    <code>TOLCS</code> (${o(block('tol').base)}), waits for <code>DONE</code> and returns <code>TOLER</code>: see I/O page → Tools.</p>`;
}

const PIXEL_MEANING: Record<string, string> = {
  grey: 'grey 0–3',
  dither: 'grey 0–3',
  palette: 'colour 0–15 from a palette',
  rgb332: '<code>RRRGGGBB</code>: red in bits 7–5, green 4–2, blue 1–0',
};

/** Reading one pixel of a mode 1 / 2 photo, step by step (the Image tab; a test runs it). */
export const READ_PIXEL_EXAMPLE = `; grey of pixel x = R0, y = R1 into R2 (0-3)
      MOV  R1, R2       ; row: y × 16 bytes,
      ASL  R2           ;   four doublings
      ASL  R2
      ASL  R2
      ASL  R2
      MOV  R0, R3       ; + x / 4 (4 pixels
      ASR  R3           ;   a byte): two halvings
      ASR  R3
      ADD  R3, R2       ; the byte's offset
      ADD  #IMGBAS, R2  ; its address
      MOVB (R2), R2     ; the byte: 4 pixels
      MOV  R0, R3       ; which of the 4:
      BIC  #177774, R3  ;   k = x AND 3
1$:   DEC  R3           ; shift right 2k times
      BMI  2$
      ASR  R2
      ASR  R2
      BR   1$
2$:   BIC  #177774, R2  ; keep the low 2 bits`;

/** Image: image memory (SPEC §3.8.7, docs/IMAGE_MEMORY.md). Sizes and formats come from the game's tables. */
export function imageHtml(): string {
  const B = BALANCE;
  const f1 = PHOTO_FORMATS_2X[1];
  const row = (f1.w * f1.bpp) / 8;
  const examples = Object.keys(PROGRAM_TEMPLATES).filter((n) => n.startsWith('Image: '));
  const modes = Object.entries(PHOTO_FORMATS_2X)
    .map(([m, f]) => `<tr><td><code>F.M${m}</code></td><td>${f.w}×${f.h}</td><td>${8 / f.bpp}</td><td>${(f.w * f.bpp) / 8}</td><td>${photoBytes(Number(m))} B</td><td>${PIXEL_MEANING[f.kind]}</td></tr>`)
    .join('');
  return `
    <p class="small">A photo is a grid of dots, <b>pixels</b>, each a shade of grey (or a colour), stored as bytes in
    <b>image memory</b>. The camera does not send a photo by itself: it goes in three steps, and your program decides what
    happens in between.</p>
    <ol class="small">
      <li><b>Take it</b>: <code>JSR PC, SNAP</code> puts a photo into image memory (Tools tab).</li>
      <li><b>Change it</b> if you like: image memory is ordinary memory, read and write it with <code>MOV</code> / <code>MOVB</code>,
      or draw with <code>PLOT</code>.</li>
      <li><b>Send it</b>: <code>JSR PC, SNDIMG</code> sends it home through the recorder; it appears in the Gallery.</li>
    </ol>
    <pre class="ref-diagram">       SNAP              SNDIMG         downlink
camera ───► image memory ───► recorder ───► Gallery
              ▲     │
          MOV │     │ MOV
              └ your program</pre>
    <p class="small dim">Real rovers work the same way: Curiosity's cameras keep their images in their own memory, and only
    the products made from them go to Earth.</p>
    <h4>Routines and registers</h4>
    <table class="radio-kv">
      <tr><td><code>JSR PC, SNAP</code></td><td>R0 = direction, R1 = mode (<code>F.M1</code>…): take a photo into image memory, replacing what was there. ${B.snapTicks} ticks, ${B.snapEnergy} energy. Nothing is sent yet.</td></tr>
      <tr><td><code>IMGBAS</code></td><td>Where image memory starts (${o(BLUE11.imageBase)}). <code>IMGSIZ</code> says how many bytes it has.</td></tr>
      <tr><td><code>JSR PC, SNDIMG</code></td><td>R0 = photo type, or 0 for the mode of the last photo (<code>IMGTYP</code>): send image memory home through the recorder. Image memory is kept.</td></tr>
      <tr><td><code>JSR PC, ERASE</code></td><td>Make every byte 0 (black) and forget the last photo, e.g. before drawing. ${B.eraseTicks} ticks, ${B.eraseEnergy} energy.</td></tr>
      <tr><td><code>JSR PC, PLOT</code></td><td>R0 = x, R1 = y, R2 = grey 0–3: set one pixel of a 64×64 grey photo (modes 1 and 2). The easy way to draw.</td></tr>
    </table>
    <h4>Where a pixel is (modes 1 and 2: ${f1.w}×${f1.h} grey)</h4>
    <p class="small">x counts pixels from the left (0–${f1.w - 1}), y rows from the top (0–${f1.h - 1}). Each pixel has 4 shades
    (0 black, 1 dark grey, 2 light grey, 3 white), which takes 2 bits, so <b>one byte holds 4 pixels</b>. A row of ${f1.w} pixels is
    therefore ${row} bytes, the whole picture ${photoBytes(1)} bytes, stored row by row from the top.</p>
    <p class="small"><b>address = IMGBAS + y × ${row} + x ÷ 4</b> (rounded down). Multiply by ${row} with four <code>ASL</code>s,
    divide by 4 with two <code>ASR</code>s. Example: pixel x = 10, y = 3 is in byte 3 × ${row} + 2 = ${3 * row + 2}.</p>
    <h4>Inside a byte</h4>
    <p class="small">The leftmost of the 4 pixels is in the <b>lowest</b> two bits (bits 1–0), the next in bits 3–2, and so on.
    Which of the four a pixel is: <code>k = x AND 3</code>; it sits <code>2k</code> bits up.</p>
    <pre class="ref-diagram">bit:     7 6     5 4     3 2     1 0
       pixel 3 pixel 2 pixel 1 pixel 0     (k = x AND 3)
shift:    6       4       2       0</pre>
    <table class="radio-kv">
      <tr><td><code>000</code></td><td><code>00 00 00 00</code> four black pixels</td></tr>
      <tr><td><code>125</code></td><td><code>01 01 01 01</code> four dark grey</td></tr>
      <tr><td><code>252</code></td><td><code>10 10 10 10</code> four light grey</td></tr>
      <tr><td><code>377</code></td><td><code>11 11 11 11</code> four white</td></tr>
      <tr><td><code>003</code></td><td><code>00 00 00 11</code> the leftmost pixel white, the other three black</td></tr>
    </table>
    <h4>Reading a pixel, step by step</h4>
<pre class="small">${esc(READ_PIXEL_EXAMPLE)}</pre>
    <h4>Changing a pixel</h4>
    <table class="radio-kv">
      <tr><td>mask</td><td><code>3</code> shifted left <code>2k</code> times (<code>ASL</code>): the two bits of that pixel</td></tr>
      <tr><td>clear</td><td><code>BICB mask, (R2)</code>: the pixel becomes 0 (black), its neighbours stay</td></tr>
      <tr><td>set</td><td><code>BISB grey, (R2)</code> with the grey shifted left like the mask. Or just call <code>PLOT</code>, which does all of it</td></tr>
    </table>
    <h4>Camera modes and memory size</h4>
    <p class="small dim">Image memory is as big as the largest picture the camera can take: ${imageBytes(CHASSIS_MK1)} B on Mk-I,
    more with the camera upgrades (Upgrades tab). Bigger pictures take longer to send.</p>
    <table>
      <tr class="dim"><td>mode</td><td>picture</td><td>pixels a byte</td><td>bytes a row</td><td>size</td><td>a pixel is</td></tr>
      ${modes}
    </table>
    <h4>Good to know</h4>
    <table class="radio-kv">
      <tr><td>kept</td><td>Image memory keeps its contents through reboots and a flat battery, like a camera's memory card.
        Only a new photo or <code>ERASE</code> clears it, never <code>SNDIMG</code>.</td></tr>
      <tr><td>bounds</td><td>Stay inside the picture: an address past <code>IMGBAS</code> + <code>IMGSIZ</code> is a bus error (trap to 4).</td></tr>
      <tr><td>type</td><td>The photo type only says how mission control decodes the bytes: type 1 shows any bytes as a ${f1.w}×${f1.h} grey photo.</td></tr>
      <tr><td>labels</td><td>The Gallery labels what arrived: <b>raw</b> (as the camera took it), <b>edited</b> (changed by your code),
        <b>drawn</b> (no camera picture behind it).</td></tr>
      <tr><td>credits</td><td>Only the first photo sent after a picture, of the same type, earns photo credits, edited or not.
        The first lit <b>edited</b> photo in each camera mode earns +${BALANCE.editFirstBonus} more (goal <i>Darkroom</i>). Drawn pictures earn nothing. Anomaly flags are checked against the real tile.</td></tr>
      <tr><td>speed</td><td>A loop over a whole ${photoBytes(1)} B picture takes a few hundred ticks on Mk-I (${CHASSIS_MK1.cyclesPerTick} cycles per tick, about half for the program). Moving whole words handles two bytes at once.</td></tr>
    </table>
    <h4>Examples (Code tab → Program → template)</h4>
    <table class="radio-kv">
      ${examples.map((n) => `<tr><td>${esc(n.slice(7))}</td></tr>`).join('')}
    </table>`;
}

/** The Reference shell: section tabs, panes and the filter box . */
export function mountReference(el: HTMLElement, sections: readonly (readonly [string, string])[], panes: Record<string, string>): void {
  const SECTIONS = sections;
  el.innerHTML = `
    <div class="ref-head">
      <div class="ref-tabs">${SECTIONS.map(([id, label], i) => `<button class="ref-tab${i === 0 ? ' active' : ''}" data-ref="${id}">${label}</button>`).join('')}</div>
      <input class="ref-filter" type="search" placeholder="Filter…" title="Show only rows that contain this text" />
    </div>
    ${SECTIONS.map(([id], i) => `<div class="ref-pane${i === 0 ? ' active' : ''}" data-ref="${id}">${panes[id]}</div>`).join('')}`;

  const filter = el.querySelector<HTMLInputElement>('.ref-filter')!;
  const applyFilter = () => {
    const q = filter.value.trim().toLowerCase();
    const pane = el.querySelector<HTMLElement>('.ref-pane.active')!;
    pane.querySelectorAll<HTMLElement>('tr, .consts code').forEach((r) => {
      r.hidden = q !== '' && !r.textContent!.toLowerCase().includes(q);
    });
    // Hide headings whose table / list has nothing left to show.
    // A heading may have a line of explanation between it and its table: hide them together.
    pane.querySelectorAll<HTMLElement>('h4').forEach((h) => {
      const between: HTMLElement[] = [];
      let body = h.nextElementSibling as HTMLElement | null;
      while (body && body.tagName === 'P' && !body.classList.contains('consts')) {
        between.push(body);
        body = body.nextElementSibling as HTMLElement | null;
      }
      if (!body || (body.tagName !== 'TABLE' && !body.classList.contains('consts'))) return;
      const visible = body.querySelector(body.tagName === 'TABLE' ? 'tr:not([hidden])' : 'code:not([hidden])');
      h.hidden = body.hidden = q !== '' && !visible;
      for (const p of between) p.hidden = h.hidden;
    });
    // Hide a part heading (h3) when every section under it is hidden.
    pane.querySelectorAll<HTMLElement>('h3').forEach((h) => {
      let any = false;
      for (let n = h.nextElementSibling as HTMLElement | null; n && n.tagName !== 'H3'; n = n.nextElementSibling as HTMLElement | null)
        if (n.tagName === 'H4' && !n.hidden) any = true;
      h.hidden = q !== '' && !any;
    });
  };
  filter.addEventListener('input', applyFilter);
  el.querySelectorAll<HTMLButtonElement>('.ref-tab').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelectorAll('.ref-tab').forEach((x) => x.classList.toggle('active', x === b));
      el.querySelectorAll<HTMLElement>('.ref-pane').forEach((p) => p.classList.toggle('active', p.dataset.ref === b.dataset.ref));
      applyFilter();
    }),
  );
}
