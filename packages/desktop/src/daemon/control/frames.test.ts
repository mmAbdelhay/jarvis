import { describe, expect, it } from "vitest";
import {
  encodeBinaryFrame,
  encodeJsonFrame,
  FrameDecoder,
  FrameError,
  MAX_CONTROL_FRAME_BYTES,
} from "./frames.js";

function drain(decoder: FrameDecoder): unknown[] {
  const out: unknown[] = [];
  for (let frame = decoder.next(); frame !== undefined; frame = decoder.next()) out.push(frame);
  return out;
}

describe("control frames", () => {
  it("round-trips JSON and binary frames split at every byte", () => {
    const wire = Buffer.concat([
      encodeJsonFrame({ t: "req", id: 1, ch: "a:b", a: [] }),
      ...encodeBinaryFrame(new Uint8Array([1, 2, 3])),
      encodeJsonFrame({ t: "bye" }),
    ]);
    const decoder = new FrameDecoder(1024);
    const frames: unknown[] = [];
    for (const byte of wire) {
      decoder.push(Buffer.from([byte]));
      frames.push(...drain(decoder));
    }
    expect(frames).toEqual([
      { kind: "json", value: { t: "req", id: 1, ch: "a:b", a: [] } },
      { kind: "binary", bytes: Buffer.from([1, 2, 3]) },
      { kind: "json", value: { t: "bye" } },
    ]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("rejects a frame larger than the current limit from its header alone", () => {
    const decoder = new FrameDecoder(16);
    decoder.push(encodeJsonFrame({ t: "hello", padding: "x".repeat(64) }).subarray(0, 5));
    expect(() => decoder.next()).toThrow(FrameError);
  });

  it("applies a raised limit to the next frame", () => {
    const big = encodeJsonFrame({ v: "x".repeat(100) });
    const decoder = new FrameDecoder(16);
    decoder.push(Buffer.concat([encodeJsonFrame(1), big]));
    expect(decoder.next()).toEqual({ kind: "json", value: 1 });
    decoder.maxBytes = 1024;
    expect(decoder.next()).toEqual({ kind: "json", value: { v: "x".repeat(100) } });
  });

  it("rejects an unknown frame kind, malformed JSON and an empty JSON frame", () => {
    const kind = new FrameDecoder(64);
    kind.push(Buffer.from([0, 0, 0, 1, 9, 0]));
    expect(() => kind.next()).toThrow(FrameError);

    const json = new FrameDecoder(64);
    json.push(Buffer.from([0, 0, 0, 1, 0, 0x7b]));
    expect(() => json.next()).toThrow(FrameError);

    const empty = new FrameDecoder(64);
    empty.push(Buffer.from([0, 0, 0, 0, 0]));
    expect(() => empty.next()).toThrow(FrameError);
  });

  it("refuses to encode a JSON frame over the 16 MiB limit", () => {
    expect(MAX_CONTROL_FRAME_BYTES).toBe(16 * 1024 * 1024);
    expect(() => encodeJsonFrame("x".repeat(MAX_CONTROL_FRAME_BYTES))).toThrow(FrameError);
  });
});
