// M9 slice 6 review (preview.html?anomaly=1): anomaly photos through every camera mode.
// Uses the game's own generator (src/core/photos.ts), so what is reviewed here is exactly
// what the gallery will show. Rows: an ordinary subject, then anomalies on several tiles.
import { decodePhoto, PHOTO_FORMATS, photoBytes, photoPayload, type PhotoShot } from '../core/photos';
import { T } from '../core/WorldRegistry';

const CELL = 128;
const SEED = 5;

function draw(p: PhotoShot): HTMLCanvasElement {
  const ph = decodePhoto(p.type, photoPayload(SEED, p))!;
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

interface Row {
  name: string;
  note: string;
  shot: Omit<PhotoShot, 'type' | 'lit' | 'tick' | 'seq'>;
}

const ROWS: Row[] = [
  { name: 'CLIFF', note: 'ordinary cliff wall', shot: { subject: T.CLIFF_WALL, sx: 3, sy: 4 } },
  { name: 'CLIFF ★', note: 'fossil, tile (3, 4)', shot: { subject: T.CLIFF_WALL, sx: 3, sy: 4, anomaly: true } },
  { name: 'CLIFF ★', note: 'fossil, tile (−7, 12)', shot: { subject: T.CLIFF_WALL, sx: -7, sy: 12, anomaly: true } },
  { name: 'CLIFF ★', note: 'fossil, tile (20, −5)', shot: { subject: T.CLIFF_WALL, sx: 20, sy: -5, anomaly: true } },
  { name: 'SAMPLE', note: 'ordinary sample', shot: { subject: T.SAMPLE, sx: 2, sy: 1 } },
  { name: 'SAMPLE ★', note: 'pyritized fossil, (2, 1)', shot: { subject: T.SAMPLE, sx: 2, sy: 1, anomaly: true } },
  { name: 'SAMPLE ★', note: 'pyritized fossil, (9, 9)', shot: { subject: T.SAMPLE, sx: 9, sy: 9, anomaly: true } },
];

export function mountAnomalyLab(root: HTMLElement): void {
  root.hidden = false;
  const modes = [1, 2, 3, 4, 5];
  root.innerHTML = `
    <div class="pl-head">
      <b>ANOMALIES · CAMERA MODES</b>
      <span class="dim">game generator (src/core/photos.ts) · ★ = anomaly tile · last column: the same anomaly photographed at night without light (mode 1, worth nothing)</span>
    </div>
    <div class="pl-grid" style="grid-template-columns: 130px repeat(6, 140px)"></div>`;
  const grid = root.querySelector('.pl-grid')!;
  const heads = ['subject', ...modes.map((m) => `mode ${m}<br><span class="dim">${PHOTO_FORMATS[m].label}<br>${photoBytes(m) + 2} B</span>`), 'dark<br><span class="dim">mode 1, no light</span>'];
  for (const h of heads) grid.insertAdjacentHTML('beforeend', `<div class="pl-colhead">${h}</div>`);
  for (const r of ROWS) {
    grid.insertAdjacentHTML('beforeend', `<div class="pl-name"><b>${r.name}</b><br><span class="dim">${r.note}</span></div>`);
    for (const m of [...modes, 0]) {
      const cell = document.createElement('div');
      cell.className = 'pl-cell';
      cell.appendChild(draw({ ...r.shot, type: m || 1, lit: m !== 0, tick: 50, seq: 0 }));
      grid.appendChild(cell);
    }
  }
}
