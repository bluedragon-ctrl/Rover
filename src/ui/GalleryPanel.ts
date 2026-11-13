import { headerLevel, hex, isPhoto, Level, LEVEL_NAMES, PRODUCT_NAMES, productFrameBytes, ProductType, type ReceivedProduct } from '../core/downlink';

const LEVEL_TIPS: Record<number, string> = {
  [Level.RAW]: 'raw: sent as the camera took it',
  [Level.EDITED]: 'edited: changed with STB after the SNAP',
  [Level.DRAWN]: 'drawn: no camera picture behind it (no credits)',
};
import { bandNm, productFrame, SPECTRUM_BANDS } from '../core/imaging';
import { BALANCE } from '../core/balance';
import { decodePhoto, PHOTO_FORMATS } from '../core/photos';
import type { SimulationEngine } from '../core/SimulationEngine';

/** Bar colour for a wavelength: visible bands roughly in their colour, near-IR grey. */
function bandColor(nm: number): string {
  if (nm >= 720) return '#8a8f99';
  const hue = Math.round(270 - ((nm - 400) / 300) * 270); // 400 nm violet .. 700 nm red
  return `hsl(${Math.max(0, hue)} 80% 60%)`;
}

/** Inline SVG bar chart of a (possibly partial) spectrum; missing bands are hatched. */
export function spectrumSvg(payload: number[], received: number): string {
  const w = 192;
  const h = 64;
  const bw = w / SPECTRUM_BANDS;
  let bars = '';
  for (let i = 0; i < SPECTRUM_BANDS; i++) {
    const x = (i * bw).toFixed(1);
    if (i < received) {
      const bh = ((payload[i] ?? 0) / 255) * (h - 2);
      bars += `<rect x="${x}" y="${(h - bh).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${bandColor(bandNm(i))}"><title>${bandNm(i)} nm: ${payload[i]}</title></rect>`;
    } else bars += `<rect x="${x}" y="0" width="${(bw - 1).toFixed(1)}" height="${h}" fill="url(#hatch)" />`;
  }
  return `<svg class="spectrum" viewBox="0 0 ${w} ${h + 12}" width="${w}" height="${h + 12}">
    <defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#2a3446" stroke-width="2" /></pattern></defs>
    ${bars}
    <text x="0" y="${h + 10}">400</text><text x="${(7.5 * bw).toFixed(1)}" y="${h + 10}" text-anchor="middle">700</text><text x="${w}" y="${h + 10}" text-anchor="end">1000 nm</text>
  </svg>`;
}

const PHOTO_PX = 128;

const productId = (g: ReceivedProduct): string => `${g.unitId}:${g.tick}:${g.seq}`;

const h2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');

/**
 * Hex view of a received science frame: the header byte (decoded), the sequence byte, then
 * the payload 16 bytes per row, numbered like image memory addresses (SPEC §3.8.7).
 */
export function hexDump(frame: readonly number[], total: number): string {
  const lines: string[] = [];
  if (frame.length) {
    const h = frame[0];
    const level = isPhoto((h >> 3) & 15) ? ` · ${LEVEL_NAMES[headerLevel(h)] ?? '?'}` : '';
    lines.push(`header  ${h2(h)}  ${PRODUCT_NAMES[(h >> 3) & 15] ?? 'type ' + ((h >> 3) & 15)}${level}`);
  }
  if (frame.length > 1) lines.push(`seq     ${h2(frame[1])}  product #${frame[1]}`);
  const payload = frame.slice(2);
  for (let at = 0; at < payload.length; at += 16) {
    const row = payload.slice(at, at + 16).map(h2);
    lines.push(`${at.toString(16).toUpperCase().padStart(3, '0')}     ${row.slice(0, 8).join(' ')}${row.length > 8 ? '  ' + row.slice(8).join(' ') : ''}`);
  }
  if (frame.length < total) lines.push(`        … ${total - frame.length} B not received yet`);
  return lines.join('\n');
}
const FLAG_TEXT = {
  hit: `<span class="ok">⚑ anomaly confirmed: +${BALANCE.anomalyFlagCredits} cr</span>`,
  known: '<span class="info">⚑ anomaly confirmed, already catalogued: no credits</span>',
  miss: `<span class="warn">⚑ no anomaly: −${BALANCE.anomalyWrongFlag} cr</span>`,
} as const;

/** A (possibly partial) photo as a data URL: crisp pixels scaled up, missing rows hatched. */
export function photoDataUrl(type: number, payload: number[]): string {
  const ph = decodePhoto(type, payload);
  if (!ph) return '';
  const small = document.createElement('canvas');
  small.width = ph.w;
  small.height = ph.h;
  const sctx = small.getContext('2d')!;
  const img = sctx.createImageData(ph.w, ph.h);
  for (let p = 0; p < ph.pixelsReceived; p++) {
    img.data[p * 4] = ph.rgb[p * 3];
    img.data[p * 4 + 1] = ph.rgb[p * 3 + 1];
    img.data[p * 4 + 2] = ph.rgb[p * 3 + 2];
    img.data[p * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = PHOTO_PX;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#111a26';
  ctx.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
  ctx.strokeStyle = '#2b3b52';
  for (let i = -PHOTO_PX; i < PHOTO_PX; i += 8) {
    ctx.beginPath();
    ctx.moveTo(i, PHOTO_PX);
    ctx.lineTo(i + PHOTO_PX, 0);
    ctx.stroke();
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, PHOTO_PX, PHOTO_PX);
  return out.toDataURL();
}

/** Mission control gallery: science products received over the downlink (SPEC §3.8.5). */
export class GalleryPanel {
  private lastKey = '';
  /** Rendered photos by product and bytes received (complete ones never change). */
  private photoCache = new Map<string, string>();
  private list: HTMLElement;
  private status: HTMLElement;

  /** Products whose hex view is open. */
  private openHex = new Set<string>();

  private dumpOf(g: ReceivedProduct): string {
    return hexDump(productFrame(this.engine.seed, g).slice(0, g.received), productFrameBytes(g.type));
  }

  /** Called after a flag attempt (main.ts logs the outcome). */
  onFlag?: (g: ReceivedProduct, err: string | null) => void;

  constructor(el: HTMLElement, private engine: SimulationEngine) {
    el.innerHTML = `<div class="toolbar small"><span class="dim" id="gallery-status"></span></div>
      <div id="gallery-list"></div>
      <p class="small dim">The spectrometer (<code>ACT TOOL_2 slot</code>) records a 16-band spectrum (18 B) and the mast camera
      (<code>SNAP dir [mode]</code>) takes a 32×32 photo into image memory; <code>SEND</code> records it (258 B) in the science
      recorder, changed by your program or not (<code>LDB</code> / <code>STB</code>). The downlink sends them after the log FIFO is
      empty; photos fill in row by row, and credits are paid when the last byte arrives (lit photos 1, +5 for the first of a
      subject type; dark photos and drawn pictures nothing). Rare cliff walls and samples hide an <b>anomaly</b> that only a photo shows: if you spot
      one, <i>Flag anomaly</i> on the complete, lit photo (+${BALANCE.anomalyFlagCredits} for a new one, −${BALANCE.anomalyWrongFlag} for a wrong flag;
      one flag per photo).</p>`;
    this.list = el.querySelector('#gallery-list')!;
    // Hex views: built only when opened, and kept open across re-renders ('toggle' does not bubble).
    this.list.addEventListener(
      'toggle',
      (ev) => {
        const d = ev.target as HTMLDetailsElement;
        const id = d.dataset.hex;
        if (!id) return;
        if (d.open) this.openHex.add(id);
        else this.openHex.delete(id);
        const g = this.engine.gallery.find((p) => productId(p) === id);
        if (d.open && g) d.querySelector('pre')!.textContent = this.dumpOf(g);
      },
      true,
    );
    this.list.addEventListener('click', (ev) => {
      const id = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-flag]')?.dataset.flag;
      const g = id ? this.engine.gallery.find((p) => productId(p) === id) : undefined;
      if (!g) return;
      const err = this.engine.flagAnomaly(g);
      this.onFlag?.(g, err);
      this.lastKey = '';
      this.update();
    });
    this.status = el.querySelector('#gallery-status')!;
  }

  private card(g: ReceivedProduct): string {
    const size = productFrameBytes(g.type);
    const frame = productFrame(this.engine.seed, g).slice(0, g.received);
    const done = g.received >= size;
    const multi = this.engine.units.length > 1 ? ` · ${this.engine.getUnit(g.unitId)?.name ?? `#${g.unitId}`}` : '';
    let body = '';
    let what = '';
    let chip = '';
    if (g.type === ProductType.SPECTRUM) body = spectrumSvg(frame.slice(2), Math.max(0, g.received - 2));
    else if (isPhoto(g.type)) {
      const key = `${g.unitId}:${g.tick}:${g.seq}:${g.received}`;
      let url = this.photoCache.get(key);
      if (!url) {
        url = photoDataUrl(g.type, frame.slice(2));
        this.photoCache.set(key, url);
        if (this.photoCache.size > 160) this.photoCache.delete(this.photoCache.keys().next().value!);
      }
      body = `<img class="photo" src="${url}" width="${PHOTO_PX}" height="${PHOTO_PX}" alt="photo">`;
      // Processing level from the received header byte (SPEC §3.8.7): mission control knows only what arrived.
      const level = frame.length ? headerLevel(frame[0]) : Level.RAW;
      const subject = g.horizon ? 'landscape' : (this.engine.registry.get(g.subject)?.name ?? `tile ${g.subject}`);
      what =
        level === Level.DRAWN
          ? ` · drawn picture · ${PHOTO_FORMATS[g.type]?.label ?? ''}`
          : ` · ${subject}${g.lit ? '' : ' · <span class="warn">dark</span>'} · ${PHOTO_FORMATS[g.type]?.label ?? ''}`;
      if (frame.length) chip = ` <i class="lvl lvl-${LEVEL_NAMES[level]}" title="${LEVEL_TIPS[level] ?? ''}">${LEVEL_NAMES[level] ?? '?'}</i>`;
      if (g.flag) body += `<div class="small">${FLAG_TEXT[g.flag]}</div>`;
      else if (done && g.lit && level !== Level.DRAWN) body += `<div class="small"><button data-flag="${productId(g)}" title="Mark this photo as showing an anomaly">⚑ Flag anomaly</button></div>`;
    }
    const shown = frame.length > 34 ? `${hex(frame.slice(0, 34))} …` : hex(frame);
    const id = productId(g);
    const open = this.openHex.has(id);
    return `<div class="product${done ? '' : ' partial'}">
      <b><em>${PRODUCT_NAMES[g.type] ?? `type ${g.type}`} #${g.seq}${chip}</em><span>${done ? `+${g.credits} cr` : `${g.received}/${size} B`}</span></b>
      ${body}
      <div class="small dim">recorded t${g.tick} at (${g.x}, ${g.y})${what} · ${done ? `arrived t${g.arrived}` : `receiving… t${g.arrived}`} · ${size} B${multi}</div>
      <details class="hexview small" data-hex="${id}"${open ? ' open' : ''}><summary class="hex" title="Show every byte"><span class="when-closed">${shown}</span><span class="when-open">hex view: header, sequence, then the payload by address</span></summary><pre>${open ? this.dumpOf(g) : ''}</pre></details>
    </div>`;
  }

  update(): void {
    const units = this.engine.units;
    const waiting = units.reduce((n, u) => n + u.link.products.length, 0);
    const used = units.reduce((n, u) => n + u.link.recUsed, 0);
    const cap = units.reduce((n, u) => n + u.chassis.recorderBytes, 0);
    this.status.textContent = `recorder ${used}/${cap} B · ${waiting} waiting · ${this.engine.stats.scienceDelivered} delivered`;
    const gl = this.engine.gallery;
    const last = gl.at(-1);
    const flags = gl.reduce((n, g) => n + (g.flag ? 1 : 0), 0);
    const key = `${gl.length}:${last?.seq ?? -1}:${last?.received ?? 0}:${flags}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.list.innerHTML = gl.length
      ? [...gl].reverse().map((g) => this.card(g)).join('')
      : '<div class="dim">No science received yet.</div>';
  }
}
