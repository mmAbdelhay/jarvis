// Test double for the provider adapters: a Response whose body arrives in
// small chunks (so every reader is exercised across chunk boundaries), and a
// fetch that records what it was asked. Not exported from any barrel.
import type { FetchLike } from "./http.js";

export function streamResponse(
  text: string,
  options: { chunkSize?: number; status?: number; contentType?: string } = {},
): Response {
  const bytes = new TextEncoder().encode(text);
  const size = options.chunkSize ?? 7;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
  return new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": options.contentType ?? "text/event-stream" },
  });
}

export function recordingFetch(responses: Array<Response | Error>): {
  fetch: FetchLike;
  calls: { url: string; init: Parameters<FetchLike>[1] }[];
} {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const queue = [...responses];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected fetch ${url}`);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
