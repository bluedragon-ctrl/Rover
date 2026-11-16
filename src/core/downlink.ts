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
  /** @WDT expired: the firmware did not kick it in time (SPEC §3.9.5). */
  WDT_TIMEOUT: 5,
  /** The game changed the language and rewrote the rover's code (save migration, M14). */
  UPDATE: 6,
  /** M15: the ROM's fault handler rebooted after a bus error or illegal instruction in the firmware. */
  FAULT: 7,
} as const;
export const BOOT_REASON_NAMES: Record<number, string> = { 1: 'code upload', 2: 'watchdog', 3: 'cold boot', 4: 'admin', 5: 'watchdog timeout', 6: 'software update', 7: 'CPU fault' };

/** Out-of-band reboot marker in the TX stream (see {@link Downlink.tx}). */
export const TX_BOOT = -1;

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

/**
 * Processing level of a product (SPEC §3.8.7), carried in bits 2–1 of its science header:
 * RAW = sent as the camera took it (and every spectrum), EDITED = changed with STB after the
 * SNAP, DRAWN = no camera picture behind it.
 */
export const Level = { RAW: 0, EDITED: 1, DRAWN: 2 } as const;
export const LEVEL_NAMES: readonly string[] = ['raw', 'edited', 'drawn'];

/** Science frame header byte for a product type and processing level. */
export const scienceHeader = (type: number, level = 0): number => 0x80 | ((type & 15) << 3) | ((level & 3) << 1);
/** Processing level of a received science frame header. */
export const headerLevel = (header: number): number => (header >> 1) & 3;

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
  /** Photos: the subject tile is an anomaly (ground truth: the gallery never shows this). */
  anomaly?: boolean;
  /** M15: a photo at double resolution (PHOTO_FORMATS_2X, the PDP-11 core's camera). */
  x2?: boolean;
  /** M12: processing level (Level; absent = RAW). */
  level?: number;
  /** M12: the payload as hex, for edited and drawn products (raw ones are regenerated). */
  data?: string;
  /** M12: tick and sequence number the camera noise was generated with (absent = tick, seq). */
  noise?: { tick: number; seq: number };
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
  /** Mission control flagged this photo as an anomaly: right ('hit'), already catalogued ('known') or wrong ('miss'). */
  flag?: 'hit' | 'known' | 'miss';
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
  /**
   * M15 `TX` device (PDP11_IO.md §3.5): the CPU's real-time byte stream, oldest first. A
   * {@link TX_BOOT} entry marks a reboot: out of band, no air time (ground resets its
   * message parser there, so a message cut off by the reboot shows as incomplete).
   */
  tx: number[] = [];
  /** `TXLOST`: bytes dropped because the FIFO was full, since boot (saturates at 255). */
  txLost = 0;
  /**
   * M15 recorder messages (`RECBUF`, PDP11_IO.md §3.5): the CPU's store-and-forward byte
   * stream, oldest first, with {@link TX_BOOT} markers like `tx`. It shares the recorder's
   * room with the products and goes out after `tx`, before them.
   */
  rec: number[] = [];

  /** Bytes of CPU messages waiting in the recorder (markers take no room). */
  get recMsgUsed(): number {
    let n = 0;
    for (const b of this.rec) if (b >= 0) n++;
    return n;
  }

  /** `RECBUF` write: store a byte if the recorder has room (else it is dropped: check `RECFRE`). */
  recPut(byte: number, capacity: number): boolean {
    if (this.recFree(capacity) < 1) return false;
    this.rec.push(byte & 0xff);
    return true;
  }

  /** Bytes waiting in the TX FIFO (markers take no room). */
  get txUsed(): number {
    let n = 0;
    for (const b of this.tx) if (b >= 0) n++;
    return n;
  }

  txFree(capacity: number): number {
    return Math.max(0, capacity - this.txUsed);
  }

  /** `TXBUF` write: queue a byte, or drop and count it if the FIFO is full. */
  txPut(byte: number, capacity: number): boolean {
    if (this.txUsed >= capacity) {
      if (this.txLost < 255) this.txLost++;
      return false;
    }
    this.tx.push(byte & 0xff);
    return true;
  }

  /** Bytes the recorder holds (a product's space is freed only when its last byte is sent). */
  get recUsed(): number {
    let n = 0;
    for (const p of this.products) n += productFrameBytes(p.type);
    return n + this.recMsgUsed;
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
    return this.sys.length === 0 && this.tx.length === 0 && this.fifo.length === 0 && this.products.length === 0 && this.rec.length === 0;
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
  ): { sent: number; sysDone: SysFrame[]; done: QueuedFrame[]; delivered: ProductDesc[]; partial: ProductDesc | null; tx: number[]; rec: number[] } {
    const tx: number[] = [];
    const rec: number[] = [];
    const sysDone: SysFrame[] = [];
    const done: QueuedFrame[] = [];
    const delivered: ProductDesc[] = [];
    let sent = 0;
    let recBytes = 0;
    if (signal < minSignal || this.idle) {
      this.acc = 0;
      return { sent, sysDone, done, delivered, partial: null, tx, rec };
    }
    this.acc += bytesPerTick * signal;
    const markers = () => {
      while (this.tx.length && this.tx[0] < 0 && !this.sys.length && !this.fifo.length) tx.push(this.tx.shift()!);
    };
    const recMarkers = () => {
      while (this.rec.length && this.rec[0] < 0) rec.push(this.rec.shift()!);
    };
    markers();
    recMarkers();
    while (this.acc >= 100 && !this.idle) {
      this.acc -= 100;
      sent++;
      if (this.sys.length) {
        if (++this.sysSent >= this.sys[0].bytes.length) {
          sysDone.push(this.sys.shift()!);
          this.sysSent = 0;
        }
      } else if (this.fifo.length) {
        // Log frames; on the PDP-11 core only the system's boot frames use this queue.
        if (++this.headSent >= this.fifo[0].bytes.length) {
          done.push(this.fifo.shift()!);
          this.headSent = 0;
        }
      } else if (this.tx.length) {
        tx.push(this.tx.shift()!);
        markers();
      } else if (this.rec.length) {
        rec.push(this.rec.shift()!);
        recMarkers();
      } else {
        recBytes++;
        if (++this.recSent >= productFrameBytes(this.products[0].type)) {
          delivered.push(this.products.shift()!);
          this.recSent = 0;
          recBytes = 0;
        }
      }
    }
    markers();
    recMarkers();
    if (this.idle) this.acc = 0;
    return { sent, sysDone, done, delivered, partial: recBytes > 0 ? this.products[0] : null, tx, rec };
  }
}

// ---------------------------------------------------------------- memory dumps (§3.8.4)

/** Dump frame header: kind 1 (sized frame), tag 15 (system). Followed by dump kind, length, payload. */
export const DUMP_HEADER = 0x80 | (SYSTEM_TAG << 3);
/**
 * Dump kinds on the wire: registers and stack of the firmware (5 / 6) and of the program
 * (7 / 8). Kinds 1–4 were Rover-ASM's dumps (retired in M15 slice 6).
 */
export const DumpKind = { CPU11: 5, STACK11: 6, PROG_CPU11: 7, PROG_STACK11: 8 } as const;
/** The most stack words a stack dump carries. */
export const STACK11_WORDS = 8;
/** State byte of a program dump: @PROG_STATE. */
export const PROG_STATE_NAMES: readonly string[] = ['PROG_NONE', 'PROG_READY', 'PROG_RUNNING', 'PROG_DONE', 'PROG_FAULT', 'PROG_HALTED'];
/** CPU state byte in a dump. */
export const CPU_STATE_CODES: readonly string[] = ['RUNNING', 'BLOCKED', 'HALTED', 'FAULT'];

/** A dump reply waiting for the downlink (it goes before the log FIFO). */
export interface SysFrame {
  bytes: number[];
  /** Tick the snapshot was taken (= when mission control sent the command). */
  taken: number;
}

const dumpFrame = (kind: number, payload: number[]): number[] => [DUMP_HEADER, kind, payload.length, ...payload];

/**
 * Register dump (kinds 5 / 7): state 1 B, PSW 2 B, R0–R7 2 B each. Words are low byte
 * first, as they sit in memory. The state byte: a CpuState (firmware) or `PRGST` (program).
 */export function encodeCpu11Dump(d: { state: string | number; psw: number; r: ArrayLike<number> }, prog = false): number[] {
  const code = typeof d.state === 'number' ? d.state : CPU_STATE_CODES.indexOf(d.state);
  const p = [code < 0 ? 255 : code, ...le(d.psw)];
  for (let i = 0; i < 8; i++) p.push(...le(d.r[i] ?? 0));
  return dumpFrame(prog ? DumpKind.PROG_CPU11 : DumpKind.CPU11, p);
}

/**
 * Stack dump (kinds 6 / 8): SP 2 B, count 1 B, then that many words from SP up
 * (the top of the stack first, at most {@link STACK11_WORDS}), low byte first.
 */
export function encodeStack11Dump(sp: number, words: readonly number[], prog = false): number[] {
  const p = [...le(sp), words.length & 255];
  for (const w of words) p.push(...le(w));
  return dumpFrame(prog ? DumpKind.PROG_STACK11 : DumpKind.STACK11, p);
}

const le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const rdLe = (b: readonly number[], at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);

export type DumpSlot = 'firmware' | 'program';
/** A decoded dump: registers (wire kinds 5 / 7) or stack (6 / 8) of a slot. */
export type DecodedDump =
  | { kind: 'regs'; slot: DumpSlot; state: string; psw: number; r: number[] }
  | { kind: 'stack'; slot: DumpSlot; sp: number; words: number[] };

/** Decode a dump frame as received, or null if it is not one. */
export function decodeDump(b: readonly number[]): DecodedDump | null {
  if (b[0] !== DUMP_HEADER) return null;
  const k = b[1];
  const slot: DumpSlot = k === DumpKind.PROG_CPU11 || k === DumpKind.PROG_STACK11 ? 'program' : 'firmware';
  if (k === DumpKind.CPU11 || k === DumpKind.PROG_CPU11) {
    const names = slot === 'program' ? PROG_STATE_NAMES : CPU_STATE_CODES;
    const r: number[] = [];
    for (let i = 0; i < 8; i++) r.push(rdLe(b, 6 + i * 2));
    return { kind: 'regs', slot, state: names[b[3] ?? 255] ?? '?', psw: rdLe(b, 4), r };
  }
  if (k === DumpKind.STACK11 || k === DumpKind.PROG_STACK11) {
    const n = b[5] ?? 0;
    const words: number[] = [];
    for (let i = 0; i < n; i++) words.push(rdLe(b, 6 + i * 2));
    return { kind: 'stack', slot, sp: rdLe(b, 3), words };
  }
  return null;
}

/** Hex dump, e.g. "2C FE D4". */
export function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
