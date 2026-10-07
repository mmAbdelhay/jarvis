import { describe, expect, it } from "vitest";
import { streamResponse } from "./http-double.js";
import { readLines, readSse } from "./stream.js";

async function all<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const bodyOf = (text: string, chunkSize: number) => {
  const body = streamResponse(text, { chunkSize }).body;
  if (body === null) throw new Error("no body");
  return body;
};

describe("readLines", () => {
  it("reassembles lines and multi-byte characters split across chunks", async () => {
    const text = '{"a":"الشبكة"}\r\n{"b":2}\n\n{"c":3}';
    for (const size of [1, 2, 3, 7, 64]) {
      expect(await all(readLines(bodyOf(text, size)))).toEqual([
        '{"a":"الشبكة"}',
        '{"b":2}',
        "",
        '{"c":3}',
      ]);
    }
  });

  it("refuses a line longer than the cap", async () => {
    await expect(all(readLines(bodyOf("x".repeat(1_048_577), 65_536)))).rejects.toThrow(/too long/);
  });
  it("refuses an oversized complete line arriving in one chunk", async () => {
    const text = `${"x".repeat(1_048_577)}\n`;
    await expect(all(readLines(bodyOf(text, text.length)))).rejects.toThrow(/too long/);
  });
});

describe("readSse", () => {
  it("yields one event per blank line, joining multi-line data and skipping comments", async () => {
    const text = ': keep-alive\nevent: one\ndata: {"a":\ndata: 1}\n\ndata: [DONE]\n\n';
    expect(await all(readSse(bodyOf(text, 3)))).toEqual([
      { event: "one", data: '{"a":\n1}' },
      { data: "[DONE]" },
    ]);
  });

  it("flushes a final event with no trailing blank line", async () => {
    expect(await all(readSse(bodyOf("data: last", 2)))).toEqual([{ data: "last" }]);
  });
});
