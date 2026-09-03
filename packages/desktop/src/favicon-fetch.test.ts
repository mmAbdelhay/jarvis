import { describe, expect, it } from "vitest";
import type { FaviconStore } from "@jarvis/platform";
import { cacheFavicon, MAX_FAVICON_BYTES, type FaviconResponse } from "./favicon-fetch.js";

type Put = { url: string; bytes: Uint8Array; type: string };

function recordingStore(): { store: FaviconStore; puts: Put[]; misses: string[] } {
  const puts: Put[] = [];
  const misses: string[] = [];
  const store: FaviconStore = {
    get: async () => ({ ok: true, value: undefined }),
    put: async (url, bytes, type) => {
      puts.push({ url, bytes, type });
      return { ok: true, value: undefined };
    },
    putMiss: async (url) => {
      misses.push(url);
      return { ok: true, value: undefined };
    },
    shouldFetch: async () => ({ ok: true, value: true }),
  };
  return { store, puts, misses };
}

/** One canned response, with only the three things cacheFavicon reads. */
function response(overrides: {
  ok?: boolean;
  headers?: Record<string, string>;
  body?: Uint8Array;
}): FaviconResponse {
  const headers = overrides.headers ?? {};
  const body = overrides.body ?? new Uint8Array([1, 2, 3]);
  return {
    ok: overrides.ok ?? true,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  };
}

function fetcher(result: FaviconResponse | Error): { fetch(url: string): Promise<FaviconResponse> } {
  return {
    fetch: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("cacheFavicon", () => {
  it("stores an image body against the page's origin", async () => {
    const { store, puts } = recordingStore();

    await cacheFavicon(store, "https://a.test/page", "https://a.test/favicon.ico", fetcher(
      response({ headers: { "content-type": "image/png" }, body: new Uint8Array([9, 9]) }),
    ));

    expect(puts).toEqual([
      { url: "https://a.test/page", bytes: new Uint8Array([9, 9]), type: "image/png" },
    ]);
  });

  // `image/svg+xml; charset=utf-8` is a valid content type and a broken
  // data-uri prefix — the parameters used to land in the stored uri verbatim.
  it("strips the parameters off the content type", async () => {
    const { store, puts } = recordingStore();

    await cacheFavicon(store, "https://a.test/page", "https://a.test/icon.svg", fetcher(
      response({ headers: { "content-type": "image/svg+xml; charset=utf-8" } }),
    ));

    expect(puts[0]?.type).toBe("image/svg+xml");
  });

  // The classic case: /favicon.ico serving the site's HTML 404 page with a
  // 200. Storing that would ship a whole page over IPC on every redraw.
  it("refuses a body that is not an image, and records a miss", async () => {
    const { store, puts, misses } = recordingStore();

    await cacheFavicon(store, "https://a.test/page", "https://a.test/favicon.ico", fetcher(
      response({ headers: { "content-type": "text/html" } }),
    ));

    expect(puts).toEqual([]);
    expect(misses).toEqual(["https://a.test/page"]);
  });

  it("refuses a body with no content type at all", async () => {
    const { store, puts, misses } = recordingStore();

    await cacheFavicon(store, "https://a.test/page", "https://a.test/favicon.ico", fetcher(response({})));

    expect(puts).toEqual([]);
    expect(misses).toEqual(["https://a.test/page"]);
  });

  it("refuses a body larger than the cap, and records a miss", async () => {
    const { store, puts, misses } = recordingStore();

    await cacheFavicon(store, "https://a.test/page", "https://a.test/favicon.ico", fetcher(
      response({
        headers: { "content-type": "image/png" },
        body: new Uint8Array(MAX_FAVICON_BYTES + 1),
      }),
    ));

    expect(puts).toEqual([]);
    expect(misses).toEqual(["https://a.test/page"]);
  });

  // A declared length is cheaper to refuse on than a body that has to be
  // read first — but it may also be absent, or a lie, which is why the
  // measured length is checked too (the test above).
  it("refuses on a declared content-length over the cap", async () => {
    const { store, puts, misses } = recordingStore();

    await cacheFavicon(store, "https://a.test/page", "https://a.test/favicon.ico", fetcher(
      response({
        headers: { "content-type": "image/png", "content-length": String(MAX_FAVICON_BYTES + 1) },
      }),
    ));

    expect(puts).toEqual([]);
    expect(misses).toEqual(["https://a.test/page"]);
  });

  it("accepts a body exactly at the cap", async () => {
    const { store, puts } = recordingStore();

    await cacheFavicon(store, "https://a.test/page", "https://a.test/favicon.ico", fetcher(
      response({
        headers: { "content-type": "image/png" },
        body: new Uint8Array(MAX_FAVICON_BYTES),
      }),
    ));

    expect(puts).toHaveLength(1);
  });

  it("records a miss on a bad status", async () => {
    const { store, puts, misses } = recordingStore();

    await cacheFavicon(store, "https://a.test/page", "https://a.test/favicon.ico", fetcher(
      response({ ok: false, headers: { "content-type": "image/png" } }),
    ));

    expect(puts).toEqual([]);
    expect(misses).toEqual(["https://a.test/page"]);
  });

  it("records a miss when the host is unreachable", async () => {
    const { store, misses } = recordingStore();

    await cacheFavicon(
      store,
      "https://a.test/page",
      "https://a.test/favicon.ico",
      fetcher(new Error("ENOTFOUND")),
    );

    expect(misses).toEqual(["https://a.test/page"]);
  });
});
