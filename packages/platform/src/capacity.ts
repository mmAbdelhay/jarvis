import { query as sdkQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { CapacityReading, RateWindow } from "@jarvis/core";

/**
 * EVERY CALL INTO THIS MODULE COSTS REAL MONEY.
 *
 * The remaining-capacity figure is not readable for free: it arrives as a
 * side effect of an actual API round trip, so asking how much is left
 * consumes some of what is left. The controller's live run measured
 * `total_cost_usd: 0.0077` and ~3.3s for a one-word prompt. Three
 * accounts on a 30-second dashboard tick would be about $2/day spent asking
 * the question.
 *
 * Consequently: nothing in this file polls, retries, or fans out, and no
 * caller may put it on a timer. The refresh policy lives in core's
 * ProviderMonitor, where it is one reviewable object: startup once,
 * on explicit user demand, and free piggybacks off queries already paid for.
 *
 * The SDK method is literally named
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. Absence, a
 * throw, or a changed shape must degrade to "unavailable" — never to a
 * guess, and never to a stale number presented as current.
 */

/** Generous next to a ~3.3s measured round trip, but bounded (R35 / P6). */
export const CAPACITY_TIMEOUT_MS = 20_000;

/**
 * The slice of the SDK's `Query` this module uses. Narrower than the real
 * type (which carries dozens of control methods) so tests can build a
 * fixture; the real `Query` satisfies it structurally, so no cast is needed.
 */
export type UsageQuery = {
  [Symbol.asyncIterator](): AsyncIterator<{ type: string }>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<unknown>;
};

/**
 * The seam this module is opened through. Deliberately the *query function*
 * itself, not a wrapper that already baked in `cwd`/`settingSources`/`tools`
 * (the way `brain.ts`'s `SdkQueryFn` works) — so that a test can inspect the
 * exact `options` object this module builds, instead of trusting it blindly.
 */
export type CapacityQueryFn = (params: { prompt: string; options: Options }) => UsageQuery;

function freshUnavailable(): CapacityReading {
  // A fresh object literal on every call rather than a shared singleton: a
  // shared UNAVAILABLE constant returned to every caller means one
  // downstream mutation of a reading could poison every future reading.
  return { ok: false, reason: "unavailable" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function parseWindow(value: unknown): RateWindow | undefined {
  const window = asRecord(value);
  if (window === undefined) return undefined;

  const utilization = window["utilization"];
  const resetsAt = window["resets_at"];
  // Both fields are typed `| null` by the SDK and both are optional in
  // practice; a partial window is no window at all.
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined;
  if (typeof resetsAt !== "string" || Number.isNaN(Date.parse(resetsAt))) return undefined;

  // Out of [0, 100] means the shape has changed underneath us — a fraction
  // (0.42), a raw token count (4200), something else. Clamping would turn
  // that shape change into a confident, wrong percentage; abstaining is the
  // only honest response, same as every other unrecognised shape in this
  // module.
  if (utilization < 0 || utilization > 100) return undefined;

  return {
    usedPercent: Math.round(utilization),
    resetsAt,
  };
}

/**
 * The choke point. The raw response — session cost, per-model usage,
 * behaviour flags, internal codenames — dies here; only the two windows
 * continue. Nothing downstream, in a log, an error message or an IPC
 * payload, ever sees the rest.
 *
 * CORRECTION 1 from the controller's verification, pinned by test: the
 * fields live under `rate_limits`, NOT at the top level. Reading
 * `usage.five_hour` returns undefined and would ship a permanently blank
 * panel.
 */
export function parseUsage(raw: unknown): CapacityReading {
  const usage = asRecord(raw);
  if (usage === undefined) return freshUnavailable();

  // False for API-key / Bedrock / Vertex auth, where plan limits do not
  // apply at all and `rate_limits` is null.
  if (usage["rate_limits_available"] === false) return freshUnavailable();

  const limits = asRecord(usage["rate_limits"]);
  if (limits === undefined) return freshUnavailable();

  const fiveHour = parseWindow(limits["five_hour"]);
  if (fiveHour === undefined) return freshUnavailable();

  return { ok: true, fiveHour, sevenDay: parseWindow(limits["seven_day"]) };
}

/**
 * CORRECTION 2 from the controller's verification, pinned by test: the usage
 * method must be called MID-STREAM, at the first `assistant` message.
 * Calling it at the `result` message throws "Query closed before response
 * received"; calling it after the loop throws "ProcessTransport is not ready
 * for writing". After reading, the stream is drained to the end rather than
 * broken out of, so the child process finishes and exits on its own.
 */
async function runRead(query: UsageQuery): Promise<CapacityReading> {
  let raw: unknown;
  let read = false;

  for await (const message of query) {
    if (read || message.type !== "assistant") continue;
    read = true;
    raw = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  if (!read) return freshUnavailable();
  return parseUsage(raw);
}

function defaultQuery(params: { prompt: string; options: Options }): UsageQuery {
  return sdkQuery(params);
}

export function createCapacityReader(config: {
  /**
   * A directory with no `.claude` project config of its own — the same
   * isolation requirement as BrainConfig.cwd, for the same reason: a
   * headless SDK session inherits hooks and skills from its cwd. Pass the
   * brain's cwd.
   */
  cwd: string;
  query?: CapacityQueryFn;
  timeoutMs?: number;
}): (configDir: string) => Promise<CapacityReading> {
  const timeoutMs = config.timeoutMs ?? CAPACITY_TIMEOUT_MS;
  const query = config.query ?? defaultQuery;

  return async (configDir: string): Promise<CapacityReading> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Owned so the child process can be torn down, not just abandoned, on
    // the timeout path — a hung read must not become a billed subprocess
    // that keeps running (and keeps spending) after this call has already
    // resolved.
    const abortController = new AbortController();
    try {
      // Deleting rather than leaving it set-or-unset keeps the child's env
      // identical regardless of whether this process happens to have the
      // key set: an inherited ANTHROPIC_API_KEY would make the SDK
      // subprocess authenticate by key instead of the target account's
      // subscription, so every account would silently report
      // rate_limits_available: false forever, with nothing to explain why.
      const env = { ...process.env };
      delete env["ANTHROPIC_API_KEY"];

      const options: Options = {
        maxTurns: 1,
        cwd: config.cwd,
        settingSources: [],
        tools: [],
        abortController,
        // This is what makes the reading belong to THIS account: the SDK
        // subprocess is pointed at that account's config directory, the
        // same mechanism the user's own wrapper scripts use. Placed after
        // the env spread so an inherited CLAUDE_CONFIG_DIR can never win.
        env: { ...env, CLAUDE_CONFIG_DIR: configDir },
      };

      // One word. The reading is a side effect of the round trip, so the
      // prompt exists only to make the trip as small as it can be.
      const opened = query({ prompt: "ok", options });

      const timeout = new Promise<CapacityReading>((resolve) => {
        timer = setTimeout(() => resolve(freshUnavailable()), timeoutMs);
      });
      return await Promise.race([runRead(opened), timeout]);
    } catch {
      // A throw from the experimental API, a spawn failure, a shape change
      // mid-iteration: all of them are "we don't know", never a rejection
      // into a caller that has a panel to paint.
      return freshUnavailable();
    } finally {
      clearTimeout(timer);
      // Whether this resolved by finishing the drain, by timing out, or by
      // throwing: the subprocess is never left to run (and bill) unwatched
      // past this call's own lifetime.
      abortController.abort();
    }
  };
}
