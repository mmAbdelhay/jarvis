import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile, downloadText } from "./update-download.js";

// Lets a test make the next file write fail like a full disk.
const failWrites = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (!failWrites.on) return handle;
      return Object.assign(Object.create(handle), {
        write: async () => {
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        },
        close: () => handle.close(),
      });
    },
  };
});

/** A body that never ends on its own and records whether it was cancelled. */
function trackedBody() {
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("abc"));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const BASE = "https://github.com/mmAbdelhay/jarvis/releases/download/v0.1.9/";
const ASSET = `${BASE}Jarvis-0.1.9-arm64.dmg`;
const CDN = "https://objects.githubusercontent.com/some/blob";

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that answers from a url → route table and records what it saw. */
function fakeFetch(routes: Record<string, Route>) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return route(init);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

function body(chunks: (string | Error)[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const next = chunks[i++];
      if (next instanceof Error) controller.error(next);
      else controller.enqueue(new TextEncoder().encode(next));
    },
  });
}

const ok =
  (chunks: (string | Error)[], headers: Record<string, string> = {}): Route =>
  () =>
    new Response(body(chunks), { status: 200, headers });

const redirect =
  (location: string): Route =>
  () =>
    new Response(null, { status: 302, headers: { location } });

let dir: string;
let dest: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-dl-"));
  dest = join(dir, "Jarvis-0.1.9-arm64.dmg");
});
afterEach(() => {
  failWrites.on = false;
  rmSync(dir, { recursive: true, force: true });
});

function run(
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof downloadFile>[0]> = {},
) {
  const progress: [number, number | undefined][] = [];
  const result = downloadFile({
    url: ASSET,
    dest,
    signal: new AbortController().signal,
    onProgress: (received, total) => progress.push([received, total]),
    fetch,
    ...extra,
  });
  return { result, progress };
}

describe("downloadFile", () => {
  it("writes the file through a CDN redirect and reports progress", async () => {
    const { fetch, seen } = fakeFetch({
      [ASSET]: redirect(CDN),
      [CDN]: ok(["abc", "defg"], { "content-length": "7" }),
    });
    const { result, progress } = run(fetch, { expectedSize: 7 });
    expect(await result).toEqual({ ok: true });
    expect(readFileSync(dest, "utf8")).toBe("abcdefg");
    expect(readdirSync(dir)).toEqual(["Jarvis-0.1.9-arm64.dmg"]);
    expect(progress).toEqual([
      [3, 7],
      [7, 7],
    ]);
    expect(seen.map((s) => s.init?.redirect)).toEqual(["manual", "manual"]);
  });

  it("reports an unknown total when there is no length or expected size", async () => {
    const { fetch } = fakeFetch({ [ASSET]: ok(["ab"]) });
    const { result, progress } = run(fetch);
    expect(await result).toEqual({ ok: true });
    expect(progress).toEqual([[2, undefined]]);
  });

  it("refuses an initial url outside the release downloads", async () => {
    const { fetch, seen } = fakeFetch({});
    const { result } = run(fetch, { url: "https://evil.example/Jarvis.dmg" });
    expect(await result).toEqual({ ok: false, reason: "refused-url" });
    expect(seen).toEqual([]);
  });

  it("allows the test origin for the initial url only when given", async () => {
    const local = "http://127.0.0.1:4567/Jarvis.dmg";
    const { fetch } = fakeFetch({ [local]: ok(["x"]) });
    expect(await run(fetch, { url: local }).result).toEqual({ ok: false, reason: "refused-url" });
    expect(await run(fetch, { url: local, testOrigin: "http://127.0.0.1:4567" }).result).toEqual({
      ok: true,
    });
  });

  it("refuses a foreign redirect and leaves no file", async () => {
    const { fetch, seen } = fakeFetch({
      [ASSET]: redirect("https://evil.example/blob"),
      "https://evil.example/blob": ok(["bad"]),
    });
    expect(await run(fetch).result).toEqual({ ok: false, reason: "refused-redirect" });
    expect(seen).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a plain-http redirect to the CDN host", async () => {
    const { fetch } = fakeFetch({ [ASSET]: redirect("http://objects.githubusercontent.com/x") });
    expect(await run(fetch).result).toEqual({ ok: false, reason: "refused-redirect" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a redirect to the test origin even when the test origin is set", async () => {
    const { fetch } = fakeFetch({ [ASSET]: redirect("http://127.0.0.1:4567/x") });
    const { result } = run(fetch, { testOrigin: "http://127.0.0.1:4567" });
    expect(await result).toEqual({ ok: false, reason: "refused-redirect" });
  });

  it("follows five redirects but refuses a sixth", async () => {
    const hops = (n: number) => {
      const routes: Record<string, Route> = { [ASSET]: redirect(`${CDN}/1`) };
      for (let i = 1; i < n; i++) routes[`${CDN}/${i}`] = redirect(`${CDN}/${i + 1}`);
      routes[`${CDN}/${n}`] = ok(["done"]);
      return fakeFetch(routes).fetch;
    };
    expect(await run(hops(5)).result).toEqual({ ok: true });
    rmSync(dest);
    expect(await run(hops(6)).result).toEqual({ ok: false, reason: "refused-redirect" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("treats a non-2xx answer or a redirect without a location as http", async () => {
    const notFound = fakeFetch({});
    expect(await run(notFound.fetch).result).toEqual({ ok: false, reason: "http" });
    const noLocation = fakeFetch({ [ASSET]: () => new Response(null, { status: 302 }) });
    expect(await run(noLocation.fetch).result).toEqual({ ok: false, reason: "http" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("treats a failed request as http", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    expect(await run(fetch).result).toEqual({ ok: false, reason: "http" });
  });

  it("deletes the partial file when aborted mid-download", async () => {
    const controller = new AbortController();
    let sawPart = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("abc"));
      },
      // Never delivers more: only the abort can end this download.
      pull: () => new Promise(() => {}),
    });
    const { fetch } = fakeFetch({ [ASSET]: () => new Response(stream, { status: 200 }) });
    const result = downloadFile({
      url: ASSET,
      dest,
      signal: controller.signal,
      onProgress: () => {
        sawPart = existsSync(`${dest}.part`);
        setTimeout(() => controller.abort(), 0);
      },
      fetch,
    });
    expect(await result).toEqual({ ok: false, reason: "aborted" });
    expect(sawPart).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("is aborted without fetching when the signal already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, seen } = fakeFetch({ [ASSET]: ok(["x"]) });
    const { result } = run(fetch, { signal: controller.signal });
    expect(await result).toEqual({ ok: false, reason: "aborted" });
    expect(seen).toEqual([]);
  });

  it("reports a stream error as io and leaves no partial", async () => {
    const { fetch } = fakeFetch({ [ASSET]: ok(["abc", new Error("reset")]) });
    expect(await run(fetch).result).toEqual({ ok: false, reason: "io" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reports a size mismatch with the expected size", async () => {
    const short = fakeFetch({ [ASSET]: ok(["abc"]) });
    expect(await run(short.fetch, { expectedSize: 7 }).result).toEqual({
      ok: false,
      reason: "size",
    });
    expect(readdirSync(dir)).toEqual([]);
    const long = fakeFetch({ [ASSET]: ok(["abcd", "efgh", "ijkl"]) });
    expect(await run(long.fetch, { expectedSize: 5 }).result).toEqual({
      ok: false,
      reason: "size",
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a dest that is not a plain file name in its directory", async () => {
    const { fetch, seen } = fakeFetch({ [ASSET]: ok(["x"]) });
    for (const bad of [`${dir}/a/../b.dmg`, `${dir}/..`, `${dir}/.`, `${dir}/x/`]) {
      expect(await run(fetch, { dest: bad }).result).toEqual({ ok: false, reason: "io" });
    }
    expect(seen).toEqual([]);
  });

  it("reports io when the destination directory does not exist", async () => {
    const { fetch } = fakeFetch({ [ASSET]: ok(["x"]) });
    const { result } = run(fetch, { dest: join(dir, "missing", "a.dmg") });
    expect(await result).toEqual({ ok: false, reason: "io" });
  });
});

describe("downloadFile releases the response stream", () => {
  it("cancels the body and leaves no partial when a write fails", async () => {
    const { stream, state } = trackedBody();
    const { fetch } = fakeFetch({ [ASSET]: () => new Response(stream, { status: 200 }) });
    failWrites.on = true;
    expect(await run(fetch).result).toEqual({ ok: false, reason: "io" });
    expect(state.cancelled).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("cancels the body when the partial file cannot be opened", async () => {
    const { stream, state } = trackedBody();
    const { fetch } = fakeFetch({ [ASSET]: () => new Response(stream, { status: 200 }) });
    const { result } = run(fetch, { dest: join(dir, "missing", "a.dmg") });
    expect(await result).toEqual({ ok: false, reason: "io" });
    expect(state.cancelled).toBe(true);
  });
});

describe("downloadText", () => {
  const SUMS = `${BASE}SHA256SUMS`;

  it("returns the text through an allowed redirect", async () => {
    const { fetch } = fakeFetch({ [SUMS]: redirect(CDN), [CDN]: ok(["abc  x\n"]) });
    expect(await downloadText(SUMS, fetch)).toBe("abc  x\n");
  });

  it("returns undefined for a refused url, a refused redirect, or http errors", async () => {
    const { fetch } = fakeFetch({
      [SUMS]: redirect("https://evil.example/x"),
      "https://evil.example/x": ok(["x"]),
    });
    expect(await downloadText("https://evil.example/x", fetch)).toBeUndefined();
    expect(await downloadText(SUMS, fetch)).toBeUndefined();
    expect(await downloadText(`${BASE}missing`, fetch)).toBeUndefined();
  });

  it("returns undefined past 64 KB", async () => {
    const chunk = "a".repeat(16 * 1024);
    const exact = fakeFetch({ [SUMS]: ok([chunk, chunk, chunk, chunk]) });
    expect((await downloadText(SUMS, exact.fetch))?.length).toBe(64 * 1024);
    const over = fakeFetch({ [SUMS]: ok([chunk, chunk, chunk, chunk, "a"]) });
    expect(await downloadText(SUMS, over.fetch)).toBeUndefined();
  });

  it("returns undefined on a stream error", async () => {
    const { fetch } = fakeFetch({ [SUMS]: ok(["a", new Error("reset")]) });
    expect(await downloadText(SUMS, fetch)).toBeUndefined();
  });

  it("honours the test origin for the initial url", async () => {
    const local = "http://127.0.0.1:4567/SHA256SUMS";
    const { fetch } = fakeFetch({ [local]: ok(["hi"]) });
    expect(await downloadText(local, fetch)).toBeUndefined();
    expect(await downloadText(local, fetch, { testOrigin: "http://127.0.0.1:4567" })).toBe("hi");
  });
});
