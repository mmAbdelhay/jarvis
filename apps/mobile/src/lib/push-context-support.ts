// The pure, non-React pieces of `push-context.tsx`'s `PushProvider`, split
// into their own file so they're unit-testable without importing
// `push-context.tsx` itself. `push-context.tsx` imports `expo-router` at
// module scope (for `useRouter`), which — under this repo's Node-environment
// Vitest config (`apps/mobile/vitest.config.mts`, `environment: "node"`) —
// fails to load at all (`SyntaxError: Unexpected token 'typeof'`, from
// code that assumes a bundler/Metro transform this test run never
// applies), the same reason `voice-context.tsx` has no test file of its
// own. `push-context.tsx` imports everything below from here; nothing else
// does.
import type { Prefs, PrefsStore } from "./prefs";
import { loadPrefs, savePrefs } from "./prefs";
import { parsePushData } from "@jarvis/wire";
import { planNavigation } from "./notification-tap";
import type { NotificationResponse } from "./notifications";
import type { PushPrefs, PushRegistrationDeps } from "./push-registration";
import type { ClientState, RpcClient } from "./rpc-client";
import { parseSessionList } from "./sessions-store";

// Each tapped notification is handled at most once (task-6-brief.md, rule
// 2) — a fixed-size FIFO of ids, oldest evicted first once it's full, so a
// long-running app session never grows this set without bound.
export const MAX_HANDLED_IDS = 32;

type TapClient = Pick<RpcClient, "call" | "onState" | "state">;
type TapRouter = { push(route: string): void };

export async function handleNotificationTap(
  deps: {
    client: TapClient;
    router: TapRouter;
    handledIds: Set<string>;
    waitForOpen: (client: TapClient) => Promise<boolean>;
  },
  response: NotificationResponse,
): Promise<void> {
  const parsed = parsePushData(response.data);
  if (parsed === undefined) return;
  if (!recordHandledId(deps.handledIds, response.id, MAX_HANDLED_IDS)) return;

  const opened = await deps.waitForOpen(deps.client);
  if (!opened) return;

  let sessionIds = new Set<string>();
  if (
    parsed.kind === "session-done" ||
    parsed.kind === "session-failed" ||
    parsed.kind === "session-waiting"
  ) {
    const result = await deps.client.call("sessions:list", [], { whenNotOpen: "reject" });
    if (!result.ok) return;
    sessionIds = new Set(parseSessionList(result.value).map((row) => row.id));
  }
  const plan = planNavigation(parsed, sessionIds);
  if (plan.route !== undefined) {
    deps.router.push(plan.route);
  }
}

/** Rule 2's once-per-id bookkeeping: records `id` into `handled`, evicting
 * the single oldest entry (`Set` iteration order is insertion order) once
 * `handled` is already at `max`. Answers `false` — and touches `handled`
 * not at all — for an `id` already in the set, the caller's signal to skip
 * re-handling it. */
export function recordHandledId(handled: Set<string>, id: string, max: number): boolean {
  if (handled.has(id)) return false;
  if (handled.size >= max) {
    const oldest = handled.values().next().value;
    if (oldest !== undefined) handled.delete(oldest);
  }
  handled.add(id);
  return true;
}

/** A prefs facade over a `PrefsStore` (rule 1): the notifications/
 * pushRegistered fields only. `seed` is the already-loaded value —
 * `PushProvider` loads it once, before ever building a registration (fix
 * round 1, Important 1), so `get()` is synchronous and truthful from its
 * very first call, never `prefs.ts`'s own defaults masquerading as the
 * real saved state while an async load is still in flight. Every write
 * re-reads the full `Prefs` immediately beforehand so it never clobbers
 * `language`/`speakReplies` — the same "re-read right before every write"
 * discipline `settings-store.ts`'s `setLanguage`/`setSpeakReplies` use for
 * the same reason (task-5-report.md's self-found fix). */
export function createPrefsFacade(
  store: PrefsStore,
  localeTag: string,
  seed: PushPrefs,
): PushRegistrationDeps["prefs"] {
  let cache: PushPrefs = seed;
  return {
    get(): PushPrefs {
      return cache;
    },
    async set(patch: Partial<PushPrefs>): Promise<void> {
      const current: Prefs = await loadPrefs(store, localeTag);
      const next: Prefs = { ...current, ...patch };
      await savePrefs(store, next);
      cache = { notifications: next.notifications, pushRegistered: next.pushRegistered };
    },
  };
}

/** Rule 2: waits for the shared client to report "open", subscribing
 * `onState` rather than polling — gives up (answers `false`) after
 * `waitMs` so a tap that arrives while the phone can't reach the laptop
 * never hangs forever. Answers `true` immediately if the socket is
 * already open. The only real caller (push-context.tsx) passes
 * `NOTIFICATION_NAV_WAIT_MS`. */
export function waitForOpen(
  client: Pick<RpcClient, "state" | "onState">,
  waitMs: number,
): Promise<boolean> {
  if (client.state() === "open") return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = client.onState((state: ClientState) => {
      if (settled || state !== "open") return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(true);
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(false);
    }, waitMs);
  });
}
