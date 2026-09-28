// The control transport's framing. A byte stream (Unix socket / named pipe)
// has no message boundaries of its own, so every frame is a 5-byte header —
// payload length (u32 big-endian) then a kind byte — and its payload: UTF-8
// JSON carrying the @jarvis/wire message shapes, or raw bytes for a blob
// chunk. The decoder checks the declared length against its current limit
// from the header alone, before buffering the payload, so a peer can never
// make it hold more than one frame's worth of bytes.
//
// Frozen contract: this 5-byte header, like the handshake frames in
// messages.ts, cannot change with CONTROL_PROTOCOL_VERSION — a version
// mismatch is reported through it.
export const CONTROL_PROTOCOL_VERSION = 1;
export const MAX_CONTROL_FRAME_BYTES = 16 * 1024 * 1024;
/** Until the hello is accepted, nothing bigger than a hello is buffered. */
export const MAX_HELLO_FRAME_BYTES = 4_096;

const HEADER_BYTES = 5;
const JSON_KIND = 0;
const BINARY_KIND = 1;

export type Frame = { kind: "json"; value: unknown } | { kind: "binary"; bytes: Buffer };

export class FrameError extends Error {}

function header(length: number, kind: number): Buffer {
  const out = Buffer.allocUnsafe(HEADER_BYTES);
  out.writeUInt32BE(length, 0);
  out[4] = kind;
  return out;
}

export function encodeJsonFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > MAX_CONTROL_FRAME_BYTES) throw new FrameError("frame too large");
  return Buffer.concat([header(payload.byteLength, JSON_KIND), payload]);
}

/** Header and payload apart, so a large chunk is written without a copy. */
export function encodeBinaryFrame(bytes: Uint8Array): [Buffer, Uint8Array] {
  if (bytes.byteLength > MAX_CONTROL_FRAME_BYTES) throw new FrameError("frame too large");
  return [header(bytes.byteLength, BINARY_KIND), bytes];
}

export class FrameDecoder {
  #chunks: Buffer[] = [];
  #total = 0;
  #pending: { length: number; kind: number } | undefined;

  /** Checked per frame header, so raising it (after the hello) applies to the next frame. */
  constructor(public maxBytes: number) {}

  get bufferedBytes(): number {
    return this.#total;
  }

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.#chunks.push(chunk);
    this.#total += chunk.byteLength;
  }

  /** The next complete frame, or undefined until more bytes arrive. Throws FrameError. */
  next(): Frame | undefined {
    if (this.#pending === undefined) {
      if (this.#total < HEADER_BYTES) return undefined;
      const head = this.#take(HEADER_BYTES);
      const length = head.readUInt32BE(0);
      const kind = head[4] ?? -1;
      if (kind !== JSON_KIND && kind !== BINARY_KIND) throw new FrameError("unknown frame kind");
      if (length > this.maxBytes) throw new FrameError("frame too large");
      if (kind === JSON_KIND && length === 0) throw new FrameError("empty frame");
      this.#pending = { length, kind };
    }
    if (this.#total < this.#pending.length) return undefined;
    const { length, kind } = this.#pending;
    this.#pending = undefined;
    const payload = this.#take(length);
    if (kind === BINARY_KIND) return { kind: "binary", bytes: payload };
    try {
      return { kind: "json", value: JSON.parse(payload.toString("utf8")) };
    } catch {
      throw new FrameError("malformed frame");
    }
  }

  #take(count: number): Buffer {
    this.#total -= count;
    const first = this.#chunks[0];
    if (first !== undefined && first.byteLength >= count) {
      if (first.byteLength === count) this.#chunks.shift();
      else this.#chunks[0] = first.subarray(count);
      return first.subarray(0, count);
    }
    const out = Buffer.allocUnsafe(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.#chunks[0];
      if (chunk === undefined) throw new FrameError("decoder underrun");
      const used = Math.min(chunk.byteLength, count - offset);
      chunk.copy(out, offset, 0, used);
      offset += used;
      if (used === chunk.byteLength) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(used);
    }
    return out;
  }
}
