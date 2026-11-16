/**
 * M15 framed standard output (docs/BLUE11_IO.md §3.5a): the program writes messages
 * `SOH type length body ETX` byte by byte into the TX device; mission control splits the
 * received stream into messages and marks the ones that did not arrive whole.
 * Headless and integer-only.
 */

import { TX_BOOT } from './downlink';

export const SOH = 0o001;
export const ETX = 0o003;

/** Message types 000–077 are reserved; 100–377 are the player's own. */
export const MsgType = {
  TEXT: 1,
  ERR: 2,
  LOG: 3,
  DATA: 4,
  IMG: 5,
  SPEC: 6,
} as const;
export const MSG_TYPE_NAMES: Record<number, string> = { 1: 'text', 2: 'error', 3: 'log', 4: 'data', 5: 'image', 6: 'spectrum' };

/**
 * `ok`: length and `ETX` match. `incomplete`: cut off by a reboot (decision 2). `broken`:
 * the length and the end code don't match (bytes lost when the FIFO was full), or bytes
 * outside any message (`type` null).
 */
export type MsgStatus = 'ok' | 'incomplete' | 'broken';

export interface ReceivedMessage {
  unitId: number;
  /** Tick its last byte arrived. */
  tick: number;
  type: number | null;
  body: number[];
  status: MsgStatus;
  /** M15: 'rec' for messages that came through the recorder (`RECBUF`); absent = the TX stream. */
  channel?: 'rec';
}

/**
 * M15 photo messages (ROM `SNDIMG`): a photo goes home as T.IMG messages of up to
 * {@link IMG_CHUNK} pixel bytes, each body `type, chunk, chunks, bytes…`.
 */
export const IMG_CHUNK = 128;

/** Messages mission control keeps (saved). */
export const MESSAGES_KEEP = 200;

/** Parser state (saved, so a message split across a save arrives whole). */
export interface ParserState {
  /** 0 idle, 1 type next, 2 length next, 3 body, 4 ETX next. */
  phase: number;
  type: number;
  length: number;
  body: number[];
  /** Bytes seen outside a message (reported as one broken message when the next starts). */
  stray: number[];
}

export const freshParser = (): ParserState => ({ phase: 0, type: 0, length: 0, body: [], stray: [] });

/** Feed received bytes (and {@link TX_BOOT} markers); returns the messages they completed. */
export function parseStream(st: ParserState, bytes: readonly number[], unitId: number, tick: number): ReceivedMessage[] {
  const out: ReceivedMessage[] = [];
  const emit = (type: number | null, body: number[], status: MsgStatus) => out.push({ unitId, tick, type, body, status });
  const flushStray = () => {
    if (st.stray.length) emit(null, st.stray, 'broken');
    st.stray = [];
  };
  const start = () => {
    flushStray();
    st.phase = 1;
    st.body = [];
  };
  for (const b of bytes) {
    if (b === TX_BOOT) {
      if (st.phase !== 0) emit(st.phase > 1 ? st.type : null, st.body, 'incomplete');
      flushStray();
      st.phase = 0;
      st.body = [];
      continue;
    }
    switch (st.phase) {
      case 0:
        if (b === SOH) start();
        else st.stray.push(b);
        break;
      case 1:
        st.type = b;
        st.phase = 2;
        break;
      case 2:
        st.length = b;
        st.phase = st.length ? 3 : 4;
        break;
      case 3:
        st.body.push(b);
        if (st.body.length >= st.length) st.phase = 4;
        break;
      default:
        if (b === ETX) {
          emit(st.type, st.body, 'ok');
          st.phase = 0;
          st.body = [];
        } else {
          emit(st.type, st.body, 'broken');
          st.phase = 0;
          st.body = [];
          if (b === SOH) start();
          else st.stray.push(b);
        }
    }
  }
  return out;
}

/** A text message's body as a string (printable ASCII; anything else as `\ooo`). */
export function messageText(body: readonly number[]): string {
  return body.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, '0')}`)).join('');
}
