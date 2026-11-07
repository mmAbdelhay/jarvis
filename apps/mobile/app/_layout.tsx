import Constants from "expo-constants";
import { useFonts } from "expo-font";
import { Stack, useNavigationContainerRef, usePathname, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type React from "react";
import { AppState, I18nManager, Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { APP_FONTS } from "@/lib/app-fonts";
import { appActivityFor } from "@/lib/app-lifecycle";
import { deviceOrientationPolicy } from "@/lib/app-orientation";
import { authChannel } from "@/lib/auth-channel";
import type { AuthSession } from "@/lib/auth-session";
import { clientPlatformFor, clientStringFor } from "@/lib/client-platform";
import { realClock } from "@/lib/clock";
import type { ConnectionStore } from "@/lib/connection-store";
import { shouldConnectOnRoute } from "@/lib/dashboard-entry";
import type { Language } from "@/lib/i18n";
import { isRtl, t } from "@/lib/i18n";
import { LanguageContext } from "@/lib/language-context";
import type { MachineId } from "@/lib/machine-index";
import { MachinesContext, NavigatorGateContext } from "@/lib/machine-context";
import {
  type MachineScope,
  type MachineSessions,
  createMachineScopeBuilder,
  createMachineSessions,
  prepareSwitchRoute,
  unpairedHandlerFor,
} from "@/lib/machine-sessions";
import { machineStore, openMachineStore } from "@/lib/machine-store-instance";
import { nativeTransport } from "@/lib/native-transport";
import { filePrefsStore } from "@/lib/prefs-file";
import { createAppPhoneUpdateStore } from "@/lib/phone-update-app";
import { PhoneUpdateProvider } from "@/lib/phone-update-context";
import { DEFAULT_IDLE_LOCK_MINUTES, loadPrefs } from "@/lib/prefs";
import { PushProvider } from "@/lib/push-context";
import { createDeviceAuth } from "@/lib/device-auth";
import { refreshLock } from "@/lib/refresh-lock";
import { refreshStore } from "@/lib/refresh-store";
import { RpcContext } from "@/lib/rpc-context";
import {
  type NavigatorGate,
  type ScopeRouting,
  createNavigatorGate,
  createScopeRouting,
  reconnectOrPair,
} from "@/lib/scope-routing";
import { systemTransportFor } from "@/lib/system-transport";
import { theme } from "@/lib/theme";
import { createAppTransport } from "@/lib/trust-routing-transport";
import { dialogs } from "@/lib/dialog";
import { useLayoutClass } from "@/lib/use-layout-class";
import { VoiceProvider } from "@/lib/voice-context";

const CLIENT_STRING = clientStringFor(Platform.OS, Constants.expoConfig?.version ?? "0.0.0");
const PLATFORM = clientPlatformFor(Platform.OS);
// The app's one phone-update store, started by PhoneUpdateProvider for the
// app's lifetime (Settings → Updates, Home's banner).
const phoneUpdateStore = createAppPhoneUpdateStore();
// M11 rule 6: constructed once, module-wide — a pairing with a `name`
// routes through `systemTransport` (OS trust store), one without pins
// natively through `nativeTransport`, exactly as before. Task 13: the
// browser build always dials through `systemTransport` (createAppTransport).
const transport = createAppTransport(PLATFORM, {
  pin: nativeTransport,
  system: systemTransportFor(PLATFORM),
});

const log = (line: string): void => console.log(line);

const loadRecord = async (id: MachineId) => (await machineStore.load(id))?.record;

export default function RootLayout() {
  const [fontsLoaded] = useFonts(APP_FONTS);
  const [language, setLanguage] = useState<Language | null>(null);
  const router = useRouter();

  // The biometric prompt reads the language when it is shown, so it is right
  // even though prefs load after the sessions are built.
  const languageRef = useRef<Language | null>(null);
  languageRef.current = language;
  const routerRef = useRef(router);
  routerRef.current = router;
  // From prepareSwitch until the next scope is published: the tree on screen
  // belongs to the machine being left, and raises no unlock screen of its own.
  const switchingRef = useRef(false);
  // Rule 2 of push-context.tsx: above the key, or `lastResponse()` would
  // replay a tap after each switch.
  const handledIdsRef = useRef<Set<string>>(new Set());
  // Above the key, as a route can be waiting across a remount. `isReady` is the
  // check the router itself makes before it throws (expo-router's
  // global-state/store.js, `assertIsReady`).
  const navigationRef = useNavigationContainerRef();
  const gateRef = useRef<NavigatorGate | undefined>(undefined);
  gateRef.current ??= createNavigatorGate(() => navigationRef.isReady());
  const gate = gateRef.current;

  // Built exactly once, for the app's whole lifetime. Each machine's client,
  // connection store and auth session live in its scope, and nowhere here.
  const sessionsRef = useRef<MachineSessions | undefined>(undefined);
  if (sessionsRef.current === undefined) {
    const store = { ...machineStore, open: openMachineStore };
    const sessions: MachineSessions = createMachineSessions({
      store,
      buildScope: createMachineScopeBuilder({
        store,
        refreshStore,
        transport,
        clock: realClock,
        random: Math.random,
        client: CLIENT_STRING,
        deviceAuth: createDeviceAuth(() => t(languageRef.current ?? "en", "auth.biometricPrompt")),
        // Browser: the stored token only signs in at page load; an idle lock
        // needs a passkey or the password.
        storedUnlockAtLaunchOnly: PLATFORM === "web",
        // Browser: tabs share the stored token, so rotations take turns.
        refreshLock,
        // Browser: keep-signed-in off and logout lock every other tab too.
        authChannel,
        idleMs: DEFAULT_IDLE_LOCK_MINUTES * 60_000,
        onUnpaired: (id) =>
          unpairedHandlerFor({
            id,
            cause: "revoked",
            sessions,
            loadRecord,
            gate,
            navigateToPair: () => routerRef.current.replace("/pair"),
            noticeRemoved: (name) =>
              dialogs.notice(t(languageRef.current ?? "en", "machines.removedNotice", { name })),
            log: (line) => console.warn(line),
          })(),
        log,
      }),
      prepareSwitch: () => {
        switchingRef.current = true;
        prepareSwitchRoute(routerRef.current, gate, log);
      },
      switchAbandoned: () => {
        switchingRef.current = false;
      },
      log,
    });
    sessionsRef.current = sessions;
  }
  const sessions = sessionsRef.current;

  const [scope, setScope] = useState<MachineScope>(sessions.current());
  useEffect(() => {
    setScope(sessions.current());
    return sessions.subscribe((next) => {
      switchingRef.current = false;
      // The key below changes, so the tree on screen is on its way out from
      // here: a route asked for now waits for the next one to mount.
      gate.setMounted(false);
      setScope(next);
    });
  }, [sessions, gate]);

  // Nothing mounts until the machine to start on is known: a screen on the
  // null scope would remount at once, and a tap's handler would have spent its
  // once-per-id on a client that never opens. `start` answers once the store
  // has opened, or failed to; the tree's own launch connect routes on that.
  // A launch landing on /pair connects nothing (dashboard-entry.ts): a machine
  // connects when the route reaches /dashboard.
  const launchPathname = useRef(usePathname()).current;
  const [started, setStarted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void sessions
      .start(undefined, () => shouldConnectOnRoute(launchPathname, false))
      .then(() => {
        if (!cancelled) setStarted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessions, launchPathname]);

  // M12 Task 5 (M10 ruling d): the app's one `AppState` listener, mapped
  // through `appActivityFor` onto the active machine (the sessions apply it to
  // whichever is activated later) — drops every subscription the moment the
  // app backgrounds and re-attaches them (via the client's own resumed `open`
  // notification, which every existing `onState("open")` consumer already
  // reacts to — rule 8) the moment it returns. On mount, a launch that is
  // already backgrounded (e.g. a background push delivery) suspends at
  // once, before the first `change` event ever fires.
  useEffect(() => {
    if (appActivityFor(AppState.currentState) === "suspend") {
      sessions.setAppActive(false);
    }
    const subscription = AppState.addEventListener("change", (next) => {
      const activity = appActivityFor(next);
      if (activity === "activate") {
        sessions.setAppActive(true);
      } else if (activity === "suspend") {
        sessions.setAppActive(false);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [sessions]);

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

      if (!cancelled) {
        // Before anything mounts. The sessions keep it for each scope, built
        // or to come, and Settings' setter goes the same way.
        sessions.setIdleMs(prefs.idleLockMinutes * 60_000);
        setLanguage(prefs.language);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  if (language === null || !fontsLoaded || !started) {
    return null;
  }

  return (
    <LanguageContext.Provider value={language}>
      <MachinesContext.Provider value={sessions}>
        <NavigatorGateContext.Provider value={gate}>
          <PhoneUpdateProvider store={phoneUpdateStore}>
            <Fragment key={scope.generation}>
              <ScopedTree
                scope={scope}
                sessions={sessions}
                language={language}
                handledIds={handledIdsRef.current}
                switchingRef={switchingRef}
                gate={gate}
              />
            </Fragment>
          </PhoneUpdateProvider>
        </NavigatorGateContext.Provider>
      </MachinesContext.Provider>
    </LanguageContext.Provider>
  );
}

// Everything that belongs to one machine, mounted once per published scope:
// the key above drops every store, every piece of screen state and these
// effects' refs when the scope changes.
function ScopedTree(props: {
  scope: MachineScope;
  sessions: MachineSessions;
  language: Language;
  handledIds: Set<string>;
  switchingRef: React.RefObject<boolean>;
  gate: NavigatorGate;
}): React.JSX.Element {
  const { scope, sessions, language, handledIds, switchingRef, gate } = props;
  const { client, connectionStore, authSession } = scope;
  const router = useRouter();
  const layout = useLayoutClass();
  const wide = layout.kind === "wide";

  // M11 rule 5: the banner's "Pair again" button, confirmed there, ends up
  // here. Unlike the automatic path (whose socket the server has already
  // closed by the time onUnpaired runs), a pin mismatch keeps reconnecting —
  // this disconnects first so the phone stops retrying the old pairing before
  // reusing the exact same clear-and-navigate function: one clearer, two
  // callers, never a third copy of "clear + navigate".
  const handlePairAgain = useCallback(() => {
    client.disconnect();
    void unpairedHandlerFor({
      id: scope.id,
      cause: "pair-again",
      sessions,
      loadRecord,
      gate,
      navigateToPair: () => router.replace("/pair"),
      log: (line) => console.warn(line),
    })();
  }, [client, scope.id, sessions, router, gate]);

  // Connects from whatever pairing is on disk — the same path Settings'
  // reconnect() uses — or routes to /pair when the read failed or found
  // nothing, instead of leaving the client `idle` with an empty Dashboard, no
  // banner (bannerKey("idle") is undefined) and no way forward. The sessions
  // refuse to connect while a clear of that machine (pairing-guard.ts) is in
  // flight: Settings is pushed over the Dashboard, so a back gesture from /pair
  // can land here directly, and without that it would reconnect with a token
  // that is (or is about to be) invalidated by that clear.
  const reconnect = useCallback(
    () =>
      reconnectOrPair({
        sessions,
        client,
        gate,
        navigateToPair: () => router.replace("/pair"),
      }),
    [sessions, client, gate, router],
  );

  // `{ client, connectionStore }` is otherwise a
  // fresh object every render, re-rendering every RpcContext consumer
  // (Dashboard, Settings) even when neither value actually changed —
  // all are stable for this mount, so memoise on them.
  const rpcContextValue = useMemo(
    () => ({ machineId: scope.id, client, connectionStore, authSession, reconnect }),
    [scope.id, client, connectionStore, authSession, reconnect],
  );

  return (
    <RpcContext.Provider value={rpcContextValue}>
      <PushProvider handledIds={handledIds} gate={gate}>
        <VoiceProvider>
          <SafeAreaProvider>
            {/* Every touch anywhere restarts the idle-lock window. */}
            <View style={{ flex: 1 }} onTouchStart={() => authSession.touch()}>
              <ConnectionBanner
                store={connectionStore}
                onRetry={() => {
                  void reconnect();
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
                    // The screen draws its own ScreenHeader on a phone; wide
                    // only redirects to the sessions split.
                    headerShown: false,
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
                    // Phone: ScreenHeader inside the screen. Wide: the shell's
                    // panel header.
                    headerShown: false,
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
                    // The screen draws its own ScreenHeader on a phone; wide
                    // only redirects to the Workspace tab.
                    headerShown: false,
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
                  name="reviews/index"
                  options={{
                    // Phone: ScreenHeader inside the screen. Wide: the shell's
                    // panel header.
                    headerShown: false,
                    animation: wide ? "none" : "default",
                    title: t(language, "reviews.title"),
                  }}
                />
                <Stack.Screen
                  name="reviews/[pr]"
                  options={{
                    headerShown: false,
                    animation: wide ? "none" : "default",
                    title: t(language, "reviews.title"),
                  }}
                />
                <Stack.Screen
                  name="unlock"
                  // No swipe back past the lock: it closes itself once unlocked.
                  options={{ headerShown: false, gestureEnabled: false }}
                />
              </Stack>
              {/* After `Stack`, on purpose: see ScopeRouteEffects. */}
              <ScopeRouteEffects
                connectionStore={connectionStore}
                authSession={authSession}
                reconnect={reconnect}
                switchingRef={switchingRef}
                gate={gate}
              />
            </View>
          </SafeAreaProvider>
        </VoiceProvider>
      </PushProvider>
    </RpcContext.Provider>
  );
}

// The route effects, rendered beside `Stack` and after it. `PushProvider`
// renders neither until its prefs load, so these can only run with `Stack`
// mounted, and React runs a sibling's effects in order, so by the time they do
// `Stack` has registered with the navigation container (scope-routing.ts). Up
// in `ScopedTree` they ran on a commit with no navigator, and a route asked for
// there brought the whole app down.
function ScopeRouteEffects(props: {
  connectionStore: ConnectionStore;
  authSession: AuthSession;
  reconnect: () => Promise<void>;
  switchingRef: React.RefObject<boolean>;
  gate: NavigatorGate;
}): null {
  const { connectionStore, authSession, reconnect, switchingRef, gate } = props;
  const router = useRouter();
  const pathname = usePathname();
  const routingRef = useRef<ScopeRouting | undefined>(undefined);
  routingRef.current ??= createScopeRouting();
  const routing = routingRef.current;

  // A layout effect, for its cleanup: that runs during the commit that removes
  // this tree, where `isReady` would stay true until the passive flush
  // (scope-routing.ts).
  useLayoutEffect(() => {
    gate.setMounted(true);
    return () => gate.setMounted(false);
  }, [gate]);

  // Whatever asked for a route before there was a navigator to take it.
  useEffect(() => {
    gate.flush();
  });

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
  useEffect(() => {
    routing.connectionChanged(connectionState);
  }, [routing, connectionState]);
  useEffect(() => {
    const push = routing.shouldPushUnlock({
      state: connectionState,
      auth: authView,
      pathname,
      switching: switchingRef.current,
    });
    if (push) gate.navigate(() => router.push("/unlock"));
  }, [routing, connectionState, authView, pathname, router, switchingRef, gate]);

  // Once at launch on whatever route loaded (D3: a browser reload on
  // /unlock, /voice or /settings never connected), and again whenever the
  // route reaches /dashboard: `connect()` is a no-op unless the client is
  // idle/closed/unpaired (rpc-client.ts rule 8), so calling it again is
  // always safe, and it is what activates the connection right after /pair
  // saves a fresh pairing and navigates here — without an app restart.
  useEffect(() => {
    if (routing.shouldConnect(pathname)) void reconnect();
  }, [routing, pathname, reconnect]);

  return null;
}
