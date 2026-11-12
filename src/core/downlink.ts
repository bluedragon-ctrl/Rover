/**
 * The rover's downlink (docs/SPEC.md §3.8.1–3.8.3): one byte-based transmitter fed by a
 * lossy log FIFO. Headless and integer-only.
 *
 * Frame header: bit 7 kind (0 log, 1 science), bits 6..3 tag, bits 2..1 size code
 * (0 → 0 B, 1 → 1 B, 2 → 2 B, 3 → 4 B payload), bit 0 = 0.
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

const SIZE_BYTES = [0, 1, 2, 4];

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

  /**
   * One tick of transmission. Returns the frames completed this tick and how many bytes
   * went out. Nothing is sent below `minSignal`; an idle link keeps no byte budget.
   */
  pump(signal: number, minSignal: number, bytesPerTick: number): { sent: number; done: QueuedFrame[] } {
    const done: QueuedFrame[] = [];
    let sent = 0;
    if (signal < minSignal || this.fifo.length === 0) {
      this.acc = 0;
      return { sent, done };
    }
    this.acc += bytesPerTick * signal;
    while (this.acc >= 100 && this.fifo.length) {
      this.acc -= 100;
      sent++;
      if (++this.headSent >= this.fifo[0].bytes.length) {
        done.push(this.fifo.shift()!);
        this.headSent = 0;
      }
    }
    if (this.fifo.length === 0) this.acc = 0;
    return { sent, done };
  }
}

/** Hex dump, e.g. "2C FE D4". */
export function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
