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
import { type PushData, parsePushData } from "@jarvis/wire";
import type { MachineId } from "./machine-index";
import type { MachineSessions } from "./machine-sessions";
import { planNavigation } from "./notification-tap";
import type { NotificationResponse } from "./notifications";
import type { PushPrefs, PushRegistrationDeps } from "./push-registration";
import type { ClientState, RpcClient } from "./rpc-client";
import type { NavigatorGate } from "./scope-routing";
import { parseSessionList } from "./sessions-store";

// Each tapped notification is handled at most once (task-6-brief.md, rule
// 2) — a fixed-size FIFO of ids, oldest evicted first once it's full, so a
// long-running app session never grows this set without bound.
export const MAX_HANDLED_IDS = 32;

/** How long a launch waits to learn whether a tap brought it up. */
export const COLD_START_TAP_WAIT_MS = 500;

export type TapClient = Pick<RpcClient, "call" | "onState" | "state">;
export type TapRouter = { push(route: string): void };

export type PushFlag = { read(): Promise<boolean>; write(v: boolean): Promise<void> };

/** A route waits in the gate across a remount, and only the latest waits: by the
 *  time a tree mounts, the one on screen may not be the machine this route was
 *  asked for on (scope-routing.ts). */
export function gateTapRouter(
  gate: NavigatorGate,
  sessions: Pick<MachineSessions, "current">,
  navigate: (route: string) => void,
): TapRouter {
  return {
    push(route) {
      const { client } = sessions.current();
      gate.navigate(() => {
        if (sessions.current().client === client) navigate(route);
      });
    },
  };
}

/** Which machine a tap belongs to. A laptop older than the `device` field sends
 *  none, so the tap stays on the active machine. A device no machine here has
 *  means that machine has been removed. */
export async function tapMachine(
  data: PushData,
  find: (deviceId: string) => Promise<MachineId | undefined>,
): Promise<{ kind: "active" } | { kind: "machine"; id: MachineId } | { kind: "gone" }> {
  if (data.device === undefined) return { kind: "active" };
  const id = await find(data.device);
  return id === undefined ? { kind: "gone" } : { kind: "machine", id };
}

export async function handleNotificationTap(
  deps: {
    sessions: Pick<MachineSessions, "current" | "switchTo">;
    findByDeviceId(deviceId: string): Promise<MachineId | undefined>;
    router: TapRouter;
    handledIds: Set<string>;
    waitForOpen(client: TapClient): Promise<boolean>;
    notice(): void;
  },
  response: NotificationResponse,
): Promise<void> {
  const parsed = parsePushData(response.data);
  if (parsed === undefined) return;
  if (!recordHandledId(deps.handledIds, response.id, MAX_HANDLED_IDS)) return;

  let target: Awaited<ReturnType<typeof tapMachine>>;
  try {
    target = await tapMachine(parsed, deps.findByDeviceId);
  } catch {
    // A read that failed says nothing about the machine: it may well be held,
    // so no notice that it is gone, and no route guessed on another.
    return;
  }
  if (target.kind === "gone") {
    deps.notice();
    return;
  }
  if (target.kind === "machine") {
    // Also for the machine on screen, which answers "same": a switch away from
    // it may be in flight, and this tap overrides that.
    const outcome = await deps.sessions.switchTo(target.id);
    if (outcome === "superseded" || outcome === "unknown") return;
  }

  // Read after the switch: it is the next machine's client that must open.
  const client = deps.sessions.current().client;
  const opened = await deps.waitForOpen(client);
  if (!opened) return;

  let sessionIds = new Set<string>();
  if (
    parsed.kind === "session-done" ||
    parsed.kind === "session-failed" ||
    parsed.kind === "session-waiting"
  ) {
    const result = await client.call("sessions:list", [], { whenNotOpen: "reject" });
    if (!result.ok) return;
    sessionIds = new Set(parseSessionList(result.value).map((row) => row.id));
  }
  const plan = planNavigation(parsed, sessionIds);
  // The machine it was planned on has gone from the screen during the call.
  if (deps.sessions.current().client !== client) return;
  if (plan.route !== undefined) {
    deps.router.push(plan.route);
  }
}

/** The machine a launch should start on, when a tap brought the app up: answered
 *  before anything connects, so the last active machine never connects or asks
 *  for Face ID on the way to the right one. Anything but a machine found, a read
 *  that fails or is too slow among them, means no preference. */
export async function coldStartMachine(deps: {
  lastResponse(): Promise<NotificationResponse | undefined>;
  findByDeviceId(deviceId: string): Promise<MachineId | undefined>;
}): Promise<MachineId | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      deps.lastResponse(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), COLD_START_TAP_WAIT_MS);
      }),
    ]);
    const data = response === undefined ? undefined : parsePushData(response.data);
    if (data === undefined) return undefined;
    const target = await tapMachine(data, deps.findByDeviceId);
    return target.kind === "machine" ? target.id : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
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

/** The null scope holds no machine, so nothing registers there. */
export const NO_MACHINE_PUSH_FLAG: PushFlag = {
  read: async () => false,
  write: async () => {},
};

/** What `createPrefsFacade` starts from. A flag that cannot be read is false, as
 *  everything under `PushProvider` waits on this answer. The machine stays as it
 *  is until a later open reads it. */
export async function loadPushSeed(
  store: PrefsStore,
  localeTag: string,
  pushFlag: PushFlag,
): Promise<PushPrefs> {
  const { notifications } = await loadPrefs(store, localeTag);
  const pushRegistered = await pushFlag.read().catch(() => false);
  return { notifications, pushRegistered };
}

/** A prefs facade over a `PrefsStore` (rule 1): `notifications`, the phone's
 * one switch, and `pushRegistered` through `pushFlag`, this machine's own.
 * `seed` is the already-loaded value —
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
  pushFlag: PushFlag,
): PushRegistrationDeps["prefs"] {
  let cache: PushPrefs = seed;
  return {
    get(): PushPrefs {
      return cache;
    },
    async set(patch: Partial<PushPrefs>): Promise<void> {
      const { notifications, pushRegistered } = patch;
      if (notifications !== undefined) {
        const current: Prefs = await loadPrefs(store, localeTag);
        await savePrefs(store, { ...current, notifications });
        cache = { ...cache, notifications };
      }
      if (pushRegistered !== undefined) {
        await pushFlag.write(pushRegistered);
        cache = { ...cache, pushRegistered };
      }
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
