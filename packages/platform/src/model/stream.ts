// Line and SSE readers over a fetch body. One TextDecoder in streaming mode
// for the whole body, so a multi-byte character split across reads is
// decoded once, whole (the same bug class platform/spawn.ts guards against).
import { ProviderError } from "@jarvis/core";

export const MAX_STREAM_LINE_CHARS = 1_048_576;

export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        if (newline > MAX_STREAM_LINE_CHARS) {
          throw new ProviderError("bad-response", "The provider sent a line that is too long");
        }
        yield buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > MAX_STREAM_LINE_CHARS) {
        throw new ProviderError("bad-response", "The provider sent a line that is too long");
      }
      if (done) break;
    }
    if (buffer !== "") yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

export type SseEvent = { event?: string; data: string };

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  const flush = (): SseEvent | undefined => {
    const out =
      data.length === 0
        ? undefined
        : { ...(event === undefined ? {} : { event }), data: data.join("\n") };
    event = undefined;
    data = [];
    return out;
  };
  for await (const line of readLines(body)) {
    if (line === "") {
      const out = flush();
      if (out !== undefined) yield out;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  const out = flush();
  if (out !== undefined) yield out;
}
