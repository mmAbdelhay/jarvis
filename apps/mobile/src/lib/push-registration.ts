// The push registration controller (M10 Task 5, task-5-brief.md
// "Behaviour, Controller"). Off by default, twice (global-constraints.md):
// nothing here ever requests a permission or fetches a token unless
// `setEnabled(true)` was called — which the Settings screen only does from
// an explicit user tap (rule 2's own heading). Registration and
// unregistration calls always use `whenNotOpen: "reject"` and are never
// queued or retried on a timer — a connection that drops mid-flow is
// picked up again the next time `onState` reports "open" (rule 4), driven
// by the ordinary RPC reconnect loop that already exists, not by anything
// this file schedules itself.
//
// Logging discipline (rule 7): the token lives in a closure variable only.
// It is never written to `view` (so it can never reach `JSON.stringify`
// via `get()`), never written to prefs, and the one place a native failure
// is logged (`getExpoPushToken` throwing) logs only the error's kind.
import {
  PUSH_REGISTER_CHANNEL,
  PUSH_UNREGISTER_CHANNEL,
  parsePushRegisterResult,
} from "@jarvis/wire";
import type { Language } from "./i18n";
import type { NotificationsAdapter } from "./notifications";
import type { RpcClient } from "./rpc-client";

export const PUSH_REGISTER_TIMEOUT_MS = 10_000;
export const ANDROID_CHANNEL_ID = "jarvis";

export type PushPhase =
  | "off"
  | "requesting"
  | "on"
  | "denied"
  | "blocked"
  | "unavailable"
  | "error";

export type PushView = {
  phase: PushPhase;
  laptopEnabled: boolean | undefined;
  registered: boolean;
  // Rule 3: a `registered:false` register result carries the laptop's own
  // explanation, shown verbatim by the screen — never translated through
  // i18n.ts, same discipline as every other server-text field in this app.
  serverText?: string;
  language?: Language;
  // iOS sideload detection (free-signing plan, work item 2): free Apple-ID
  // signing strips the aps-environment entitlement, so on a sideloaded
  // build `getExpoPushToken` always throws even though permission was
  // granted on a real device. This flag records exactly that shape —
  // permission fine, device fine, token fetch failed — so the Settings
  // screen can say "sideloaded build" instead of a generic unavailable.
  tokenFetchFailed?: boolean;
};

export type PushPrefs = { notifications: boolean; pushRegistered: boolean };

export type PushRegistrationDeps = {
  client: Pick<RpcClient, "call" | "onState" | "state">;
  adapter: NotificationsAdapter;
  prefs: {
    get(): PushPrefs;
    set(patch: Partial<PushPrefs>): Promise<void>;
  };
  language: () => Language;
  channelName: () => string;
  log(line: string): void;
};

export type PushRegistration = {
  get(): PushView;
  subscribe(cb: (view: PushView) => void): () => void;
  setEnabled(on: boolean): Promise<void>;
  dispose(): void;
};

/** Best-effort error classification for the one log line rule 2 allows on
 * a `getExpoPushToken` throw — never the error's message (which could
 * carry anything a native module chooses to put there). */
function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

export function createPushRegistration(deps: PushRegistrationDeps): PushRegistration {
  const listeners = new Set<(view: PushView) => void>();
  let disposed = false;
  // Rule 7: the only place the token is ever held.
  let token: string | undefined;
  // M12 Task 12 minor: a counter, not a boolean. `enable()`'s first-ever
  // fetch (token still undefined) and `resumeAfterRestart()`'s can
  // genuinely overlap — both start whenever their own precondition holds,
  // and neither waits on the other. A boolean cleared by whichever of the
  // two finishes first would let a genuine rotation slip past the rule-6
  // guard below and start a third, unordered fetch while the slower of
  // the first two is still in flight. The guard only opens once every
  // outstanding fetch this closure started has settled.
  let tokenFetchInFlight = 0;

  let view: PushView = {
    phase: deps.prefs.get().notifications ? "on" : "off",
    laptopEnabled: undefined,
    registered: deps.prefs.get().pushRegistered,
  };

  function setView(patch: Partial<PushView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) {
      listener(view);
    }
  }

  async function fetchToken(projectId: string): Promise<string> {
    tokenFetchInFlight += 1;
    try {
      return await deps.adapter.getExpoPushToken(projectId);
    } finally {
      tokenFetchInFlight -= 1;
    }
  }

  /** Rule 3. Sends the registration call only when the socket is actually
   * open; otherwise it just reflects "on, not yet registered" and relies
   * on the `onState` "open" handler below (rule 4) to call this again —
   * never a timer, never a queued call. */
  async function register(): Promise<void> {
    if (deps.client.state() !== "open" || token === undefined) {
      setView({ phase: "on", registered: false });
      return;
    }
    if (!deps.prefs.get().notifications) return;
    const result = await deps.client.call(
      PUSH_REGISTER_CHANNEL,
      [{ token, platform: deps.adapter.platform(), language: deps.language() }],
      { whenNotOpen: "reject", timeoutMs: PUSH_REGISTER_TIMEOUT_MS },
    );
    if (!deps.prefs.get().notifications || token === undefined) return;
    if (!result.ok) {
      // Fix round 1, Minor: clears a stale serverText/language/laptopEnabled
      // left over from an earlier error or success — this retry-pending
      // state must never keep showing a previous attempt's leftovers.
      setView({
        phase: "on",
        registered: false,
        serverText: undefined,
        language: undefined,
        laptopEnabled: undefined,
      });
      return;
    }
    const parsed = parsePushRegisterResult(result.value);
    if (parsed === undefined) {
      setView({
        phase: "on",
        registered: false,
        serverText: undefined,
        language: undefined,
        laptopEnabled: undefined,
      });
      return;
    }
    if (parsed.registered) {
      await deps.prefs.set({ pushRegistered: true });
      // Final re-review R1: `disable()` can land inside the await above too —
      // the switch must not come back on from a write that finished after it.
      if (!deps.prefs.get().notifications || token === undefined) return;
      setView({
        phase: "on",
        laptopEnabled: parsed.laptopEnabled,
        registered: true,
        serverText: undefined,
        language: undefined,
      });
      return;
    }
    setView({
      phase: "error",
      registered: false,
      serverText: parsed.text,
      language: parsed.language,
    });
  }

  /** A fresh controller instance — most notably after an app restart — can
   * find `prefs.notifications` already `true` from an earlier session while
   * this instance's own closure-held `token` is still `undefined`; the first
   * ordinary open is the only place that repairs that gap. Never prompts —
   * `adapter.getPermission()`, never `requestPermission()` — since the
   * user already granted it in the earlier session; a permission that was
   * since revoked, or a device/project that's become unavailable, ends
   * this cleanly (`"unavailable"`, `prefs.notifications:false`) instead of
   * leaving the view stuck at "on, pending" forever.
   */
  async function resumeAfterRestart(): Promise<void> {
    const permission = await deps.adapter.getPermission();
    const projectId = deps.adapter.projectId();
    if (permission !== "granted" || !deps.adapter.isDevice() || projectId === undefined) {
      await deps.prefs.set({ notifications: false });
      setView({ phase: "unavailable" });
      return;
    }
    try {
      token = await fetchToken(projectId);
    } catch (error) {
      deps.log(`push: token fetch failed kind=${errorKind(error)}`);
      setView({ phase: "on", registered: false, tokenFetchFailed: true });
      return;
    }
    // A fetch that succeeds after an earlier failure (transient native
    // hiccup, not a stripped entitlement) must not keep showing the
    // sideload note.
    if (view.tokenFetchFailed === true) setView({ tokenFetchFailed: undefined });
    // Disposed while the fetch above was in flight — nothing left to
    // register for; a disposed controller must never make its first RPC
    // call after the fact.
    if (disposed) return;
    if (!deps.prefs.get().notifications) return;
    await register();
  }

  /** Rule 4's unregister half, shared with rule 5's `setEnabled(false)`. */
  async function unregisterOnce(): Promise<void> {
    const result = await deps.client.call(PUSH_UNREGISTER_CHANNEL, [], {
      whenNotOpen: "reject",
    });
    if (result.ok) {
      await deps.prefs.set({ pushRegistered: false });
      setView({ registered: false });
    }
  }

  // Rule 4: registered once, for this controller's whole lifetime — never
  // torn down and re-armed per attempt, so a reconnect any time later
  // still drives registration/unregistration without anything else
  // prompting it. Purely reactive to a real "open" notification (never
  // checked synchronously against the current state here) — this, plus
  // never calling anything below before a subscription fires, is what
  // keeps construction itself a no-op (bite-proof: "register at
  // construction").
  const unsubscribeState = deps.client.onState((state, detail) => {
    if (state !== "open") return;
    // Task 5 (M12 background/foreground): an "open" that only marks a
    // return from the background (rpc-client.ts's `setAppActive(true)`)
    // never re-registers — the laptop still holds this device's token;
    // nothing about the pairing or the socket changed underneath it. Only
    // a real welcome (no `resumed` detail — a fresh connect or a
    // reconnect) reaches the rest of this handler.
    if (detail.resumed === true) return;
    const prefsNow = deps.prefs.get();
    if (prefsNow.notifications) {
      // No token yet in this instance (the restart gap above) needs its own
      // non-prompting resume path; once a token is held, every later "open"
      // is the ordinary retry.
      if (token === undefined) {
        void resumeAfterRestart();
      } else {
        void register();
      }
    } else if (prefsNow.pushRegistered) {
      void unregisterOnce();
    }
  });

  // Rule 6: token rotation. A native token event is only a rotation after a
  // consented fetch has established this controller's token, and events
  // emitted by that fetch itself are ignored while it is in flight.
  const unsubscribeToken = deps.adapter.onTokenChanged(() => {
    if (token === undefined || tokenFetchInFlight > 0 || !deps.prefs.get().notifications) return;
    const projectId = deps.adapter.projectId();
    if (projectId === undefined) return;
    void (async () => {
      // Two steps, two distinct failures: a fetch that throws leaves the
      // previous (still-valid) token and registration exactly as they
      // were — there is nothing new to register with. A *register* that
      // throws (never an ok:false result, which `register()` already
      // turns into a normal view update, but a genuine RPC-layer
      // exception) happens only after the token has already rotated, so
      // it is a different failure at a different step — the log line
      // must say which one, not report every failure here as "token
      // fetch failed" regardless of where it actually happened.
      let nextToken: string;
      try {
        nextToken = await fetchToken(projectId);
      } catch (error) {
        deps.log(`push: token rotation fetch failed kind=${errorKind(error)}`);
        return;
      }
      if (disposed) return;
      token = nextToken;
      try {
        await register();
      } catch (error) {
        deps.log(`push: token rotation register failed kind=${errorKind(error)}`);
      }
    })();
  });

  async function enable(): Promise<void> {
    // `tokenFetchFailed` cleared on every fresh attempt — the sideload
    // note must reflect this attempt, not a previous one's failure.
    setView({ phase: "requesting", tokenFetchFailed: undefined });

    if (!deps.adapter.isDevice() || deps.adapter.projectId() === undefined) {
      await deps.prefs.set({ notifications: false });
      setView({ phase: "unavailable" });
      return;
    }

    let permission: Awaited<ReturnType<NotificationsAdapter["requestPermission"]>>;
    try {
      permission = await deps.adapter.requestPermission();
    } catch (error) {
      deps.log(`push: requestPermission failed kind=${errorKind(error)}`);
      await deps.prefs.set({ notifications: false });
      setView({ phase: "unavailable" });
      return;
    }

    if (permission === "denied") {
      await deps.prefs.set({ notifications: false });
      setView({ phase: "denied" });
      return;
    }
    if (permission === "blocked") {
      await deps.prefs.set({ notifications: false });
      setView({ phase: "blocked" });
      return;
    }
    if (permission !== "granted") {
      // "undetermined" answering requestPermission() would be a
      // native-module contract violation — treated the same as
      // unavailable rather than silently carrying on as if granted.
      await deps.prefs.set({ notifications: false });
      setView({ phase: "unavailable" });
      return;
    }

    if (deps.adapter.platform() === "android") {
      await deps.adapter.ensureAndroidChannel(deps.channelName());
    }

    const projectId = deps.adapter.projectId();
    if (projectId === undefined) {
      // Re-checked: `isDevice()`/`projectId()` above already guarded this,
      // but nothing rules out it changing across the awaits above.
      await deps.prefs.set({ notifications: false });
      setView({ phase: "unavailable" });
      return;
    }

    try {
      token = await fetchToken(projectId);
    } catch (error) {
      deps.log(`push: token fetch failed kind=${errorKind(error)}`);
      await deps.prefs.set({ notifications: false });
      // Permission granted, real device, project id present — yet no
      // token. On iOS that is the sideloaded-build signature (see
      // PushView.tokenFetchFailed).
      setView({ phase: "unavailable", tokenFetchFailed: true });
      return;
    }

    // Disposed while the fetch above was in flight (a screen unmounted
    // mid-request, say) — the same rule resumeAfterRestart's own fetch
    // follows: nothing left to register for, and a disposed controller
    // must never make its first RPC call after the fact.
    if (disposed) return;

    await deps.prefs.set({ notifications: true });
    await register();
  }

  async function disable(): Promise<void> {
    // M12 Task 12 minor: cleared synchronously, before any await — rule 7
    // says the token lives in this closure only, and "off" must mean off:
    // a stale token sitting here after disable() would otherwise still be
    // usable by, say, a register() a straggling "open" event manages to
    // trigger before the unsubscribes below ever run.
    token = undefined;
    await deps.prefs.set({ notifications: false });
    // Fix round 1, Minor: same stale-field clear as the ok:false/unparsable
    // patches above — turning notifications off must never leave a
    // previous error's serverText or a previous success's laptopEnabled
    // showing next to "off".
    setView({
      phase: "off",
      serverText: undefined,
      language: undefined,
      laptopEnabled: undefined,
      tokenFetchFailed: undefined,
    });
    // M12 Task 12 minor: tells expo-notifications to stop posting this
    // device's token to Expo's own server on its own, in the background,
    // now that the user has switched notifications off — otherwise the
    // library keeps doing that regardless of anything this controller does
    // with `token` above. Best-effort: a native failure here must not
    // block the unregister call below, which is what actually matters to
    // the laptop.
    // `enable()` does not need to re-enable this separately: Expo's
    // getExpoPushTokenAsync re-enables auto-registration after each
    // successful token fetch.
    try {
      await deps.adapter.setAutoServerRegistrationEnabled(false);
    } catch (error) {
      deps.log(`push: setAutoServerRegistrationEnabled failed kind=${errorKind(error)}`);
    }
    if (deps.client.state() === "open") {
      await unregisterOnce();
    }
    // else: rule 5's "otherwise it happens on the next open" — the onState
    // handler above sees prefs.pushRegistered still true and calls
    // unregisterOnce() itself.
  }

  // Fix round 1, Minor: `enable()`'s own re-entrancy guard — a second
  // `setEnabled(true)` arriving while one is already in flight (a fast
  // double-tap of the Settings switch, or a re-render calling it again)
  // shares the same in-flight promise instead of starting a second,
  // fully independent permission/token/register flow racing the first.
  let enabling: Promise<void> | undefined;

  async function setEnabled(on: boolean): Promise<void> {
    if (disposed) return;
    if (on) {
      if (enabling !== undefined) {
        await enabling;
        return;
      }
      enabling = enable().finally(() => {
        enabling = undefined;
      });
      await enabling;
      return;
    }
    await disable();
  }

  function dispose(): void {
    disposed = true;
    unsubscribeState();
    unsubscribeToken();
    listeners.clear();
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEnabled,
    dispose,
  };
}
