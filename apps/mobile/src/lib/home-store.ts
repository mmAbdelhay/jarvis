// The Home screen's own data beside the Dashboard store's projects,
// sessions and metrics: each account's capacity (pushed), its trend over
// the last day (read on focus) and which live sessions are waiting at a
// question, with that question. The laptop only reports a waiting prompt
// when asked, so the live sessions are asked on an interval while Home is
// on screen, and never otherwise.
import {
  type CapacityCard,
  type CapacityTrend,
  parseCapacityTrends,
  parseProviderCapacity,
  parseSessionsPerDay,
} from "./home-capacity";
import type { RpcClient } from "./rpc-client";
import { fetchPrompt, type PhonePrompt } from "./session-prompt";

export type WaitingSession = { sessionId: string; prompt: PhonePrompt };

export type HomeView = {
  capacity: CapacityCard[];
  trends: CapacityTrend[];
  /** Sessions started per day, oldest first (usage:history). */
  sessionsPerDay: number[];
  waiting: WaitingSession[];
};

export type HomeStore = {
  get(): HomeView;
  subscribe(listener: (view: HomeView) => void): () => void;
  /** `capacity: false` polls prompts only: no `providers:update` push, no
   *  `usage:history` read (the Sessions screen's "Asks:" line). */
  focus(options?: { capacity?: boolean }): void;
  blur(): void;
  /** The sessions to ask about; asked at once, then on every tick. */
  setLiveSessions(ids: readonly string[]): void;
  /** Forgets a session's prompt at once — after it was answered, so the
   *  card does not linger until the next tick. */
  dismiss(sessionId: string): void;
};

export const PROMPT_POLL_MS = 3000;

export function createHomeStore(deps: {
  client: RpcClient;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}): HomeStore {
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stop =
    deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const listeners = new Set<(view: HomeView) => void>();
  let view: HomeView = { capacity: [], trends: [], sessionsPerDay: [], waiting: [] };
  let focused = false;
  let capacityOn = true;
  let live: string[] = [];
  let timer: unknown;
  let polling = false;
  // Set when a round is asked for while one runs: the live list changed
  // under it, so one more round follows rather than the ask being lost.
  let again = false;
  let unsubscribeProviders: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;

  function setView(patch: Partial<HomeView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) listener(view);
  }

  async function loadTrends(): Promise<void> {
    const result = await deps.client.call("usage:history", [], { whenNotOpen: "reject" });
    if (result.ok && focused)
      setView({
        trends: parseCapacityTrends(result.value),
        sessionsPerDay: parseSessionsPerDay(result.value),
      });
  }

  async function poll(): Promise<void> {
    // One round at a time: a slow laptop must not stack rounds up.
    if (!focused || deps.client.state() !== "open") return;
    if (polling) {
      again = true;
      return;
    }
    polling = true;
    try {
      const ids = [...live];
      const prompts = await Promise.all(ids.map((id) => fetchPrompt(deps.client, id)));
      if (!focused) return;
      const waiting: WaitingSession[] = [];
      ids.forEach((sessionId, index) => {
        const prompt = prompts[index];
        // Only sessions still live when the answer lands: one that ended
        // meanwhile has no question left to answer.
        if (prompt !== undefined && live.includes(sessionId)) waiting.push({ sessionId, prompt });
      });
      setView({ waiting });
    } finally {
      polling = false;
    }
    if (again) {
      again = false;
      await poll();
    }
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focus(options) {
      if (focused) return;
      focused = true;
      capacityOn = options?.capacity ?? true;
      if (capacityOn) {
        unsubscribeProviders = deps.client.onPush("providers:update", (payload) => {
          setView({ capacity: parseProviderCapacity(payload) });
        });
        deps.client.subscribe("providers:update");
      }
      unsubscribeState = deps.client.onState((state) => {
        if (state === "open") {
          if (capacityOn) void loadTrends();
          void poll();
        }
      });
      timer = every(() => void poll(), PROMPT_POLL_MS);
      if (capacityOn) void loadTrends();
      void poll();
    },
    blur() {
      if (!focused) return;
      focused = false;
      if (capacityOn) deps.client.unsubscribe("providers:update");
      unsubscribeProviders?.();
      unsubscribeState?.();
      unsubscribeProviders = undefined;
      unsubscribeState = undefined;
      stop(timer);
      timer = undefined;
    },
    setLiveSessions(ids) {
      const next = [...ids];
      const changed = next.length !== live.length || next.some((id, index) => id !== live[index]);
      live = next;
      if (!changed) return;
      setView({ waiting: view.waiting.filter((entry) => live.includes(entry.sessionId)) });
      void poll();
    },
    dismiss(sessionId) {
      setView({ waiting: view.waiting.filter((entry) => entry.sessionId !== sessionId) });
    },
  };
}
