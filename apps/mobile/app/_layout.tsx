import Constants from "expo-constants";
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  useFonts,
} from "@expo-google-fonts/manrope";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
} from "@expo-google-fonts/jetbrains-mono";
import { Stack, usePathname, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { AppState, I18nManager, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { appActivityFor } from "@/lib/app-lifecycle";
import { realClock } from "@/lib/clock";
import { connectFromStoredPairing as connectFromStored } from "@/lib/connect-stored";
import { createConnectionStore } from "@/lib/connection-store";
import type { Language } from "@/lib/i18n";
import { isRtl, t } from "@/lib/i18n";
import { LanguageContext } from "@/lib/language-context";
import { nativeTransport } from "@/lib/native-transport";
import { isClearingPairing } from "@/lib/pairing-guard";
import { clearPairing } from "@/lib/pairing-record";
import { filePrefsStore } from "@/lib/prefs-file";
import { loadPrefs } from "@/lib/prefs";
import { PushProvider } from "@/lib/push-context";
import { createRpcClient } from "@/lib/rpc-client";
import { RpcContext } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import { systemTransport } from "@/lib/system-transport";
import { theme } from "@/lib/theme";
import { createTrustRoutingTransport } from "@/lib/trust-routing-transport";
import { createUnpairedHandler } from "@/lib/unpaired-handler";
import { VoiceProvider } from "@/lib/voice-context";

const CLIENT_STRING = `jarvis-mobile/${Constants.expoConfig?.version ?? "0.0.0"}/${Platform.OS}`;
// M11 rule 6: constructed once, module-wide — a pairing with a `name`
// routes through `systemTransport` (OS trust store), one without pins
// natively through `nativeTransport`, exactly as before.
const transport = createTrustRoutingTransport({ pin: nativeTransport, system: systemTransport });

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
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
  });
  const [language, setLanguage] = useState<Language | null>(null);
  const router = useRouter();
  const pathname = usePathname();

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
      clearPairing: () => clearPairing(expoSecureStore),
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
    }
    const subscription = AppState.addEventListener("change", (next) => {
      const activity = appActivityFor(next);
      if (activity === "activate") client.setAppActive(true);
      else if (activity === "suspend") client.setAppActive(false);
    });
    return () => {
      subscription.remove();
    };
  }, [client]);

  // Sidecar landscape fix: app.config.ts's own `orientation` is "default"
  // now (not "portrait"), so the sidecar WebView screen can unlock to
  // landscape (app/sidecar-view.tsx's own useFocusEffect) — every other
  // screen locks back to portrait here, once, on mount. Not re-run on
  // every route change: sidecar-view.tsx's unlock-on-focus/re-lock-on-
  // blur pair is what puts it back for every screen underneath it, this
  // is only the app's starting state. Wrapped in try/catch: the web
  // target and some simulators reject `lockAsync` outright.
  useEffect(() => {
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
        setLanguage(prefs.language);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Re-checked whenever the route reaches /dashboard, not just once at
  // mount: `connect()` is a no-op unless the client is idle/closed/unpaired
  // (rpc-client.ts rule 8), so calling it again here is always safe, and it
  // is what activates the connection right after /pair saves a fresh
  // pairing and navigates here — without requiring an app restart.
  useEffect(() => {
    if (pathname !== "/dashboard") return;
    void connectFromStoredPairing();
  }, [pathname, connectFromStoredPairing]);

  // `{ client, connectionStore }` is otherwise a
  // fresh object every render, re-rendering every RpcContext consumer
  // (Dashboard, Settings) even when neither value actually changed —
  // both are already stable across renders (refs), so memoise on them.
  const rpcContextValue = useMemo(() => ({ client, connectionStore }), [client, connectionStore]);

  if (language === null || !fontsLoaded) {
    return null;
  }

  return (
    <LanguageContext.Provider value={language}>
      <RpcContext.Provider value={rpcContextValue}>
        <Providers>
          <SafeAreaProvider>
            <ConnectionBanner
              store={connectionStore}
              onRetry={() => {
                void connectFromStoredPairing();
              }}
              onPairAgain={handlePairAgain}
            />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen
                name="session/[id]"
                options={{
                  headerShown: true,
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
                  headerShown: true,
                  headerTitle: t(language, "changes.title"),
                  headerStyle: { backgroundColor: theme.colors.background },
                  headerTintColor: theme.colors.text,
                }}
              />
              <Stack.Screen
                name="history"
                options={{
                  headerShown: true,
                  headerTitle: t(language, "history.title"),
                  headerStyle: { backgroundColor: theme.colors.background },
                  headerTintColor: theme.colors.text,
                }}
              />
              <Stack.Screen
                name="transcript/[id]"
                options={{
                  headerShown: true,
                  title: t(language, "history.transcript"),
                  headerStyle: { backgroundColor: theme.colors.background },
                  headerTintColor: theme.colors.text,
                }}
              />
              <Stack.Screen
                name="sidecars/[project]"
                options={{
                  headerShown: true,
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
                  headerShown: true,
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
                  headerShown: true,
                  // The screen's own `<Stack.Screen options={{ title }} />`
                  // sets the pane key once mounted (docker/[project].tsx's
                  // same convention) — this is only the default shown first.
                  title: t(language, "workspace.terminal"),
                  headerStyle: { backgroundColor: theme.colors.background },
                  headerTintColor: theme.colors.text,
                }}
              />
            </Stack>
          </SafeAreaProvider>
        </Providers>
      </RpcContext.Provider>
    </LanguageContext.Provider>
  );
}
