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

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const o = (v: number) => (v & 0xffff).toString(8).padStart(6, '0');
const block = (key: string) => DEVICE_BLOCKS.find((b) => b.key === key)!;

/** Tools: the hardpoints, the camera and field repair, from the tool table. */
export function toolsHtml(): string {
  const cost = (t: { ticks: number; energy: number }) => `<span class="dim">${t.ticks} ticks, ${t.energy / 1000}% battery</span>`;
  const hardpoints = CHASSIS_MK1.tools
    .map((id, i) => {
      if (!id) return `<tr><td><code>F.T${i}</code></td><td>empty hardpoint: <code>E.NOTL</code>. With the upgrade: <b>${TOOLS.SEISMIC.name}</b> (R0 = a direction): ${esc(TOOLS.SEISMIC.description)} ${cost(TOOLS.SEISMIC)}</td></tr>`;
      const t = TOOLS[id];
      return `<tr><td><code>F.T${i}</code></td><td><b>${t.name}</b> (R0 = ${t.arg === 'dir' ? 'a direction' : 'a cargo slot'}): ${esc(t.description)} ${cost(t)}</td></tr>`;
    })
    .join('');
  return `
    <h4>Hardpoints (Mk-I)</h4>
    <p class="small dim"><code>JSR PC, ACT</code> with R0 = the argument and R1 = the hardpoint <code>F.T0</code>…<code>F.T3</code> uses that tool:
    the ROM writes <code>TOLARG</code> and <code>GO</code> with the hardpoint as FN to <code>TOLCS</code> (${o(block('tol').base)}), waits for
    <code>DONE</code> and returns <code>TOLER</code> in R0. Drive, tools, repair and camera share the chassis: one at a time
    (<code>E.BUSY</code>).</p>
    <table>${hardpoints}</table>
    <h4>Built-in</h4>
    <table>
      <tr><td><code>JSR PC, SNAP</code><br><span class="dim">R0 dir, R1 F.M1…F.M5</span></td><td><b>${TOOLS.CAMERA.name}</b>: ${esc(TOOLS.CAMERA.description)} ${cost(TOOLS.CAMERA)}</td></tr>
      <tr><td><code>JSR PC, USE</code><br><span class="dim">R0 slot, R1 F.HULL / F.SOL / F.ANT</span></td><td><b>${TOOLS.USE_ITEM.name}</b>: ${esc(TOOLS.USE_ITEM.description)} ${cost(TOOLS.USE_ITEM)}</td></tr>
    </table>`;
}

const PIXEL_MEANING: Record<string, string> = {
  grey: 'grey 0–3',
  dither: 'grey 0–3',
  palette: 'palette 0–15',
  rgb332: '<code>RRRGGGBB</code>: red in bits 7–5, green 4–2, blue 1–0',
};

/** Image: image memory (SPEC §3.8.7, docs/IMAGE_MEMORY.md). Sizes and formats come from the game's tables. */
export function imageHtml(): string {
  const B = BALANCE;
  const f1 = PHOTO_FORMATS_2X[1];
  const row = (f1.w * f1.bpp) / 8;
  const examples = Object.keys(PROGRAM_TEMPLATES).filter((n) => n.startsWith('Image: '));
  const modes = Object.entries(PHOTO_FORMATS_2X)
    .map(([m, f]) => `<tr><td>${m}</td><td>${f.w}×${f.h}</td><td>${8 / f.bpp}</td><td>${(f.w * f.bpp) / 8}</td><td>${photoBytes(Number(m))} B</td><td>${PIXEL_MEANING[f.kind]}</td></tr>`)
    .join('');
  return `
    <p class="small dim">The camera does not send a photo by itself. Taking a picture, changing it and sending it are
    three steps, and your program decides what happens in between. Real rovers work the same way: Curiosity's cameras keep
    their images in their own memory, and only the products made from them go to Earth.</p>
    <pre class="ref-diagram">       SNAP              SNDIMG         downlink
camera ───► image memory ───► recorder ───► Gallery
              ▲     │
          MOV │     │ MOV
              └ your program</pre>
    <h4>Routines and registers</h4>
    <table class="radio-kv">
      <tr><td><code>JSR PC, SNAP</code></td><td>R0 = direction, R1 = mode (<code>F.M1</code>…): photograph into image memory (overwrites all of it). ${B.snapTicks} ticks, ${B.snapEnergy} energy. Nothing is sent yet.</td></tr>
      <tr><td><code>IMGBAS</code></td><td>Image memory starts at ${o(BLUE11.imageBase)}: read and write it with <code>MOV</code> / <code>MOVB</code> and every addressing mode. <code>IMGSIZ</code> says how big it is.</td></tr>
      <tr><td><code>JSR PC, SNDIMG</code></td><td>R0 = photo type (0: the last photo's mode, <code>IMGTYP</code>): send image memory home through the recorder as <code>T.IMG</code> messages. Image memory is kept.</td></tr>
      <tr><td><code>JSR PC, ERASE</code></td><td>Set every byte to 0 and forget the last photo. ${B.eraseTicks} ticks, ${B.eraseEnergy} energy.</td></tr>
      <tr><td><code>JSR PC, PLOT</code></td><td>R0 = x, R1 = y, R2 = grey 0–3: set one pixel of a 64×64 grey photo.</td></tr>
    </table>
    <h4>Rows and addresses (modes 1 and 2: ${f1.w}×${f1.h} grey)</h4>
    <p class="small">Stored row by row, top row first. A pixel has 4 grey levels (2 bits), so <b>one byte holds 4 pixels</b>:
    a row of ${f1.w} pixels is ${row} bytes, the picture ${photoBytes(1)} bytes. <b>address = IMGBAS + y × ${row} + x / 4</b>
    (rounded down): four <code>ASL</code>s for y, two <code>ASR</code>s for x. Pixel (10, 3) is in byte 3 × ${row} + 2 = ${3 * row + 2}.</p>
    <h4>Inside a byte: little-endian</h4>
    <p class="small">The leftmost pixel is in the <b>low</b> bits, like the low byte of a word comes first. A word read with
    <code>MOV</code> holds eight pixels in order from bit 0 up.</p>
    <pre class="ref-diagram">bit:     7 6     5 4     3 2     1 0
       pixel 3 pixel 2 pixel 1 pixel 0     (x AND 3 tells which)
shift:    6       4       2       0</pre>
    <table class="radio-kv">
      <tr><td><code>000</code></td><td><code>00 00 00 00</code> four black pixels</td></tr>
      <tr><td><code>125</code></td><td><code>01 01 01 01</code> four dark grey</td></tr>
      <tr><td><code>252</code></td><td><code>10 10 10 10</code> four light grey</td></tr>
      <tr><td><code>377</code></td><td><code>11 11 11 11</code> four white</td></tr>
      <tr><td><code>003</code></td><td><code>00 00 00 11</code> pixel 0 white, the other three black</td></tr>
    </table>
    <h4>Pixel recipes</h4>
    <p class="small dim">Pixel <code>k</code> = <code>x AND 3</code> sits <code>2k</code> bits up. Example: byte <code>330</code> = <code>11 01 10 00</code>, pixel 2 (shift 4) is 1.</p>
    <table class="radio-kv">
      <tr><td>read</td><td>shift right <code>2k</code> times (<code>ASR</code>), then <code>BIC #177774</code> keeps the low two bits</td></tr>
      <tr><td>mask</td><td><code>3</code> shifted left <code>2k</code> times (<code>ASL</code>)</td></tr>
      <tr><td>clear</td><td><code>BICB mask, (R1)</code></td></tr>
      <tr><td>set</td><td><code>BISB grey, (R1)</code> with the grey shifted like the mask (the ROM's <code>PLOT</code> does all of it)</td></tr>
    </table>
    <h4>Camera modes and memory size</h4>
    <p class="small dim">Image memory is as big as the largest picture the camera can take: ${imageBytes(CHASSIS_MK1)} B on Mk-I,
    more with the camera upgrades (Upgrades tab). Bigger pictures take longer to send. Grey: 0 black … 3 white.</p>
    <table>
      <tr class="dim"><td>mode</td><td>picture</td><td>px/byte</td><td>B/row</td><td>size</td><td>pixel</td></tr>
      ${modes}
    </table>
    <h4>Things to know</h4>
    <table class="radio-kv">
      <tr><td>keeps</td><td>Image memory keeps its contents through reboots and a flat battery, like a camera's flash memory.
        Only a new photo or <code>ERASE</code> clears it, never <code>SNDIMG</code>.</td></tr>
      <tr><td>bounds</td><td>Stay inside the picture: an address past <code>IMGBAS</code> + <code>IMGSIZ</code> is a bus error (trap to 4).</td></tr>
      <tr><td>type</td><td>The photo type only says how mission control decodes the bytes: type 1 shows any bytes as a ${f1.w}×${f1.h} grey photo.</td></tr>
      <tr><td>labels</td><td>The Gallery labels what arrived: <b>raw</b> (the bytes the camera took), <b>edited</b> (changed),
        <b>drawn</b> (no camera picture behind it).</td></tr>
      <tr><td>credits</td><td>Only the first photo sent after a picture, of the same type, earns photo credits, edited or not.
        The first lit <b>edited</b> photo in each camera mode earns +${BALANCE.editFirstBonus} more (goal <i>Darkroom</i>). Drawn pictures earn nothing. Anomaly flags are checked against the real tile.</td></tr>
      <tr><td>speed</td><td>A loop over a whole ${photoBytes(1)} B picture takes a few hundred ticks on Mk-I (${CHASSIS_MK1.cyclesPerTick} cycles per tick, about half for the program). Word moves touch two bytes at once.</td></tr>
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
    pane.querySelectorAll<HTMLElement>('h4').forEach((h) => {
      const body = h.nextElementSibling as HTMLElement | null;
      if (!body || (body.tagName !== 'TABLE' && !body.classList.contains('consts'))) return;
      const visible = body.querySelector(body.tagName === 'TABLE' ? 'tr:not([hidden])' : 'code:not([hidden])');
      h.hidden = body.hidden = q !== '' && !visible;
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
