import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import { createWriteBatcher, WRITE_BATCH_MAX_CHARS, WRITE_BATCH_MS } from "./write-batcher";

describe("createWriteBatcher", () => {
  it("coalesces two writes within WRITE_BATCH_MS into one flush", () => {
    const clock = createFakeClock();
    const flushed: string[] = [];
    const batcher = createWriteBatcher({ clock, flush: (data) => flushed.push(data) });

    batcher.write("a");
    batcher.write("b");
    expect(flushed).toEqual([]);

    clock.advance(WRITE_BATCH_MS);
    expect(flushed).toEqual(["ab"]);
  });

  it("flushes 65536 chars immediately and the rest after WRITE_BATCH_MS", () => {
    const clock = createFakeClock();
    const flushed: string[] = [];
    const batcher = createWriteBatcher({ clock, flush: (data) => flushed.push(data) });

    const data = "x".repeat(70_000);
    batcher.write(data);

    expect(flushed).toEqual([data.slice(0, WRITE_BATCH_MAX_CHARS)]);

    clock.advance(WRITE_BATCH_MS);
    expect(flushed).toEqual([
      data.slice(0, WRITE_BATCH_MAX_CHARS),
      data.slice(WRITE_BATCH_MAX_CHARS),
    ]);
  });

  it("never splits a surrogate pair straddling the 65536 boundary", () => {
    const clock = createFakeClock();
    const flushed: string[] = [];
    const batcher = createWriteBatcher({ clock, flush: (data) => flushed.push(data) });

    // An astral character (surrogate pair) placed exactly across the cut.
    const astral = "\u{1F600}"; // 2 UTF-16 units
    const prefix = "x".repeat(WRITE_BATCH_MAX_CHARS - 1);
    const suffix = "y".repeat(10);
    const data = prefix + astral + suffix;

    batcher.write(data);

    expect(flushed.length).toBe(1);
    const flushedText = flushed[0] ?? "";
    // The chunk must not end mid-surrogate-pair.
    expect(flushedText.length).toBeLessThan(WRITE_BATCH_MAX_CHARS);
    expect(flushedText.endsWith(astral) || !flushedText.endsWith(astral[0] ?? "")).toBe(true);

    clock.advance(WRITE_BATCH_MS);
    expect(flushed.join("")).toBe(data);
    for (const chunk of flushed) {
      // No chunk should contain a lone surrogate half.
      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          expect(chunk.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        }
      }
    }
  });

  it("clear drops pending without flushing", () => {
    const clock = createFakeClock();
    const flushed: string[] = [];
    const batcher = createWriteBatcher({ clock, flush: (data) => flushed.push(data) });

    batcher.write("a");
    batcher.clear();
    clock.advance(WRITE_BATCH_MS * 2);
    expect(flushed).toEqual([]);
  });

  it("dispose stops any later flush", () => {
    const clock = createFakeClock();
    const flushed: string[] = [];
    const batcher = createWriteBatcher({ clock, flush: (data) => flushed.push(data) });

    batcher.write("a");
    batcher.dispose();
    clock.advance(WRITE_BATCH_MS * 2);
    expect(flushed).toEqual([]);
  });

  it("flushNow flushes pending immediately without waiting for the timer", () => {
    const clock = createFakeClock();
    const flushed: string[] = [];
    const batcher = createWriteBatcher({ clock, flush: (data) => flushed.push(data) });

    batcher.write("a");
    batcher.flushNow();
    expect(flushed).toEqual(["a"]);

    // The timer should have been disarmed; nothing more should flush later.
    clock.advance(WRITE_BATCH_MS * 2);
    expect(flushed).toEqual(["a"]);
  });
});
