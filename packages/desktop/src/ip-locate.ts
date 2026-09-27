/**
 * Fallback location for the prayer settings' "Use my location" button
 * (bug 5), used only after `navigator.geolocation` itself has already
 * failed or timed out in the renderer.
 *
 * Electron's `navigator.geolocation` resolves through Google's network
 * location service on Linux and Windows, which needs an API key Jarvis
 * does not ship — the error callback fires every single time there. macOS
 * instead depends on the OS's own CoreLocation permission, which a user can
 * deny. Either way, a coarse location derived from the machine's public IP
 * is a location the user can start from and correct by hand, which is
 * better than the button doing nothing.
 *
 * This is main-process only (remote-policy.ts marks the IPC channel that
 * wraps it desktop-only): it is an outbound network request, made only on
 * the user's own click, and only ever forwards the three fields below —
 * never the raw provider response.
 */
export type IpLocation = { latitude: number; longitude: number; name: string };

export type IpLocateResult = IpLocation | { error: string };

/** The response shape this needs — a plain `fetch` Response satisfies it,
 *  declared structurally so this is testable in plain Vitest with no
 *  Electron and no network (same seam as favicon-fetch.ts's
 *  FaviconResponse/FaviconFetcher). */
export type IpLocateResponse = { ok: boolean; json(): Promise<unknown> };

export type IpLocateFetcher = {
  fetch(url: string, init?: { signal?: AbortSignal }): Promise<IpLocateResponse>;
};

const IPAPI_CO_URL = "https://ipapi.co/json/";
const IPWHO_IS_URL = "https://ipwho.is/";

/** Each provider gets this long before its request is aborted and the next
 *  one (or the final failure) is tried. */
export const IP_LOCATE_TIMEOUT_MS = 6_000;

function inRange(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** The longest name shown to the user (e.g. in "Located by IP: <name>") —
 *  some providers return oddly long or malformed city/country strings, and
 *  this keeps the status text from overflowing. */
const MAX_PLACE_LENGTH = 80;

/** Joins whichever of city/country parsed as a non-empty string — either
 *  can be missing from a real response, and a raw `undefined`/`""` must
 *  never end up in the joined name. Capped at `MAX_PLACE_LENGTH` after
 *  trimming, so the cut never lands on padding whitespace. */
function place(...parts: unknown[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(", ")
    .trim()
    .slice(0, MAX_PLACE_LENGTH);
}

/**
 * ipapi.co's JSON shape on success: `{ latitude, longitude, city,
 * country_name, ... }`. On failure (rate-limited, reserved/bogon IP) it
 * instead returns `{ error: true, reason: "..." }` — no coordinates — which
 * this rejects the same way it rejects any other body with no in-range
 * `latitude`/`longitude` pair: by returning null rather than throwing, so
 * the caller can fall through to the next provider.
 */
export function parseIpApiCo(body: unknown): IpLocation | null {
  if (typeof body !== "object" || body === null) return null;
  const row = body as Record<string, unknown>;
  const { latitude, longitude } = row;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!inRange(latitude, longitude)) return null;
  return { latitude, longitude, name: place(row["city"], row["country_name"]) };
}

/**
 * ipwho.is's JSON shape on success: `{ success: true, latitude, longitude,
 * city, country, ... }`. On failure it returns `{ success: false, message:
 * "..." }` with no coordinates at all — checked explicitly (rather than
 * relying on `latitude`/`longitude` being absent) because `success` is the
 * field this provider itself uses to say "ignore everything else here".
 */
export function parseIpWhoIs(body: unknown): IpLocation | null {
  if (typeof body !== "object" || body === null) return null;
  const row = body as Record<string, unknown>;
  if (row["success"] === false) return null;
  const { latitude, longitude } = row;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!inRange(latitude, longitude)) return null;
  return { latitude, longitude, name: place(row["city"], row["country"]) };
}

async function fetchLocation(
  fetcher: IpLocateFetcher,
  url: string,
  parse: (body: unknown) => IpLocation | null,
): Promise<IpLocation | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IP_LOCATE_TIMEOUT_MS);
  try {
    const response = await fetcher.fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return parse(await response.json());
  } catch {
    // Unreachable host, an aborted (timed-out) request, or a body that is
    // not valid JSON — all the same "this provider didn't work" outcome.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tries ipapi.co first, then ipwho.is — a second free provider, tried only
 * when the first returns nothing usable (rate-limited, down, or an
 * unparseable body), never in parallel with it. Returns `{ error }` only
 * once both have failed; never throws.
 */
export async function locateByIp(fetcher: IpLocateFetcher): Promise<IpLocateResult> {
  const primary = await fetchLocation(fetcher, IPAPI_CO_URL, parseIpApiCo);
  if (primary !== null) return primary;
  const fallback = await fetchLocation(fetcher, IPWHO_IS_URL, parseIpWhoIs);
  if (fallback !== null) return fallback;
  return { error: "unavailable" };
}
