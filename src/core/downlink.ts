/**
 * The rover's downlink (docs/SPEC.md §3.8.1–3.8.3): one byte-based transmitter fed by a
 * lossy log FIFO, a reliable science recorder and (top priority) memory-dump replies.
 * Headless and integer-only.
 *
 * Frame header: bit 7 kind (0 log, 1 science), bits 6..3 tag, bits 2..1 size code
 * (0 → 0 B, 1 → 1 B, 2 → 2 B, 3 → 4 B payload), bit 0 = 0.
 *
 * Science products (§3.8.5) wait in the reliable recorder as descriptors; their bytes are
 * generated (src/core/imaging.ts) when mission control has received them. Log and recorder
 * are separate virtual channels on the same link: the log has priority and may preempt a
 * product between bytes; the product resumes where it stopped.
 */

import type { HorizonView } from './photos';

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
  /** Photos: product type = camera mode (`SNAP dir mode`), formats in photos.ts. */
  PHOTO_GREY: 1,
  PHOTO_DITHER: 2,
  PHOTO_PALETTE: 3,
  PHOTO_HIRES: 4,
  PHOTO_RGB: 5,
} as const;
export const PRODUCT_NAMES: Record<number, string> = { 0: 'spectrum', 1: 'photo', 2: 'photo (dither)', 3: 'photo (colour)', 4: 'photo (hi-res)', 5: 'photo (RGB)' };
/** Payload bytes per product type. */
export const PRODUCT_PAYLOAD: Record<number, number> = { 0: 16, 1: 256, 2: 256, 3: 512, 4: 1024, 5: 1024 };
export const isPhoto = (type: number): boolean => type >= 1 && type <= 5;
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
  /** Science credits paid on full delivery (photos: set at delivery, first-of-a-kind bonus). */
  credits: number;
  /** Photos: subject tile (the same rock gives the same scene). */
  sx?: number;
  sy?: number;
  /** Photos: enough light (sun, or the headlight aimed at the subject). Dark photos are worth nothing. */
  lit?: boolean;
  /** Photos: landscape view sampled from the world (no subject within reach; subject = 0). */
  horizon?: HorizonView;
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
  /** Dump replies: tick the snapshot was taken (mission control knows when it asked). */
  taken?: number;
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
  /** Dump replies waiting to be sent (highest priority); the head may be partly sent. */
  sys: SysFrame[] = [];
  /** Bytes of sys[0] already transmitted. */
  sysSent = 0;

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
    return this.sys.length === 0 && this.fifo.length === 0 && this.products.length === 0;
  }

  /**
   * One tick of transmission: pending dumps first, then the log FIFO, then the recorder.
   * Returns the dumps, log frames and products completed this tick, the head product if it advanced without completing, and
   * how many bytes went out. Nothing is sent below `minSignal`; an idle link keeps no budget.
   */
  pump(
    signal: number,
    minSignal: number,
    bytesPerTick: number,
  ): { sent: number; sysDone: SysFrame[]; done: QueuedFrame[]; delivered: ProductDesc[]; partial: ProductDesc | null } {
    const sysDone: SysFrame[] = [];
    const done: QueuedFrame[] = [];
    const delivered: ProductDesc[] = [];
    let sent = 0;
    let recBytes = 0;
    if (signal < minSignal || this.idle) {
      this.acc = 0;
      return { sent, sysDone, done, delivered, partial: null };
    }
    this.acc += bytesPerTick * signal;
    while (this.acc >= 100 && !this.idle) {
      this.acc -= 100;
      sent++;
      if (this.sys.length) {
        if (++this.sysSent >= this.sys[0].bytes.length) {
          sysDone.push(this.sys.shift()!);
          this.sysSent = 0;
        }
      } else if (this.fifo.length) {
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
    return { sent, sysDone, done, delivered, partial: recBytes > 0 ? this.products[0] : null };
  }
}

// ---------------------------------------------------------------- memory dumps (§3.8.4)

/** Dump frame header: kind 1 (sized frame), tag 15 (system). Followed by dump kind, length, payload. */
export const DUMP_HEADER = 0x80 | (SYSTEM_TAG << 3);
export const DumpKind = { CPU: 1, STACKS: 2 } as const;
/** CPU state byte in a dump. */
export const CPU_STATE_CODES: readonly string[] = ['RUNNING', 'BLOCKED', 'HALTED', 'FAULT'];

/** A dump reply waiting for the downlink (it goes before the log FIFO). */
export interface SysFrame {
  bytes: number[];
  /** Tick the snapshot was taken (= when mission control sent the command). */
  taken: number;
}

const be = (v: number, n: number): number[] => {
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(((v | 0) >> (i * 8)) & 0xff);
  return out;
};
const rd = (b: readonly number[], at: number, n: number, signed: boolean): number => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + (b[at + i] ?? 0);
  if (signed && n < 4 && v >= 2 ** (8 * n - 1)) v -= 2 ** (8 * n);
  return n === 4 && signed ? v | 0 : v;
};
const dumpFrame = (kind: number, payload: number[]): number[] => [DUMP_HEADER, kind, payload.length, ...payload];

/** CPU dump: IP 2 B, @STATUS 1 B, state 1 B, each register 4 B, data/call stack depth 1 B each. */
export function encodeCpuDump(d: { ip: number; status: number; state: string; regs: ArrayLike<number>; dsDepth: number; csDepth: number }): number[] {
  const code = CPU_STATE_CODES.indexOf(d.state);
  const p = [...be(d.ip, 2), d.status & 255, code < 0 ? 255 : code];
  for (let i = 0; i < d.regs.length; i++) p.push(...be(d.regs[i], 4));
  p.push(d.dsDepth & 255, d.csDepth & 255);
  return dumpFrame(DumpKind.CPU, p);
}

/** Stack dump: data depth 1 B + 4 B per entry, call depth 1 B + 2 B (return IP) per entry. */
export function encodeStackDump(ds: readonly number[], cs: readonly number[]): number[] {
  const p = [ds.length & 255];
  for (const v of ds) p.push(...be(v, 4));
  p.push(cs.length & 255);
  for (const v of cs) p.push(...be(v, 2));
  return dumpFrame(DumpKind.STACKS, p);
}

export type DecodedDump =
  | { kind: 1; ip: number; status: number; state: string; regs: number[]; dsDepth: number; csDepth: number }
  | { kind: 2; dataStack: number[]; callStack: number[] };

/** Decode a dump frame as received, or null if it is not one. */
export function decodeDump(b: readonly number[]): DecodedDump | null {
  if (b[0] !== DUMP_HEADER) return null;
  const end = 3 + (b[2] ?? 0);
  if (b[1] === DumpKind.CPU) {
    const regs: number[] = [];
    for (let at = 7; at + 4 <= end - 2; at += 4) regs.push(rd(b, at, 4, true));
    return { kind: 1, ip: rd(b, 3, 2, false), status: b[5] ?? 0, state: CPU_STATE_CODES[b[6] ?? 255] ?? '?', regs, dsDepth: b[end - 2] ?? 0, csDepth: b[end - 1] ?? 0 };
  }
  if (b[1] === DumpKind.STACKS) {
    const dataStack: number[] = [];
    const callStack: number[] = [];
    let at = 3;
    const nd = b[at++] ?? 0;
    for (let i = 0; i < nd; i++, at += 4) dataStack.push(rd(b, at, 4, true));
    const nc = b[at++] ?? 0;
    for (let i = 0; i < nc; i++, at += 2) callStack.push(rd(b, at, 2, false));
    return { kind: 2, dataStack, callStack };
  }
  return null;
}

/** Hex dump, e.g. "2C FE D4". */
export function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
