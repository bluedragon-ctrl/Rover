/**
 * The rover's downlink (docs/SPEC.md §3.8.1–3.8.3): one byte-based transmitter fed by a
 * lossy log FIFO. Headless and integer-only.
 *
 * Frame header: bit 7 kind (0 log, 1 science), bits 6..3 tag, bits 2..1 size code
 * (0 → 0 B, 1 → 1 B, 2 → 2 B, 3 → 4 B payload), bit 0 = 0.
 *
 * Science products (§3.8.5) wait in the reliable recorder as descriptors; their bytes are
 * generated (src/core/imaging.ts) when mission control has received them. Log and recorder
 * are separate virtual channels on the same link: the log has priority and may preempt a
 * product between bytes; the product resumes where it stopped.
 */

/** Tag reserved for system frames (boot, dumps). `LOG 15` is a compile error. */
export const SYSTEM_TAG = 15;
export const MAX_LOG_TAG = 14;

/** Boot reasons carried by the boot frame `LOG 15 reason`. */
export const BootReason = {
  UPLOAD: 1,
  WATCHDOG: 2,
  COLD_BOOT: 3,
  ADMIN: 4,
} as const;
export const BOOT_REASON_NAMES: Record<number, string> = { 1: 'code upload', 2: 'watchdog', 3: 'cold boot', 4: 'admin' };

/** Received frames mission control keeps (console history, saved). */
export const RECEIVED_KEEP = 200;
/** Science products mission control keeps (gallery, saved). */
export const GALLERY_KEEP = 100;

const SIZE_BYTES = [0, 1, 2, 4];

/** Science product types (frame tag of a science frame). */
export const ProductType = {
  SPECTRUM: 0,
} as const;
export const PRODUCT_NAMES: Record<number, string> = { 0: 'spectrum' };
/** Payload bytes per product type. */
export const PRODUCT_PAYLOAD: Record<number, number> = { 0: 16 };
/** On-air size: header + sequence byte + payload. */
export const productFrameBytes = (type: number): number => 2 + (PRODUCT_PAYLOAD[type] ?? 0);

/** Science frame header byte for a product type. */
export const scienceHeader = (type: number): number => 0x80 | ((type & 15) << 3);

/**
 * A science product in the recorder. Its bytes are a pure function of the world seed and
 * this descriptor (imaging.ts), so saves store only the descriptor.
 */
export interface ProductDesc {
  type: number;
  /** Sequence number 0–255 (wraps), per rover. */
  seq: number;
  /** Subject: tile id analyzed / photographed. */
  subject: number;
  x: number;
  y: number;
  /** Tick it was recorded. */
  tick: number;
  /** Science credits paid on full delivery. */
  credits: number;
}

/** Payload size code for a signed 32-bit value: smallest of 1/2/4 bytes that holds it. */
function sizeCode(v: number): number {
  if (v >= -128 && v <= 127) return 1;
  if (v >= -32768 && v <= 32767) return 2;
  return 3;
}

/** Encode a log frame. `value` null = no payload. */
export function encodeLog(tag: number, value: number | null): number[] {
  if (value === null) return [(tag & 15) << 3];
  const code = sizeCode(value | 0);
  const out = [((tag & 15) << 3) | (code << 1)];
  const n = SIZE_BYTES[code];
  for (let i = n - 1; i >= 0; i--) out.push(((value | 0) >> (i * 8)) & 0xff);
  return out;
}

export interface DecodedFrame {
  kind: 0 | 1;
  tag: number;
  /** Signed log value, or null if the frame has no payload. */
  value: number | null;
}

/** Decode a complete log frame (as received). */
export function decodeFrame(bytes: readonly number[]): DecodedFrame {
  const h = bytes[0] ?? 0;
  const kind = (h >> 7) as 0 | 1;
  const tag = (h >> 3) & 15;
  const n = SIZE_BYTES[(h >> 1) & 3];
  if (kind === 1 || n === 0) return { kind, tag, value: null };
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 8) | (bytes[1 + i] ?? 0);
  // Sign-extend from n bytes.
  const shift = 32 - n * 8;
  v = shift ? (v << shift) >> shift : v | 0;
  return { kind, tag, value: v };
}

export interface QueuedFrame {
  bytes: number[];
  /** Frames dropped (FIFO full) just before this one; the link layer reports the gap. */
  gap: number;
}

export interface ReceivedFrame {
  unitId: number;
  /** Tick the last byte arrived. */
  tick: number;
  bytes: number[];
  gap: number;
}

/** A product as mission control holds it: complete, or partly received. */
export interface ReceivedProduct extends ProductDesc {
  unitId: number;
  /** Tick its last byte arrived (or the latest byte so far, while partial). */
  arrived: number;
  /** Bytes received so far, out of productFrameBytes(type). */
  received: number;
}

/** Per-rover transmitter state (saved). */
export class Downlink {
  /** Log FIFO, oldest first; the head may be partly sent. */
  fifo: QueuedFrame[] = [];
  /** Bytes of fifo[0] already transmitted. */
  headSent = 0;
  /** Byte budget accumulator: +bytesPerTick × signal per tick, 100 = one byte. */
  acc = 0;
  /** @LOG_LOST: frames dropped since boot, saturates at 255. */
  lost = 0;
  /** Drops since the last queued frame (attached to the next frame as its gap). */
  gap = 0;
  /** Science recorder, oldest first; the head may be partly sent. */
  products: ProductDesc[] = [];
  /** Bytes of products[0] already transmitted. */
  recSent = 0;
  /** Sequence number for the next product (0–255, wraps). */
  seq = 0;

  /** Bytes the recorder holds (a product's space is freed only when its last byte is sent). */
  get recUsed(): number {
    let n = 0;
    for (const p of this.products) n += productFrameBytes(p.type);
    return n;
  }

  recFree(capacity: number): number {
    return Math.max(0, capacity - this.recUsed);
  }

  /** Record a product if it fits; assigns its sequence number. */
  record(p: Omit<ProductDesc, 'seq'>, capacity: number): ProductDesc | null {
    if (productFrameBytes(p.type) > this.recFree(capacity)) return null;
    const d = { ...p, seq: this.seq };
    this.seq = (this.seq + 1) & 255;
    this.products.push(d);
    return d;
  }

  /** Bytes waiting in the FIFO (the unsent part of the head counts). */
  get used(): number {
    let n = -this.headSent;
    for (const f of this.fifo) n += f.bytes.length;
    return n;
  }

  free(capacity: number): number {
    return Math.max(0, capacity - this.used);
  }

  /** Queue a frame; drops it whole (and counts it) if it does not fit. */
  enqueue(bytes: number[], capacity: number): boolean {
    if (bytes.length > this.free(capacity)) {
      if (this.lost < 255) this.lost++;
      this.gap++;
      return false;
    }
    this.fifo.push({ bytes, gap: this.gap });
    this.gap = 0;
    return true;
  }

  get idle(): boolean {
    return this.fifo.length === 0 && this.products.length === 0;
  }

  /**
   * One tick of transmission: log FIFO first, then the recorder. Returns the log frames and
   * products completed this tick, the head product if it advanced without completing, and
   * how many bytes went out. Nothing is sent below `minSignal`; an idle link keeps no budget.
   */
  pump(
    signal: number,
    minSignal: number,
    bytesPerTick: number,
  ): { sent: number; done: QueuedFrame[]; delivered: ProductDesc[]; partial: ProductDesc | null } {
    const done: QueuedFrame[] = [];
    const delivered: ProductDesc[] = [];
    let sent = 0;
    let recBytes = 0;
    if (signal < minSignal || this.idle) {
      this.acc = 0;
      return { sent, done, delivered, partial: null };
    }
    this.acc += bytesPerTick * signal;
    while (this.acc >= 100 && !this.idle) {
      this.acc -= 100;
      sent++;
      if (this.fifo.length) {
        if (++this.headSent >= this.fifo[0].bytes.length) {
          done.push(this.fifo.shift()!);
          this.headSent = 0;
        }
      } else {
        recBytes++;
        if (++this.recSent >= productFrameBytes(this.products[0].type)) {
          delivered.push(this.products.shift()!);
          this.recSent = 0;
          recBytes = 0;
        }
      }
    }
    if (this.idle) this.acc = 0;
    return { sent, done, delivered, partial: recBytes > 0 ? this.products[0] : null };
  }
}

/** Hex dump, e.g. "2C FE D4". */
export function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
