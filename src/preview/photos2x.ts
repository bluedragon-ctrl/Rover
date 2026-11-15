// M15 review (preview.html?photos2x=1): today's camera formats next to the doubled ones of the
// PDP-11 core (PHOTO_FORMATS_2X). The game's own generator (src/core/photos.ts) draws both, at
// the same on-screen size, so the difference is only the resolution.
import { BALANCE, PDP11 } from '../core/balance';
import { decodePhoto, PHOTO_FORMATS, PHOTO_FORMATS_2X, photoBytes, photoPayload, type PhotoFormats, type PhotoShot } from '../core/photos';
import { T } from '../core/WorldRegistry';

const CELL = 160;
const SEED = 5;

function draw(p: PhotoShot, formats: PhotoFormats): HTMLCanvasElement {
  const ph = decodePhoto(p.type, photoPayload(SEED, p, formats), formats)!;
  const small = document.createElement('canvas');
  small.width = ph.w;
  small.height = ph.h;
  const sctx = small.getContext('2d')!;
  const img = sctx.createImageData(ph.w, ph.h);
  for (let i = 0; i < ph.w * ph.h; i++) img.data.set([ph.rgb[i * 3], ph.rgb[i * 3 + 1], ph.rgb[i * 3 + 2], 255], i * 4);
  sctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = CELL;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, CELL, CELL);
  return out;
}

const HORIZON: PhotoShot['horizon'] = {
  h: [0, 0, 30, 60, 90, 70, 40, 0, 0, 0, 20, 50, 120, 140, 80, 0],
  d: [0, 0, 6, 5, 4, 5, 7, 0, 0, 0, 9, 6, 3, 3, 5, 0],
  t: [0, 0, T.CLIFF_WALL, T.CLIFF_WALL, T.CLIFF_WALL, T.CLIFF_WALL, T.CLIFF_WALL, 0, 0, 0, T.IRON_ORE, T.IRON_ORE, T.CLIFF_WALL, T.CLIFF_WALL, T.SILICON_ORE, 0],
  ground: T.FLAT_SAND,
  sunU: 300,
  sunV: 180,
  light: 90,
};

const ROWS: Array<{ name: string; shot: Omit<PhotoShot, 'type' | 'lit' | 'tick' | 'seq'> }> = [
  { name: 'CLIFF', shot: { subject: T.CLIFF_WALL, sx: 3, sy: 4 } },
  { name: 'IRON', shot: { subject: T.IRON_ORE, sx: 1, sy: 2 } },
  { name: 'SILIC', shot: { subject: T.SILICON_ORE, sx: 5, sy: 1 } },
  { name: 'SAMPLE', shot: { subject: T.SAMPLE, sx: 2, sy: 1 } },
  { name: 'CLIFF ★', shot: { subject: T.CLIFF_WALL, sx: 3, sy: 4, anomaly: true } },
  { name: 'HORIZON', shot: { subject: 0, sx: 0, sy: 0, horizon: HORIZON } },
];

/** Ticks to send a photo (header + sequence byte + payload) at full signal. */
const airTicks = (bytes: number, perTick: number) => Math.ceil((bytes + 2) / perTick);

export function mountPhotos2x(root: HTMLElement, q: URLSearchParams): void {
  root.hidden = false;
  const modes = (q.get('modes') ?? '1,2,3,4,5').split(',').map(Number);
  const link = BALANCE.linkBytesPerTick;
  const link2 = link * PDP11.linkScale;
  root.innerHTML = `
    <div class="pl-head">
      <b>CAMERA · TODAY vs DOUBLED (M15)</b>
      <span class="dim">game generator (src/core/photos.ts), both drawn at ${CELL}×${CELL} px · air time at full signal: today ${link} B/tick, PDP-11 core ${link2} B/tick (Mk-I)</span>
    </div>
    <div class="pl-grid" style="grid-template-columns: 90px repeat(${modes.length * 2}, ${CELL + 4}px)"></div>`;
  const grid = root.querySelector('.pl-grid')!;
  grid.insertAdjacentHTML('beforeend', '<div class="pl-colhead">subject</div>');
  for (const m of modes) {
    const a = photoBytes(m);
    const b = photoBytes(m, PHOTO_FORMATS_2X);
    grid.insertAdjacentHTML('beforeend', `<div class="pl-colhead">mode ${m} today<br><span class="dim">${PHOTO_FORMATS[m].label}<br>${a} B · ${airTicks(a, link)} ticks</span></div>`);
    grid.insertAdjacentHTML('beforeend', `<div class="pl-colhead">mode ${m} doubled<br><span class="dim">${PHOTO_FORMATS_2X[m].label}<br>${b} B · ${airTicks(b, link2)} ticks</span></div>`);
  }
  for (const r of ROWS) {
    grid.insertAdjacentHTML('beforeend', `<div class="pl-name"><b>${r.name}</b></div>`);
    for (const m of modes)
      for (const f of [PHOTO_FORMATS, PHOTO_FORMATS_2X]) {
        const cell = document.createElement('div');
        cell.className = 'pl-cell';
        cell.appendChild(draw({ ...r.shot, type: m, lit: true, tick: 50, seq: 0 }, f));
        grid.appendChild(cell);
      }
  }
}
