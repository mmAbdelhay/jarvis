import type { FaviconStore } from "@jarvis/platform";

/** A favicon is a few kilobytes; 128 KB is generous for one and still small
 *  enough that the worst case costs nothing. The cap is not about the single
 *  request: whatever comes back is stored and then shipped over IPC inside
 *  *every* listBookmarks result for that project, for as long as the entry
 *  lives. A 20 MB body at /favicon.ico — hostile, misconfigured, or an HTML
 *  error page served with 200 — would make every sidebar redraw a
 *  multi-megabyte payload. */
export const MAX_FAVICON_BYTES = 128 * 1024;

/** The response shape this needs, which Electron's `Session.fetch` result
 *  satisfies — declared structurally so the fetch path is testable in plain
 *  Vitest with no Electron and no network. */
export type FaviconResponse = {
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
};

/** Whatever the icon is fetched *through* — a project's own session
 *  partition in main.ts, so a site reachable only there (SSO, a VPN-scoped
 *  profile) is not fetched against the wrong one. */
export type FaviconFetcher = { fetch(url: string): Promise<FaviconResponse> };

/** `image/svg+xml; charset=utf-8` is a valid content type and a broken data
 *  uri prefix — the parameters have to come off before the type is spliced
 *  into `data:<type>;base64,`. */
function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Fetches `iconUrl` through `from` and caches it against `pageUrl`'s origin.
 *
 * Every way this can fail — a bad status, a body that is not an image, a
 * body too large to be one, an unreachable host — records a miss instead,
 * so the origin is not refetched on every render and the tile falls back to
 * its monogram. None of it is surfaced: there is nothing the user could act
 * on.
 */
export async function cacheFavicon(
  favicons: FaviconStore,
  pageUrl: string,
  iconUrl: string,
  from: FaviconFetcher,
): Promise<void> {
  try {
    const response = await from.fetch(iconUrl);
    if (!response.ok) {
      await favicons.putMiss(pageUrl);
      return;
    }

    // A missing content-type is not taken as permission: /favicon.ico
    // serving an HTML error page with a 200 is exactly the case this
    // rejects, and it is common enough that guessing "image/png" would let
    // the whole page through as an icon.
    const type = mediaType(response.headers.get("content-type") ?? "");
    if (!type.startsWith("image/")) {
      await favicons.putMiss(pageUrl);
      return;
    }

    // Checked before the body is read where the server declared it, and
    // again against what actually arrived — a content-length may be absent
    // or may lie.
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(declared) && declared > MAX_FAVICON_BYTES) {
      await favicons.putMiss(pageUrl);
      return;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_FAVICON_BYTES) {
      await favicons.putMiss(pageUrl);
      return;
    }

    await favicons.put(pageUrl, bytes, type);
  } catch {
    // Unreachable host or malformed icon url.
    await favicons.putMiss(pageUrl);
  }
}
