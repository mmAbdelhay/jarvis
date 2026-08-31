import type { HealthReading, HealthState, ProviderVendor } from "@jarvis/core";

/**
 * All three are the standard Atlassian Statuspage `/api/v2/status.json`
 * shape — no auth, no key, one small JSON object (verified in the spike).
 * status.anthropic.com now 301-redirects to status.claude.com, so the final
 * URL is used directly rather than relying on redirect following.
 */
export const STATUS_PAGE_URLS: Record<ProviderVendor, string> = {
  anthropic: "https://status.claude.com/api/v2/status.json",
  github: "https://www.githubstatus.com/api/v2/status.json",
  openai: "https://status.openai.com/api/v2/status.json",
};

/**
 * Generous relative to a small JSON GET, but bounded — phase 1's ruling R35
 * and phase 2's P6 both exist because an unbounded call hung something that
 * had no business waiting on the network.
 */
export const STATUS_TIMEOUT_MS = 5_000;

/** The slice of `fetch` this module uses, so tests need no HTTP server. */
export type FetchFn = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const INDICATORS: Record<string, HealthState> = {
  none: "ok",
  minor: "degraded",
  major: "outage",
  critical: "outage",
};

const UNKNOWN: HealthReading = { state: "unknown", detail: "" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

export async function readStatusPage(
  vendor: ProviderVendor,
  deps: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<HealthReading> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? STATUS_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let body: unknown;
  try {
    const response = await fetchFn(STATUS_PAGE_URLS[vendor], { signal: controller.signal });
    if (!response.ok) return UNKNOWN;
    body = await response.json();
  } catch {
    // Offline, DNS failure, corporate filter, abort on timeout, malformed
    // JSON — every one of them means the same thing to the user, and none of
    // them may reach the caller as a rejection.
    return UNKNOWN;
  } finally {
    clearTimeout(timer);
  }

  const status = asRecord(asRecord(body)?.["status"]);
  const indicator = status?.["indicator"];
  if (typeof indicator !== "string") return UNKNOWN;

  const state = INDICATORS[indicator];
  // An indicator Statuspage adds later must read as "unknown", never as the
  // nearest thing we happen to have a colour for.
  if (state === undefined) return UNKNOWN;

  const description = status?.["description"];
  return { state, detail: typeof description === "string" ? description : "" };
}
