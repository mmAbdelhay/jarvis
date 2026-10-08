// Provider failover (design §3.5). An ordered list; a request goes to the
// current provider and, if it fails BEFORE its first event with a failover
// trigger (network, 30 s without a first event, 429, 5xx, overload), to the
// next one. Sticky for the rest of the turn; beginTurn() starts at the first
// again. Auth and other 4xx errors are shown, not failed over. Privacy
// ruling: a cloud entry after any local/LAN entry is skipped unless the user
// allowed cloud fallback. Pure: timers are injected.
import { FAILOVER_TEXT } from "./messages.js";
import { type ModelEvent, type ModelProvider, ProviderError } from "./types.js";

export const FIRST_EVENT_TIMEOUT_MS = 30_000;

export type ProviderLocality = "local" | "cloud";
export type FailoverEntry = { id: string; locality: ProviderLocality; provider: ModelProvider };
export type FailoverStatus = { activeId: string | null; fallbackReason: string | null };
export type FailoverSwitch = { fromId: string; toId: string; reason: string };

export interface FailoverProvider extends ModelProvider {
  beginTurn(): void;
  status(): FailoverStatus;
}

export function allowedChain(
  entries: readonly FailoverEntry[],
  allowCloudFallback: boolean,
): FailoverEntry[] {
  const chain: FailoverEntry[] = [];
  for (const entry of entries) {
    const crossesToCloud =
      entry.locality === "cloud" && chain.some((earlier) => earlier.locality === "local");
    if (crossesToCloud && !allowCloudFallback) continue;
    chain.push(entry);
  }
  return chain;
}

export function failoverReason(error: unknown): string | null {
  if (!(error instanceof ProviderError)) return null;
  if (error.kind === "network") return FAILOVER_TEXT.en.unreachable(error.message);
  if (error.kind !== "http") return null;
  if (error.status === 429) return FAILOVER_TEXT.en.rateLimited;
  const serverSide = error.status === undefined || error.status >= 500;
  if (error.status === 529 || (serverSide && /overload/i.test(error.message))) {
    return FAILOVER_TEXT.en.overloaded;
  }
  if (error.status !== undefined && error.status >= 500)
    return FAILOVER_TEXT.en.serverError(error.status);
  return null;
}

export function createFailoverProvider(options: {
  entries: readonly FailoverEntry[];
  allowCloudFallback: boolean;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  onSwitch(change: FailoverSwitch): void;
  firstEventTimeoutMs?: number;
}): FailoverProvider {
  const chain = allowedChain(options.entries, options.allowCloudFallback);
  const first = chain[0];
  if (first === undefined) throw new Error("createFailoverProvider needs at least one provider");
  const timeoutMs = options.firstEventTimeoutMs ?? FIRST_EVENT_TIMEOUT_MS;
  let cursor = 0;
  let turnReason: string | null = null;
  let current: FailoverStatus = { activeId: first.id, fallbackReason: null };

  const settle = (index: number) => {
    current = {
      activeId: chain[index]?.id ?? first.id,
      fallbackReason: index === 0 ? null : turnReason,
    };
  };

  return {
    beginTurn() {
      cursor = 0;
      turnReason = null;
    },

    status: () => ({ ...current }),

    async *chat(request): AsyncGenerator<ModelEvent, void> {
      for (let index = cursor; index < chain.length; index++) {
        const entry = chain[index] as FailoverEntry;
        const last = index === chain.length - 1;
        const controller = new AbortController();
        const forward = () => controller.abort();
        request.signal.addEventListener("abort", forward, { once: true });
        if (request.signal.aborted) controller.abort();
        let timedOut = false;
        let timer: unknown = last
          ? undefined
          : options.timers.setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs);
        const clear = () => {
          if (timer !== undefined) options.timers.clearTimeout(timer);
          timer = undefined;
        };
        let started = false;
        try {
          for await (const event of entry.provider.chat({
            ...request,
            signal: controller.signal,
          })) {
            if (!started) {
              started = true;
              clear();
              cursor = index;
              settle(index);
            }
            yield event;
          }
          return;
        } catch (error) {
          if (request.signal.aborted) throw error;
          const why = timedOut ? FAILOVER_TEXT.en.slow : failoverReason(error);
          if (started || why === null || last) {
            if (timedOut) {
              throw new ProviderError(
                "network",
                FAILOVER_TEXT.en.reason(entry.id, FAILOVER_TEXT.en.slow),
              );
            }
            throw error;
          }
          const next = chain[index + 1] as FailoverEntry;
          turnReason = FAILOVER_TEXT.en.reason(entry.id, why);
          cursor = index + 1;
          // Status moves now, so onSwitch listeners (provider:status) see it.
          current = { activeId: next.id, fallbackReason: turnReason };
          options.onSwitch({ fromId: entry.id, toId: next.id, reason: turnReason });
        } finally {
          clear();
          request.signal.removeEventListener("abort", forward);
        }
      }
      throw new ProviderError("network", FAILOVER_TEXT.en.noneLeft);
    },

    probe: () => first.provider.probe(),
    listModels: (signal) => first.provider.listModels(signal),

    async reachable(signal) {
      let firstFailure: string | undefined;
      for (let index = 0; index < chain.length; index++) {
        const entry = chain[index] as FailoverEntry;
        try {
          await entry.provider.listModels(signal);
          current = {
            activeId: entry.id,
            fallbackReason:
              index === 0
                ? null
                : FAILOVER_TEXT.en.reason(
                    first.id,
                    FAILOVER_TEXT.en.unreachable(firstFailure ?? ""),
                  ),
          };
          return { ok: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          firstFailure ??= message;
          if (failoverReason(error) === null) break;
        }
      }
      current = { activeId: first.id, fallbackReason: null };
      return { ok: false, error: firstFailure ?? "unreachable" };
    },
  };
}
