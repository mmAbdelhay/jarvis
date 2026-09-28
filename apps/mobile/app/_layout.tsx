import Constants from "expo-constants";
import { useFonts } from "expo-font";
import { Stack, usePathname, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { AppState, I18nManager, Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { APP_FONTS } from "@/lib/app-fonts";
import { appActivityFor } from "@/lib/app-lifecycle";
import { deviceOrientationPolicy } from "@/lib/app-orientation";
import { authChannel } from "@/lib/auth-channel";
import { createAuthSession } from "@/lib/auth-session";
import { clientPlatformFor, clientStringFor } from "@/lib/client-platform";
import { realClock } from "@/lib/clock";
import { connectFromStoredPairing as connectFromStored } from "@/lib/connect-stored";
import { shouldConnectOnRoute } from "@/lib/dashboard-entry";
import { createConnectionStore } from "@/lib/connection-store";
import type { Language } from "@/lib/i18n";
import { isRtl, t } from "@/lib/i18n";
import { LanguageContext } from "@/lib/language-context";
import { nativeTransport } from "@/lib/native-transport";
import { isClearingPairing } from "@/lib/pairing-guard";
import { clearPairing } from "@/lib/pairing-record";
import { filePrefsStore } from "@/lib/prefs-file";
import { createRefreshStoredFlag, DEFAULT_IDLE_LOCK_MINUTES, loadPrefs } from "@/lib/prefs";
import { PushProvider } from "@/lib/push-context";
import { createDeviceAuth } from "@/lib/device-auth";
import { refreshLock } from "@/lib/refresh-lock";
import { refreshStore } from "@/lib/refresh-store";
import { createRpcClient } from "@/lib/rpc-client";
import { RpcContext } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import { systemTransportFor } from "@/lib/system-transport";
import { theme } from "@/lib/theme";
import { createAppTransport } from "@/lib/trust-routing-transport";
import { createUnpairedHandler } from "@/lib/unpaired-handler";
import { shouldShowUnlock } from "@/lib/unlock-screen";
import { useLayoutClass } from "@/lib/use-layout-class";
import { VoiceProvider } from "@/lib/voice-context";

const CLIENT_STRING = clientStringFor(Platform.OS, Constants.expoConfig?.version ?? "0.0.0");
const PLATFORM = clientPlatformFor(Platform.OS);
// M11 rule 6: constructed once, module-wide — a pairing with a `name`
// routes through `systemTransport` (OS trust store), one without pins
// natively through `nativeTransport`, exactly as before. Task 13: the
// browser build always dials through `systemTransport` (createAppTransport).
const transport = createAppTransport(PLATFORM, {
  pin: nativeTransport,
  system: systemTransportFor(PLATFORM),
});

// Composes the app's two per-app controller providers into the one slot
// `RootLayout`'s tree already had for `VoiceProvider` alone (fix round 1,
// Minor) — nesting `PushProvider` directly in the return tree below would
// add a level to every line under it, sizing the diff at "everything
// inside VoiceProvider" for what is otherwise a one-line change to two
// providers' order.
function Providers(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <PushProvider>
      <VoiceProvider>{props.children}</VoiceProvider>
    </PushProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts(APP_FONTS);
  const [language, setLanguage] = useState<Language | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const layout = useLayoutClass();
  const wide = layout.kind === "wide";

  // Built exactly once, for the app's whole lifetime — this is "the one
  // RpcClient" every screen shares through RpcContext.
  const clientRef = useRef<ReturnType<typeof createRpcClient> | undefined>(undefined);
  if (clientRef.current === undefined) {
    clientRef.current = createRpcClient({
      transport,
      clock: realClock,
      random: Math.random,
      client: CLIENT_STRING,
      log: (line) => console.log(line),
    });
  }
  const client = clientRef.current;

  // Phase 0 owner login: the app's one auth session over the shared client.
  // The biometric prompt reads the language when it is shown, so it is
  // right even though prefs load after this runs.
  const languageRef = useRef<Language | null>(null);
  languageRef.current = language;
  const authSessionRef = useRef<ReturnType<typeof createAuthSession> | undefined>(undefined);
  if (authSessionRef.current === undefined) {
    authSessionRef.current = createAuthSession({
      rpc: client,
      clock: realClock,
      refreshStore,
      // Load-change-save like every prefs writer; the locale only feeds
      // loadPrefs's language fallback.
      refreshStoredFlag: createRefreshStoredFlag(
        filePrefsStore,
        Intl.DateTimeFormat().resolvedOptions().locale,
      ),
      deviceAuth: createDeviceAuth(() => t(languageRef.current ?? "en", "auth.biometricPrompt")),
      // Browser: the stored token only signs in at page load; an idle lock
      // needs a passkey or the password.
      storedUnlockAtLaunchOnly: PLATFORM === "web",
      // Browser: tabs share the stored token, so rotations take turns.
      refreshLock,
      // Browser: keep-signed-in off and logout lock every other tab too.
      authChannel,
      idleMs: DEFAULT_IDLE_LOCK_MINUTES * 60_000,
      log: (line) => console.log(line),
    });
  }
  const authSession = authSessionRef.current;

  // The decision — clear the pairing, log without secrets if that fails,
  // navigate to /pair either way — is a plain, tested function
  // (unpaired-handler.ts); this component only wires its two effectful
  // dependencies. Built once and shared by both `connectionStore`'s
  // automatic reaction to an "unpaired" state (a close code the server
  // sent) and the banner's one-tap "Pair again" below (M11 rule 5) — one
  // clearer, two callers, per the brief: never a third copy of "clear +
  // navigate".
  const unpairedHandlerRef = useRef<ReturnType<typeof createUnpairedHandler> | undefined>(
    undefined,
  );
  if (unpairedHandlerRef.current === undefined) {
    unpairedHandlerRef.current = createUnpairedHandler({
      clearPairing: async () => {
        await clearPairing(expoSecureStore);
        // The stored refresh token belongs to the pairing it was issued under.
        await authSession.forget();
      },
      // The distinct "clearFailed" phase itself is now signalled to
      // /pair via the one-shot clear-failed-signal.ts flag (set by
      // createUnpairedHandler itself, never from a route param — a
      // forged `jarvis://pair?...&clearFailed=1` link could otherwise
      // reach it), so this callback only ever routes there.
      navigateToPair: () => {
        router.replace("/pair");
      },
      log: (line) => console.warn(line),
    });
  }

  const connectionStoreRef = useRef<ReturnType<typeof createConnectionStore> | undefined>(
    undefined,
  );
  // Also rebuild if the cached ref holds an already-disposed store — under
  // React StrictMode's dev-only double-invoked effects, the cleanup below
  // runs once more than the effect itself, which would otherwise leave
  // this ref pointing at a torn-down store for the rest of the
  // component's life.
  if (connectionStoreRef.current === undefined || connectionStoreRef.current.isDisposed()) {
    connectionStoreRef.current = createConnectionStore({
      client,
      clock: realClock,
      // Runs asynchronously off the store's onState reaction, never
      // synchronously from inside it.
      onUnpaired: unpairedHandlerRef.current,
    });
  }
  const connectionStore = connectionStoreRef.current;

  // M11 rule 5: the banner's "Pair again" button, confirmed there, ends up
  // here. Unlike the automatic path above (whose socket the server has
  // already closed by the time onUnpaired runs), a pin mismatch keeps
  // reconnecting — this disconnects first so the phone stops retrying the
  // old pairing before reusing the exact same clear-and-navigate function.
  const handlePairAgain = useCallback(() => {
    client.disconnect();
    void unpairedHandlerRef.current?.();
  }, [client]);

  useEffect(() => {
    return () => {
      connectionStore.dispose();
    };
  }, [connectionStore]);

  // M12 Task 5 (M10 ruling d): the app's one `AppState` listener, mapped
  // through `appActivityFor` straight onto the shared client's
  // `setAppActive` — drops every subscription the moment the app
  // backgrounds and re-attaches them (via the client's own resumed `open`
  // notification, which every existing `onState("open")` consumer already
  // reacts to — rule 8) the moment it returns. On mount, a launch that is
  // already backgrounded (e.g. a background push delivery) suspends at
  // once, before the first `change` event ever fires.
  useEffect(() => {
    if (appActivityFor(AppState.currentState) === "suspend") {
      client.setAppActive(false);
      authSession.setAppActive(false);
    }
    const subscription = AppState.addEventListener("change", (next) => {
      const activity = appActivityFor(next);
      if (activity === "activate") {
        // The idle check first: an app back after the idle window locks
        // before its subscriptions resume.
        authSession.setAppActive(true);
        client.setAppActive(true);
      } else if (activity === "suspend") {
        client.setAppActive(false);
        authSession.setAppActive(false);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [client, authSession]);

  // Sidecar landscape fix: app.config.ts's own `orientation` is "default"
  // now (not "portrait"), so the sidecar WebView screen can unlock to
  // landscape (app/sidecar-view.tsx's own useFocusEffect) — every other
  // screen locks back to portrait here, once, on mount. Not re-run on
  // every route change: sidecar-view.tsx's unlock-on-focus/re-lock-on-
  // blur pair is what puts it back for every screen underneath it, this
  // is only the app's starting state. Wrapped in try/catch: the web
  // target and some simulators reject `lockAsync` outright.
  useEffect(() => {
    // Phones only: a tablet's wide layout fits both orientations, so it
    // keeps app.config.ts's "default" (orientation-policy.ts).
    if (deviceOrientationPolicy() !== "portrait-lock") return;
    void (async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      } catch {
        // Simulator/web: no native orientation lock to set. Nothing to do.
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const localeTag = Intl.DateTimeFormat().resolvedOptions().locale;
      const prefs = await loadPrefs(filePrefsStore, localeTag);

      // Process-wide, must be set before the first screen renders — a
      // language change afterwards only takes effect on restart (ruling 6).
      I18nManager.allowRTL(true);
      I18nManager.forceRTL(isRtl(prefs.language));

      authSession.setIdleMs(prefs.idleLockMinutes * 60_000);
      if (!cancelled) {
        setLanguage(prefs.language);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authSession]);

  // Phase 0 owner login: whenever the connection is locked (or the phone
  // locked itself), the unlock screen goes on top of wherever the owner was.
  const [connectionState, setConnectionState] = useState(connectionStore.get().state);
  useEffect(() => {
    setConnectionState(connectionStore.get().state);
    return connectionStore.subscribe((view) => setConnectionState(view.state));
  }, [connectionStore]);
  const [authView, setAuthView] = useState(authSession.get());
  useEffect(() => {
    setAuthView(authSession.get());
    return authSession.subscribe(setAuthView);
  }, [authSession]);
  const ready = language !== null && fontsLoaded;
  // Set between a push and the route actually reaching /unlock, so a
  // second state change in that window can't stack a second unlock screen.
  const unlockPushPending = useRef(false);
  // Any move out of "locked" also clears it, so a push that never reached
  // /unlock can't block every later one.
  useEffect(() => {
    if (connectionState !== "locked") unlockPushPending.current = false;
  }, [connectionState]);
  useEffect(() => {
    if (!ready) return;
    if (pathname === "/unlock") {
      unlockPushPending.current = false;
      return;
    }
    if (unlockPushPending.current) return;
    if (shouldShowUnlock(connectionState, authView, pathname)) {
      unlockPushPending.current = true;
      router.push("/unlock");
    }
  }, [ready, connectionState, authView, pathname, router]);

  // Connects the shared client from whatever pairing is on disk — the same
  // function Settings' reconnect() uses — or routes to /pair when the read
  // failed or found nothing, instead of leaving the client `idle` with an
  // empty Dashboard, no banner (bannerKey("idle") is undefined) and no way
  // forward. `connectFromStored` (connect-stored.ts) performs the one read
  // and, via `dashboardEntryAction`, decides between the two effects — this
  // callback only routes on its outcome. `shouldConnect` refuses to connect
  // while a pairing clear (pairing-guard.ts) is in flight: Settings is
  // pushed over the Dashboard, so a back gesture from /pair can land here
  // directly, and without this guard it would reconnect with a token that
  // is (or is about to be) invalidated by that clear.
  const connectFromStoredPairing = useCallback(async () => {
    const outcome = await connectFromStored({
      secureStore: expoSecureStore,
      client,
      shouldConnect: () => !isClearingPairing(),
    });
    if (outcome !== "connected") {
      router.replace("/pair");
    }
  }, [client, router]);

  // Once at launch on whatever route loaded (D3: a browser reload on
  // /unlock, /voice or /settings never connected), and again whenever the
  // route reaches /dashboard: `connect()` is a no-op unless the client is
  // idle/closed/unpaired (rpc-client.ts rule 8), so calling it again is
  // always safe, and it is what activates the connection right after /pair
  // saves a fresh pairing and navigates here — without an app restart.
  const launchConnectHandled = useRef(false);
  useEffect(() => {
    const connect = shouldConnectOnRoute(pathname, launchConnectHandled.current);
    launchConnectHandled.current = true;
    if (connect) void connectFromStoredPairing();
  }, [pathname, connectFromStoredPairing]);

  // `{ client, connectionStore }` is otherwise a
  // fresh object every render, re-rendering every RpcContext consumer
  // (Dashboard, Settings) even when neither value actually changed —
  // both are already stable across renders (refs), so memoise on them.
  const rpcContextValue = useMemo(
    () => ({ client, connectionStore, authSession, reconnect: connectFromStoredPairing }),
    [client, connectionStore, authSession, connectFromStoredPairing],
  );

  if (language === null || !fontsLoaded) {
    return null;
  }

  return (
    <LanguageContext.Provider value={language}>
      <RpcContext.Provider value={rpcContextValue}>
        <Providers>
          <SafeAreaProvider>
            {/* Every touch anywhere restarts the idle-lock window. */}
            <View style={{ flex: 1 }} onTouchStart={() => authSession.touch()}>
              <ConnectionBanner
                store={connectionStore}
                onRetry={() => {
                  void connectFromStoredPairing();
                }}
                onPairAgain={handlePairAgain}
              />
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(tabs)" />
                {/* Wide layout: Settings draws the same shell as the tabs,
                    so it swaps in place rather than sliding over them. */}
                <Stack.Screen
                  name="settings"
                  options={{ animation: layout.kind === "wide" ? "none" : "default" }}
                />
                <Stack.Screen
                  name="session/[id]"
                  options={{
                    // Wide: this screen only redirects to the sessions
                    // split, so it draws no header while it does.
                    headerShown: layout.kind !== "wide",
                    animation: layout.kind === "wide" ? "none" : "default",
                    // Fix round 1 (Important 1): `title`, not `headerTitle` — the
                    // screen's own `<Stack.Screen options={{ title: row.summary }} />`
                    // merges into this component's options via
                    // `navigation.setOptions`, and native-stack prefers a string
                    // `headerTitle` over `title` after that merge. Using `title`
                    // here lets the screen's `row.summary` win once the row is
                    // known, while this stays the header until then.
                    title: t(language, "sessions.title"),
                    headerStyle: { backgroundColor: theme.colors.background },
                    headerTintColor: theme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="changes"
                  options={{
                    // Wide: drawn inside the shell with its own panel header.
                    headerShown: !wide,
                    animation: wide ? "none" : "default",
                    headerTitle: t(language, "changes.title"),
                    headerStyle: { backgroundColor: theme.colors.background },
                    headerTintColor: theme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="history"
                  options={{
                    // Wide: drawn inside the shell with its own panel header.
                    headerShown: !wide,
                    animation: wide ? "none" : "default",
                    headerTitle: t(language, "history.title"),
                    headerStyle: { backgroundColor: theme.colors.background },
                    headerTintColor: theme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="transcript/[id]"
                  options={{
                    // Wide: drawn inside the shell with its own panel header.
                    headerShown: !wide,
                    animation: wide ? "none" : "default",
                    title: t(language, "history.transcript"),
                    headerStyle: { backgroundColor: theme.colors.background },
                    headerTintColor: theme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="sidecars/[project]"
                  options={{
                    // Wide: drawn inside the shell with its own panel header.
                    headerShown: !wide,
                    animation: wide ? "none" : "default",
                    headerTitle: t(language, "sidecars.title"),
                    headerStyle: { backgroundColor: theme.colors.background },
                    headerTintColor: theme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="sidecar-view"
                  // Slim-header fix: this screen now draws its own single-row
                  // header (back + title + zoom controls + desktop-site
                  // toggle, all in one 44px row) instead of the native
                  // header this used to configure — the native header's
                  // title/right-button layout is what produced the old
                  // two-line header (a long title plus a below-it toggle
                  // pill). `headerShown: false` here hands the whole header
                  // to the screen; see app/sidecar-view.tsx.
                  options={{ headerShown: false }}
                />
                <Stack.Screen
                  name="docker/[project]"
                  options={{
                    // Wide: drawn inside the shell with its own panel header.
                    headerShown: !wide,
                    animation: wide ? "none" : "default",
                    // The screen's own `<Stack.Screen options={{ title }} />`
                    // merges the project name in once known (session/[id].tsx's
                    // same convention) — this is only the default shown first.
                    title: t(language, "docker.title"),
                    headerStyle: { backgroundColor: theme.colors.background },
                    headerTintColor: theme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="terminal/[paneKey]"
                  options={{
                    // Wide: this screen only redirects to the Workspace
                    // tab, so it draws no header while it does.
                    headerShown: layout.kind !== "wide",
                    animation: layout.kind === "wide" ? "none" : "default",
                    // The screen's own `<Stack.Screen options={{ title }} />`
                    // sets the pane key once mounted (docker/[project].tsx's
                    // same convention) — this is only the default shown first.
                    title: t(language, "workspace.terminal"),
                    headerStyle: { backgroundColor: theme.colors.background },
                    headerTintColor: theme.colors.text,
                  }}
                />
                <Stack.Screen
                  name="unlock"
                  // No swipe back past the lock: it closes itself once unlocked.
                  options={{ headerShown: false, gestureEnabled: false }}
                />
              </Stack>
            </View>
          </SafeAreaProvider>
        </Providers>
      </RpcContext.Provider>
    </LanguageContext.Provider>
  );
}
