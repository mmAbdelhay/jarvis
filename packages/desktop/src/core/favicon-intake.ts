import type { FaviconOutcome, FaviconStore } from "@jarvis/platform";

/** The most a favicon may weigh once decoded. favicon-fetch.ts already caps
 *  what the app fetches at 128 KiB; this is the core's own limit on what it
 *  accepts from any app, generous enough never to refuse an honest one. */
export const MAX_FAVICON_INTAKE_BYTES = 256 * 1024;

/** Longest base64 text that can decode to the cap: 4 characters per 3 bytes,
 *  rounded up to a whole quantum. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_FAVICON_INTAKE_BYTES / 3) * 4;

/** Standard base64 with padding, whole quanta only. Buffer.from would
 *  silently skip anything else and store garbage. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** What the core offers an app for its favicon fetches. The icon crosses as
 *  base64 text, because CoreClient carries JSON values only. */
export type FaviconIntake = {
  put(pageUrl: string, base64: string, contentType: string): Promise<FaviconOutcome<void>>;
  putMiss(pageUrl: string): Promise<FaviconOutcome<void>>;
};

/** The store behind CoreClient.favicons: decodes the text back into bytes,
 *  refusing what is not base64 or is over the cap before the store sees it. */
export function faviconIntake(store: Pick<FaviconStore, "put" | "putMiss">): FaviconIntake {
  return {
    async put(pageUrl, base64, contentType) {
      if (typeof base64 !== "string" || !BASE64.test(base64)) {
        return { ok: false, detail: "favicon is not base64" };
      }
      if (base64.length > MAX_BASE64_LENGTH) return { ok: false, detail: "favicon too large" };
      const bytes = new Uint8Array(Buffer.from(base64, "base64"));
      if (bytes.byteLength > MAX_FAVICON_INTAKE_BYTES) {
        return { ok: false, detail: "favicon too large" };
      }
      return store.put(pageUrl, bytes, contentType);
    },
    putMiss: (pageUrl) => store.putMiss(pageUrl),
  };
}
