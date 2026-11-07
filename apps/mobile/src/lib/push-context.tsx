// One `PushRegistration` per machine's scope (task-6-brief.md, rule 1) — built
// here and handed down through context, the same shape `voice-context.tsx` uses
// for `VoiceController`: this file only wires the controller's
// dependencies to the real app (the scope's `RpcClient`, the native
// notifications adapter, a small prefs facade, the current language and
// the channel's display name). Taps are heard above the key, by
// notification-tap-host.tsx. Every *decision* about permission/registration
// state lives in push-registration.ts. This file only builds the controller
// once — it is never the thing that turns notifications
// on or off itself: the only caller of `PushRegistration.setEnabled` is
// settings-store.ts's `setNotifications`, reached from a user's tap on the
// Settings switch. The pure pieces this component builds
// (`createPrefsFacade`, `loadPushSeed`) live in
// push-context-support.ts, not here — see that file's own header for why.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { t } from "./i18n";
import { useLanguage } from "./language-context";
import { machineStore } from "./machine-store-instance";
import { createNativeNotificationsAdapter } from "./native-notifications";
import type { NotificationsAdapter } from "./notifications";
import { filePrefsStore } from "./prefs-file";
import { NO_MACHINE_PUSH_FLAG, createPrefsFacade, loadPushSeed } from "./push-context-support";
import type { PushPrefs, PushRegistration } from "./push-registration";
import { createPushRegistration } from "./push-registration";
import { useMachineId, useRpcClient } from "./rpc-context";

const PushContext = createContext<PushRegistration | undefined>(undefined);

export function PushProvider(props: { children: React.ReactNode }): React.JSX.Element | null {
  const client = useRpcClient();
  const language = useLanguage();
  // Fixed for this mount, as the key above remounts this on a switch.
  const machineId = useMachineId();
  const pushFlag = useMemo(
    () => (machineId === null ? NO_MACHINE_PUSH_FLAG : machineStore.pushFlag(machineId)),
    [machineId],
  );

  // Loaded once, before the registration is ever built (fix round 1,
  // Important 1 — the review found the previous version's facade
  // answering `prefs.ts`'s defaults until an internal, un-awaited load
  // resolved, so a returning user's switch showed OFF until the socket
  // happened to open, and the "resume after restart" path could be
  // skipped entirely if "open" fired first). Same gate `_layout.tsx` uses
  // for `language` itself: every hook below still runs on every render
  // (Rules of Hooks) — only the JSX at the very end is `null` until this
  // resolves.
  const [prefsSeed, setPrefsSeed] = useState<PushPrefs | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const localeTag = Intl.DateTimeFormat().resolvedOptions().locale;
      const loaded = await loadPushSeed(filePrefsStore, localeTag, pushFlag);
      if (!cancelled) setPrefsSeed(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [pushFlag]);

  const adapterRef = useRef<NotificationsAdapter | undefined>(undefined);
  if (adapterRef.current === undefined) {
    adapterRef.current = createNativeNotificationsAdapter();
  }
  const adapter = adapterRef.current;

  // Built exactly once `prefsSeed` is known, for this scope's whole
  // mount — same lazy-ref pattern voice-context.tsx uses for its
  // controller. `push-registration.ts` doesn't expose its own
  // `isDisposed()` (unlike VoiceController), so this file tracks
  // disposal itself in `disposedRef`, checked the same way, to rebuild
  // after React StrictMode's dev-only double-invoked effects instead of
  // reusing an already torn-down instance for the rest of the app's
  // life. Like voice-context.tsx's own guard, this only re-checks at the
  // top of the *next* render, not synchronously inside the effect's own
  // cleanup — a one-tick gap that instance already accepts.
  const disposedRef = useRef(true);
  const registrationRef = useRef<PushRegistration | undefined>(undefined);
  if (prefsSeed !== undefined && (registrationRef.current === undefined || disposedRef.current)) {
    const localeTag = Intl.DateTimeFormat().resolvedOptions().locale;
    registrationRef.current = createPushRegistration({
      client,
      adapter,
      prefs: createPrefsFacade(filePrefsStore, localeTag, prefsSeed, pushFlag),
      language: () => language,
      channelName: () => t(language, "notifications.channelName"),
      log: (line) => console.log(line),
    });
    disposedRef.current = false;
    adapter.setForegroundHandler();
    // A joined machine's first open, and any other, can land before this mounts.
    registrationRef.current.syncIfOpen();
  }
  const registration = registrationRef.current;

  useEffect(() => {
    if (registration === undefined) return;
    return () => {
      registration.dispose();
      disposedRef.current = true;
    };
  }, [registration]);

  if (registration === undefined) {
    return null;
  }

  return <PushContext.Provider value={registration}>{props.children}</PushContext.Provider>;
}

export function usePushRegistration(): PushRegistration {
  const value = useContext(PushContext);
  if (value === undefined) {
    throw new Error("usePushRegistration() called outside PushProvider");
  }
  return value;
}
