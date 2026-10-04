// Fetching a release's files. Every request goes out with `redirect:
// "manual"` so each hop can be checked: the first url must be under the
// project's release downloads, and every redirect must land on GitHub's asset
// CDN. The installer is streamed to `<dest>.part` and renamed into place only
// once it is complete and the expected size; any failure removes the partial.

import { open, rename, rm } from "node:fs/promises";
import { basename, normalize } from "node:path";
import { isAllowedDownloadUrl, isAllowedRedirect } from "./update-asset.js";

const MAX_REDIRECTS = 5;
const TEXT_LIMIT = 64 * 1024;

export type DownloadFailure =
  | "refused-url"
  | "refused-redirect"
  | "http"
  | "aborted"
  | "io"
  | "size";
export type DownloadResult = { ok: true } | { ok: false; reason: DownloadFailure };

export type DownloadOptions = {
  url: string;
  dest: string;
  expectedSize?: number;
  signal: AbortSignal;
  onProgress(received: number, total: number | undefined): void;
  fetch: typeof fetch;
  /** Development override passed to `isAllowedDownloadUrl` for the first url. */
  testOrigin?: string;
};

type Fetched = { ok: true; response: Response } | { ok: false; reason: DownloadFailure };

/** Requests `url`, following up to five checked redirects, and returns the
 *  final 2xx response. A request that rejects counts as `http` (network). */
async function fetchChecked(
  url: string,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  testOrigin: string | undefined,
): Promise<Fetched> {
  if (!isAllowedDownloadUrl(url, { testOrigin })) return { ok: false, reason: "refused-url" };
  let current = url;
  for (let hop = 0; ; hop++) {
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    let response: Response;
    try {
      response = await fetchFn(current, { redirect: "manual", signal });
    } catch {
      return { ok: false, reason: signal?.aborted ? "aborted" : "http" };
    }
    if (response.status >= 200 && response.status < 300) return { ok: true, response };
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 300 || response.status >= 400 || location === null) {
      return { ok: false, reason: "http" };
    }
    let next: string;
    try {
      next = new URL(location, current).href;
    } catch {
      return { ok: false, reason: "refused-redirect" };
    }
    if (hop >= MAX_REDIRECTS || !isAllowedRedirect(next)) {
      return { ok: false, reason: "refused-redirect" };
    }
    current = next;
  }
}

/** `dest` must name a plain file: no `..` segment, no trailing separator,
 *  and not `.`/`..` itself. */
function isPlainDest(dest: string): boolean {
  const name = basename(dest);
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !/[\\/]$/.test(dest) &&
    name === basename(normalize(dest)) &&
    !dest.split(/[\\/]/).includes("..")
  );
}

/** Reads `body` chunk by chunk; `onChunk` returning false stops early.
 *  An abort on `signal` cancels a read that is still waiting. */
async function pump(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onChunk: (chunk: Uint8Array) => Promise<boolean> | boolean,
): Promise<void> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error("aborted");
      if (done) return;
      if (!(await onChunk(value))) {
        cancel();
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  if (!isPlainDest(opts.dest)) return { ok: false, reason: "io" };
  const fetched = await fetchChecked(opts.url, opts.fetch, opts.signal, opts.testOrigin);
  if (!fetched.ok) return fetched;
  const { response } = fetched;

  const header = Number(response.headers.get("content-length"));
  const total =
    opts.expectedSize ??
    (response.headers.has("content-length") && header >= 0 ? header : undefined);
  const part = `${opts.dest}.part`;
  let received = 0;
  let oversize = false;
  let failure: DownloadFailure | undefined;

  try {
    const file = await open(part, "w");
    try {
      if (response.body !== null) {
        await pump(response.body, opts.signal, async (chunk) => {
          received += chunk.byteLength;
          if (opts.expectedSize !== undefined && received > opts.expectedSize) {
            oversize = true;
            return false;
          }
          await file.write(chunk);
          opts.onProgress(received, total);
          return true;
        });
      }
    } finally {
      await file.close();
    }
    if (oversize || (opts.expectedSize !== undefined && received !== opts.expectedSize)) {
      failure = "size";
    } else {
      await rename(part, opts.dest);
      return { ok: true };
    }
  } catch {
    failure = opts.signal.aborted ? "aborted" : "io";
  }
  await rm(part, { force: true }).catch(() => undefined);
  return { ok: false, reason: failure };
}

/** A small text file (e.g. `SHA256SUMS`, at most 64 KB) from a release, or
 *  undefined on any refusal or failure. */
export async function downloadText(
  url: string,
  fetchFn: typeof fetch,
  opts: { testOrigin?: string } = {},
): Promise<string | undefined> {
  const fetched = await fetchChecked(url, fetchFn, undefined, opts.testOrigin);
  if (!fetched.ok || fetched.response.body === null) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    await pump(fetched.response.body, undefined, (chunk) => {
      size += chunk.byteLength;
      if (size > TEXT_LIMIT) return false;
      chunks.push(chunk);
      return true;
    });
  } catch {
    return undefined;
  }
  if (size > TEXT_LIMIT) return undefined;
  return new TextDecoder().decode(Buffer.concat(chunks));
}
