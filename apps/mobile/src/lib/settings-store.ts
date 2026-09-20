// The Settings screen's own store: language (writes prefs and asks for a
// restart, never touches I18nManager itself, which only _layout.tsx
// applies at start), the paired laptop's non-secret details (reusing
// pair-flow.ts's `fingerprintTail` so the phone shows the same characters
// everywhere), unpair, a manual reconnect, and connection diagnostics
// (deviceId and the fingerprint tail only — never the token or the full
// fingerprint).
//
// `SettingsView` carries a display-only `laptop` projection rather than the
// full `PairingRecord` — the full SHA-256 fingerprint is read once inside
// `loadLaptop` and immediately discarded; only its last 4 hex characters
// (`fingerprintTail`) ever reach `view` (and so React state).
//
// Two dependencies aren't literal 1:1 mirrors of a plain data read:
// `navigateToPair` (unpair's disconnect → clear → navigate sequence is
// something a test needs to observe the store itself performing) and the
// shared `connectFromStored` (connect-stored.ts's `connectFromStoredPairing`,
// partially applied by the caller with the app's real secure store and
// client) — the same one `_layout.tsx` uses on entry, so there is exactly
// one `loadPairing` read path in the whole app, not two that could
// disagree, and a keychain failure becomes a typed outcome instead of an
// unhandled rejection.

import { PUSH_UNREGISTER_CHANNEL } from "@jarvis/wire";
import type { ConnectStoredOutcome } from "./connect-stored";
import type { Clock } from "./clock";
import type { ConnectionStore, ConnectionView } from "./connection-store";
import { languageFromLocale } from "./i18n";
import type { Language, MessageKey } from "./i18n";
import { fingerprintTail as computeFingerprintTail } from "./pair-flow";
import { isClearingPairing, setClearingPairing } from "./pairing-guard";
import type { PairingRecord } from "./pairing-record";
import type { PrefsStore } from "./prefs";
import { loadPrefs, savePrefs } from "./prefs";
import { PUSH_REGISTER_TIMEOUT_MS } from "./push-registration";
import type { PushRegistration, PushView } from "./push-registration";
import type { RpcClient } from "./rpc-client";

export type SettingsLaptop = {
  host: string;
  port: number;
  laptopName?: string;
  deviceId: string;
  pairedAt: number;
};

export type SettingsView = {
  // Stays `undefined` until prefs finish loading, rather than defaulting to
  // "en" — an Arabic user must never see the English button highlighted
  // for even one frame.
  language: Language | undefined;
  restartRequired: boolean;
  // M8 Task 7, rule 17: defaults true until prefs finish loading, same as
  // loadPrefs's own missing/invalid fallback (rule 16) — never a flash of
  // "off" before the saved value is known.
  speakReplies: boolean;
  laptop?: SettingsLaptop;
  fingerprintTail?: string;
  // M10 Task 5, rule 10: mirrors `deps.push.get()` — the push controller
  // owns permission/registration state; this store only relays it.
  notifications: PushView;
  connection: ConnectionView;
  lastFrameAgoMs?: number;
  appVersion: string;
  // Set when `deps.unpair()` (the keychain clear) threw — the screen shows
  // `settings.unpairFailed` and the Unpair button stays available to
  // retry, instead of the failure being a silent, unhandled rejection.
  unpairError: boolean;
  // Set when `reconnect()`'s shared read failed — `settings.reconnectFailed`,
  // similarly retryable. Cleared, along with `unpairError` (a stale "couldn't
  // unpair" would otherwise sit next to a working connection), the next time
  // a reconnect actually succeeds.
  reconnectError: boolean;
};

/**
 * The connection-state label the Settings screen shows (unlike
 * `ConnectionBanner`'s `bannerKey`, which renders nothing for an open,
 * non-stale connection — Settings always shows *something* here, so it has
 * its own `settings.connected` key for that case instead of reusing the
 * banner's "nothing to say" behaviour). Reuses the same `conn.*` keys as
 * the banner for every other state, so the two screens describe a given
 * state identically.
 */
export function connectionStateKey(view: ConnectionView): MessageKey {
  if (view.pinMismatch) return "conn.pinMismatch";
  switch (view.state) {
    case "idle":
      return "conn.offline";
    case "connecting":
    case "authenticating":
      return "conn.connecting";
    case "reconnecting":
      return "conn.reconnecting";
    case "closed":
      return "conn.offline";
    case "unpaired":
      return "conn.unpaired";
    case "incompatible":
      return "conn.incompatible";
    case "open":
      return view.stale ? "conn.stale" : "settings.connected";
  }
}

export type SettingsStore = {
  get(): SettingsView;
  subscribe(listener: (view: SettingsView) => void): () => void;
  setLanguage(language: Language): Promise<void>;
  setSpeakReplies(on: boolean): Promise<void>;
  setNotifications(on: boolean): Promise<void>;
  unpair(): Promise<void>;
  reconnect(): void;
};

export type SettingsStoreDeps = {
  prefs: PrefsStore;
  localeTag: string;
  loadRecord(): Promise<PairingRecord | undefined>;
  // The one shared "read the stored pairing and connect" function — also
  // used by `_layout.tsx` on entry. `shouldConnect` is threaded through to
  // `connectFromStoredPairing`'s own guard (see connect-stored.ts): this
  // store passes `() => !unpairing && !isClearingPairing()`, checked
  // immediately before the shared function would call `client.connect`, so
  // a reconnect whose keychain read finishes after either this store's own
  // `unpair()` *or* the automatic unpaired handler's clear (final review
  // R-M2 — unpaired-handler.ts now sets the same app-wide flag) has
  // started can never connect with a pairing that is (or is about to be)
  // cleared.
  connectFromStored(shouldConnect: () => boolean): Promise<ConnectStoredOutcome>;
  connection: ConnectionStore;
  client: RpcClient;
  clock: Clock;
  appVersion: string;
  unpair(): Promise<void>;
  navigateToPair(): void;
  // Fix round 1 (Minor): a throwing `disconnect()`, or a subscriber that
  // throws out of `setView`, used to log via a raw `console.error(...,
  // err)` — the error object can carry unpredictable, unreviewed content.
  // Every call site below logs one fixed, secret-free string instead.
  log(line: string): void;
  // M10 Task 5, rule 10: this store only relays `push`'s own view and
  // forwards `setNotifications` to `push.setEnabled` — the permission
  // flow, token handling and registration retries all live in
  // push-registration.ts, not here.
  push: Pick<PushRegistration, "get" | "subscribe" | "setEnabled">;
};

const TICK_MS = 1_000;

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const listeners = new Set<(view: SettingsView) => void>();

  let view: SettingsView = {
    language: undefined,
    restartRequired: false,
    speakReplies: true,
    notifications: deps.push.get(),
    connection: deps.connection.get(),
    appVersion: deps.appVersion,
    unpairError: false,
    reconnectError: false,
  };

  let tickTimer: unknown;
  let unsubscribeConnection: (() => void) | undefined;
  let unsubscribePush: (() => void) | undefined;
  // Guards a `reconnect()` in flight against a `unpair()` that completes
  // first — checked both by `connectFromStored`'s own `shouldConnect`
  // (immediately before it would call `client.connect`) and again here
  // after the `await`, so neither a connect nor a stray navigate can slip
  // in once an unpair has started.
  let unpairing = false;

  function computeLastFrameAgoMs(): number | undefined {
    const lastFrameAt = deps.client.lastFrameAt();
    if (lastFrameAt === undefined) return undefined;
    return deps.clock.now() - lastFrameAt;
  }

  function setView(patch: Partial<SettingsView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) {
      listener(view);
    }
  }

  function armTicker(): void {
    if (tickTimer !== undefined) return;
    tickTimer = deps.clock.setTimeout(function tick() {
      tickTimer = deps.clock.setTimeout(tick, TICK_MS);
      setView({ lastFrameAgoMs: computeLastFrameAgoMs() });
    }, TICK_MS);
  }

  function disarmTicker(): void {
    if (tickTimer === undefined) return;
    deps.clock.clearTimeout(tickTimer);
    tickTimer = undefined;
  }

  // The connection-store listener is armed and disarmed together with the
  // ticker, on the first/last subscriber, instead of for this store's
  // whole lifetime — `app/settings.tsx` builds a fresh store per screen
  // mount (`useMemo`), so a permanent subscription would leak one listener
  // into `deps.connection` per visit to Settings, forever.
  function armConnectionListener(): void {
    if (unsubscribeConnection !== undefined) return;
    unsubscribeConnection = deps.connection.subscribe((connection) => {
      setView({ connection });
    });
  }

  function disarmConnectionListener(): void {
    unsubscribeConnection?.();
    unsubscribeConnection = undefined;
  }

  // Same first/last-subscriber lifetime as the connection listener above
  // (rule 10) — a store built per screen mount (`useMemo`) must not leak a
  // permanent listener into `deps.push` for every visit to Settings.
  function armPushListener(): void {
    if (unsubscribePush !== undefined) return;
    unsubscribePush = deps.push.subscribe((notifications) => {
      setView({ notifications });
    });
  }

  function disarmPushListener(): void {
    unsubscribePush?.();
    unsubscribePush = undefined;
  }

  // Computes both the connection view and lastFrameAgoMs once, together, in
  // a single notification when the first subscriber arrives — rather than
  // two separate `setView` calls that would double-notify that listener.
  function armAndComputeImmediately(): void {
    armConnectionListener();
    armPushListener();
    armTicker();
    setView({
      connection: deps.connection.get(),
      lastFrameAgoMs: computeLastFrameAgoMs(),
      notifications: deps.push.get(),
    });
  }

  async function loadLanguage(): Promise<void> {
    const prefs = await loadPrefs(deps.prefs, deps.localeTag);
    setView({ language: prefs.language, speakReplies: prefs.speakReplies });
  }

  async function loadLaptop(): Promise<void> {
    const record = await deps.loadRecord();
    if (record === undefined) {
      setView({ laptop: undefined, fingerprintTail: undefined });
      return;
    }
    // `record` (which carries the full fingerprint) never leaves this
    // function scope — only the projection below, and the tail, reach
    // `view`.
    const laptop: SettingsLaptop = {
      host: record.host,
      port: record.port,
      deviceId: record.deviceId,
      pairedAt: record.pairedAt,
    };
    if (record.laptopName !== undefined) {
      laptop.laptopName = record.laptopName;
    }
    setView({ laptop, fingerprintTail: computeFingerprintTail(record.fingerprint) });
  }

  void loadLanguage();
  void loadLaptop();

  async function setLanguage(language: Language): Promise<void> {
    // Rule 17: preserves the current speakReplies rather than resetting it
    // — savePrefs always writes all four keys, so a partial write would
    // silently flip an already-saved value back to the loadPrefs default.
    // M10 Task 5: `notifications`/`pushRegistered` are this store's own
    // blind spot (push-registration.ts owns them) — re-reading the stored
    // `Prefs` right before writing, rather than trusting a locally cached
    // copy, means this store can never clobber a value the push controller
    // wrote in between, no matter which of the two writes it independently.
    const current = await loadPrefs(deps.prefs, deps.localeTag);
    await savePrefs(deps.prefs, { ...current, language, speakReplies: view.speakReplies });
    setView({ language, restartRequired: true });
  }

  async function setSpeakReplies(on: boolean): Promise<void> {
    // M6 language pattern: no try/catch — a rejecting savePrefs leaves
    // `view` at its previous value, since setView below is never reached.
    const current = await loadPrefs(deps.prefs, deps.localeTag);
    await savePrefs(deps.prefs, {
      ...current,
      language: view.language ?? languageFromLocale(deps.localeTag),
      speakReplies: on,
    });
    setView({ speakReplies: on });
  }

  async function setNotifications(on: boolean): Promise<void> {
    await deps.push.setEnabled(on);
  }

  // R-M4 (deferred from M6): a throwing `disconnect()` used to leave
  // `unpairing` stuck `true` forever (it was only ever reset inside the
  // `deps.unpair()` catch, never for this path) and let the exception
  // escape as an unhandled rejection out of `void store.unpair()`. Both are
  // fixed the same way: `unpairing` (and the shared pairing-guard flag) now
  // reset in a single `finally` that covers the whole function, and each
  // `disconnect()` call is wrapped so a throw from the native layer is
  // caught and logged instead of propagating. A guard at entry refuses a
  // second call while one is already running — meaningful now that the
  // reset is guaranteed to happen, so a second tap after a first one
  // actually runs rather than being refused forever by a stuck flag.
  // Fix round 1 (Minor): every `setView` call risks a throw from a
  // subscriber the store doesn't control — swallowed here (and logged with
  // one fixed string) rather than left to propagate, so nothing downstream
  // of a bad listener can turn `unpair()`'s promise into a rejection.
  function safeSetView(patch: Partial<SettingsView>): void {
    try {
      setView(patch);
    } catch {
      deps.log("settings-store: a subscriber threw while unpairing");
    }
  }

  async function unpair(): Promise<void> {
    if (unpairing) return;
    unpairing = true;
    // Shared app-wide flag (pairing-guard.ts): closes the same race for
    // `_layout.tsx`'s /dashboard entry as `unpairing` closes for this
    // store's own `reconnect()` — a back gesture to /dashboard while this
    // clear is still in flight must not reconnect with a pairing that's
    // about to be cleared.
    setClearingPairing(true);
    try {
      safeSetView({ unpairError: false });
      // Rule 10: a phone can register and clear only its own push token
      // (global-constraints.md) — this is that clear, attempted before the
      // pairing itself is torn down so the laptop still has a live
      // credential to accept the call under. Best-effort only: its result
      // is ignored and a throw here must never stop the unpair sequence
      // below, unlike every other step in this function.
      try {
        await deps.client.call(PUSH_UNREGISTER_CHANNEL, [], {
          whenNotOpen: "reject",
          timeoutMs: PUSH_REGISTER_TIMEOUT_MS,
        });
      } catch {
        // Ignored — see comment above.
      }
      try {
        deps.client.disconnect();
      } catch {
        deps.log("settings-store: disconnect() threw before clearing the pairing");
      }
      try {
        await deps.unpair();
      } catch {
        safeSetView({ unpairError: true });
        return;
      }
      // Disconnects again after the clear resolves: covers a connect that
      // slipped in through some path other than this store's own
      // `reconnect()` (which is already blocked by `shouldConnect`) between
      // the disconnect above and the clear finishing.
      try {
        deps.client.disconnect();
      } catch {
        deps.log("settings-store: disconnect() threw after clearing the pairing");
      }
      // Fix round 1 (Minor): the tail — `navigateToPair()` is caller-
      // supplied (app/settings.tsx's `router.replace`) and can throw just
      // as easily as `disconnect()` can; wrapped for the same reason, so
      // `unpair()`'s promise never rejects regardless of which step fails.
      try {
        deps.navigateToPair();
      } catch {
        deps.log("settings-store: navigateToPair() threw after unpair");
      }
    } finally {
      unpairing = false;
      setClearingPairing(false);
    }
  }

  function reconnect(): void {
    if (unpairing) return;
    setView({ reconnectError: false });
    deps.client.disconnect();
    void (async () => {
      let outcome: ConnectStoredOutcome;
      try {
        // R-M2: also refuses while the *automatic* unpaired handler's own
        // clear is in flight (isClearingPairing() — pairing-guard.ts), not
        // only this store's own `unpairing` — a Reconnect tap during that
        // window must not connect with a token that's about to be, or has
        // just been, invalidated.
        outcome = await deps.connectFromStored(() => !unpairing && !isClearingPairing());
      } catch {
        // connectFromStoredPairing never throws by contract, but this is a
        // second line of defence so a change there can never turn into an
        // unhandled rejection here.
        outcome = "failed";
      }
      // Re-checked after the await — `unpair()` may have completed while
      // this reconnect was in flight.
      if (unpairing) return;
      if (outcome === "unpaired") {
        deps.navigateToPair();
        return;
      }
      if (outcome === "failed") {
        setView({ reconnectError: true });
        return;
      }
      // "connected": a stale unpair failure from an earlier attempt no
      // longer applies once a reconnect actually succeeds.
      setView({ unpairError: false, reconnectError: false });
    })();
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        armAndComputeImmediately();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          disarmTicker();
          disarmConnectionListener();
          disarmPushListener();
        }
      };
    },
    setLanguage,
    setSpeakReplies,
    setNotifications,
    unpair,
    reconnect,
  };
}
