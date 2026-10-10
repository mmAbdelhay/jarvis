// Provider failover (design §3.5) and the Rafiq M4 backup brain (contracts
// §1). An ordered list; a request goes to the current provider and, if it
// fails BEFORE its first event with a failover trigger (network, 30 s without
// a first event, 429, 5xx, overload), to the next one. Sticky for the rest of
// the turn; beginTurn() starts at the first again. Auth and other 4xx errors
// are not failed over between configured providers — they go straight to the
// backup, the implicit last entry that is always allowed (local) and reached
// from ANY failure before a first event, except an account tripwire, which
// ends the turn with its own reason. Privacy ruling: a cloud entry after
// any local/LAN entry is skipped unless the user allowed cloud fallback.
// Pure: timers are injected.
import type { Lang } from "./i18n.js";
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

export function failoverReason(error: unknown, lang: Lang = "en"): string | null {
  if (!(error instanceof ProviderError)) return null;
  const text = FAILOVER_TEXT[lang];
  if (error.kind === "network") return text.unreachable(error.message);
  if (error.kind !== "http") return null;
  if (error.status === 429) return text.rateLimited;
  const serverSide = error.status === undefined || error.status >= 500;
  if (error.status === 529 || (serverSide && /overload/i.test(error.message))) {
    return text.overloaded;
  }
  if (error.status !== undefined && error.status >= 500) return text.serverError(error.status);
  return null;
}

const detailOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createFailoverProvider(options: {
  entries: readonly FailoverEntry[];
  allowCloudFallback: boolean;
  /** Rafiq M4 §1: the implicit last provider (local, always allowed). */
  backup?: FailoverEntry;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  onSwitch(change: FailoverSwitch): void;
  firstEventTimeoutMs?: number;
  /** The UI language of fallback reasons (M4 §3). Default en. */
  language?(): Lang;
}): FailoverProvider {
  const lang = (): Lang => options.language?.() ?? "en";
  const text = () => FAILOVER_TEXT[lang()];
  const chain = allowedChain(options.entries, options.allowCloudFallback);
  const configured = chain.length;
  if (options.backup !== undefined) chain.push(options.backup);
  const first = chain[0];
  if (first === undefined) throw new Error("createFailoverProvider needs at least one provider");
  const backupIndex = options.backup === undefined ? -1 : chain.length - 1;
  const timeoutMs = options.firstEventTimeoutMs ?? FIRST_EVENT_TIMEOUT_MS;
  let cursor = 0;
  let turnReason: string | null = null;
  /** With nothing configured the backup is all there is: say why. */
  const baseReason = (): string | null => (configured === 0 ? text().noneConfigured : null);
  let current: FailoverStatus = { activeId: first.id, fallbackReason: baseReason() };

  const settle = (index: number) => {
    current = {
      activeId: chain[index]?.id ?? first.id,
      fallbackReason: index === 0 ? baseReason() : turnReason,
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
          // An account tripwire is the answer the user must see: another
          // model would only replace it with its own failure.
          if (error instanceof ProviderError && error.kind === "tripwire") throw error;
          const why = timedOut ? text().slow : failoverReason(error, lang());
          // A failover trigger tries the next entry; anything else skips the
          // remaining configured providers and goes straight to the backup.
          const nextIndex = why !== null ? index + 1 : backupIndex;
          if (started || last || nextIndex <= index) {
            if (timedOut) {
              throw new ProviderError("network", text().reason(entry.id, text().slow));
            }
            throw error;
          }
          const next = chain[nextIndex] as FailoverEntry;
          turnReason = text().reason(entry.id, why ?? text().failed(detailOf(error)));
          cursor = nextIndex;
          // Status moves now, so onSwitch listeners (provider:status) see it.
          current = { activeId: next.id, fallbackReason: turnReason };
          options.onSwitch({ fromId: entry.id, toId: next.id, reason: turnReason });
          index = nextIndex - 1;
        } finally {
          clear();
          request.signal.removeEventListener("abort", forward);
        }
      }
      throw new ProviderError("network", text().noneLeft);
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
                ? baseReason()
                : text().reason(first.id, text().unreachable(firstFailure ?? "")),
          };
          return { ok: true };
        } catch (error) {
          firstFailure ??= detailOf(error);
          if (failoverReason(error) === null) {
            // A refusal (auth, 4xx) ends the configured chain; the backup is still tried.
            if (backupIndex === -1 || index >= backupIndex - 1) {
              if (index >= backupIndex) break;
              continue;
            }
            index = backupIndex - 1;
          }
        }
      }
      current = { activeId: first.id, fallbackReason: baseReason() };
      return { ok: false, error: firstFailure ?? "unreachable" };
    },
  };
}
