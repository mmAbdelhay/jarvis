// The WebView screen (task-6-brief.md rule 5): loads the proxied sidecar
// URL `open()` handed back, and nothing else — the URL is route state only
// (never persisted, per global-constraints.md's token/secret rule) and a
// fresh handle is minted the next time the sidecars screen calls `open()`
// (ruling 4), so "open again" below never needs to remember this URL past
// this screen's own lifetime.
//
// Trust (task-6 review, fix round 1, Important 1 — controller ruling):
// `react-native-webview` 13.16.1's `createOnShouldStartLoadWithRequest`
// checks its own `originWhitelist` *first* and, on a miss, hands the URL to
// `Linking.canOpenURL`/`Linking.openURL` — `onShouldStartLoadWithRequest` is
// never even called for a URL the whitelist already rejected. A narrow
// `originWhitelist={[sidecarOrigin]}` would therefore open any off-origin
// link (any external URL inside code-server's UI, DbGate's help links,
// Headlamp's docs) in the system browser rather than refusing it — the
// opposite of "just refused" this screen wants. The fix: `originWhitelist`
// is wide open (`["*"]`, so nothing ever misses it and the Linking fallback
// is never reached) and `onShouldStartLoadWithRequest` — backed by the
// pure, unit-tested `isOnSidecarOrigin` (sidecar-url.ts) — is the *sole*
// gate: it allows same-origin navigation and `about:blank`, and silently
// refuses everything else (no `Linking.openURL` call of this screen's own
// either — the brief's "emergency-edit surface" stays closed). The origin
// itself is re-derived from the pairing record, never trusted from the
// route param, and the route's own URL is additionally checked against the
// full `/s/<handle>/…` shape via `isAllowedSidecarUrl` before the `WebView`
// ever mounts (Minor 1) — belt and braces against a forged/stale push.
// `react-native-webview` has no `onReceivedSslError`-style bypass prop at
// all, so there is nothing to avoid setting for that; the same goes for
// `mixedContentMode`, left unset so an https page can never pull in http
// content.
//
// Slim-header fix: this screen now draws its own single-row header (back +
// title + zoom controls + desktop-site toggle, all in one 44px row) rather
// than configuring the native stack header — `_layout.tsx`'s own
// `Stack.Screen` entry for "sidecar-view" is `headerShown: false`. The
// native header used to grow to two lines once both a long title and the
// desktop-site pill were present; a fixed-height custom row can't do that.
//
// Landscape fix: `app.config.ts`'s `orientation` is "default" now (a
// native config change, in effect only after a new EAS build) so the OS
// itself no longer forces portrait; `app/_layout.tsx` locks PORTRAIT_UP on
// mount for every other screen, and this screen unlocks on focus /
// re-locks on blur or unmount below, via `expo-screen-orientation`.
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { WebView } from "react-native-webview";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadPairing } from "@/lib/pairing-record";
import { loadPrefs, savePrefs, type SidecarKind } from "@/lib/prefs";
import { filePrefsStore } from "@/lib/prefs-file";
import { expoSecureStore } from "@/lib/secure-store";
import {
  SIDECAR_ZOOM_MAX,
  SIDECAR_ZOOM_MIN,
  type ZoomDirection,
  nextZoom,
  sidecarDesktopWebViewProps,
  sidecarZoomDefault,
  zoomScript,
} from "@/lib/sidecar-webview-config";
import { isAllowedSidecarUrl, isOnSidecarOrigin, sidecarOrigin } from "@/lib/sidecar-url";
import { theme } from "@/lib/theme";

type SidecarEndpoint = { name: string; port: number };

function isSidecarKind(value: string | undefined): value is SidecarKind {
  return value === "editor" || value === "database" || value === "cluster";
}

// M8 (final review): mirrors sidecars/[project].tsx's own `rowLabel`, but
// resolves route-param strings of unknown provenance (a deep link sets
// them, same as the old `title` param it replaces) rather than a row taken
// straight from the store — an unrecognised `kind` falls back to the
// generic title instead of ever showing raw text.
function resolveTitle(
  language: Language,
  kind: string | undefined,
  label: string | undefined,
): string {
  if (kind === "database") return t(language, "sidecars.database");
  if (kind === "editor" && (label ?? "") === "") return t(language, "sidecars.noRoots");
  if (kind === "editor" || kind === "cluster") return label ?? t(language, "sidecars.title");
  return t(language, "sidecars.title");
}

export default function SidecarViewScreen() {
  const language = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { url, kind, label } = useLocalSearchParams<{
    url: string;
    kind?: string;
    label?: string;
  }>();
  const uri = typeof url === "string" ? url : "";
  const kindParam = typeof kind === "string" ? kind : undefined;
  const labelParam = typeof label === "string" ? label : undefined;

  const [endpoint, setEndpoint] = useState<SidecarEndpoint | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  // "Desktop site" toggle (default on, prefs.ts's own fallback): starts
  // `true` so the very first render already requests DbGate/code-server's
  // real desktop UI instead of their mobile fallback — the loaded prefs
  // value only ever *corrects* that for the minority who turned it off,
  // it never needs to flip most sessions on after a flash of "off".
  const [desktopSite, setDesktopSite] = useState(true);
  // Per-kind zoom (prefs.ts's `sidecarZoom`): starts at the kind's own
  // default (60% for DbGate, which refuses to run below ~600 px of layout
  // width; 100% otherwise), the same "correct after load, never flash the
  // wrong state first" pattern as `desktopSite` above.
  const [zoom, setZoom] = useState(() => sidecarZoomDefault(kindParam));
  const webViewRef = useRef<WebView>(null);
  const localeTag = useMemo(() => Intl.DateTimeFormat().resolvedOptions().locale, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pairing = await loadPairing(expoSecureStore);
      if (cancelled) return;
      const record = pairing?.record;
      if (record?.name !== undefined) {
        setEndpoint({ name: record.name, port: record.port });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const prefs = await loadPrefs(filePrefsStore, localeTag);
      if (cancelled) return;
      setDesktopSite(prefs.sidecarDesktopSite);
      if (isSidecarKind(kindParam)) {
        setZoom(prefs.sidecarZoom[kindParam] ?? sidecarZoomDefault(kindParam));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localeTag, kindParam]);

  // Landscape fix: unlocks the moment this screen gains focus so the OS
  // can rotate to landscape for a desktop UI (code-server, DbGate,
  // Headlamp) that benefits from the width; re-locks to PORTRAIT_UP the
  // moment it loses focus *or* unmounts (`useFocusEffect`'s cleanup runs
  // for both — mirrors terminal/[paneKey].tsx's own focus-scoped
  // subscription pattern) so every other screen is back to the app's
  // normal portrait-only default. Wrapped in try/catch: the web target and
  // some simulators reject these calls outright.
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        try {
          await ScreenOrientation.unlockAsync();
        } catch {
          // Simulator/web: no native orientation lock to unlock. Nothing to do.
        }
      })();
      return () => {
        void (async () => {
          try {
            await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
          } catch {
            // Simulator/web: no native orientation lock to set. Nothing to do.
          }
        })();
      };
    }, []),
  );

  // settings-store.ts's own `setSpeakReplies` discipline: re-read the
  // stored `Prefs` right before writing (never a locally cached copy) so
  // this can't clobber a value another screen saved in between —
  // `savePrefs` always writes every key. Best-effort: a failed write
  // leaves the on-screen toggle (bound to `desktopSite` local state, set
  // first) showing the user's choice regardless of whether it persisted.
  const toggleDesktopSite = useCallback(() => {
    setDesktopSite((previous) => {
      const next = !previous;
      void (async () => {
        try {
          const current = await loadPrefs(filePrefsStore, localeTag);
          await savePrefs(filePrefsStore, { ...current, sidecarDesktopSite: next });
        } catch {
          // Best-effort persistence only — see comment above.
        }
      })();
      return next;
    });
  }, [localeTag]);

  // Zoom fix: applies the new level to the live page immediately (the
  // brief's own instruction — `injectJavaScript`, not waiting for the next
  // load) and, only when this route's `kind` is one of the three persisted
  // ones, best-effort saves it under that kind alone — the same
  // read-then-merge-then-write discipline as `toggleDesktopSite` above, so
  // a concurrent write from Settings (or another sidecar kind's own zoom
  // change, were two ever open) can't be clobbered.
  const applyZoom = useCallback(
    (direction: ZoomDirection) => {
      setZoom((previous) => {
        const next = nextZoom(previous, direction);
        webViewRef.current?.injectJavaScript(zoomScript(next));
        if (isSidecarKind(kindParam)) {
          void (async () => {
            try {
              const current = await loadPrefs(filePrefsStore, localeTag);
              await savePrefs(filePrefsStore, {
                ...current,
                sidecarZoom: { ...current.sidecarZoom, [kindParam]: next },
              });
            } catch {
              // Best-effort persistence only — see toggleDesktopSite above.
            }
          })();
        }
        return next;
      });
    },
    [kindParam, localeTag],
  );

  // Re-applies the current zoom on every load end (the brief's own note:
  // the page may re-render and drop the style) — this is also what applies
  // it on the very first load, since nothing sets it via a static
  // `injectedJavaScript` prop.
  const handleLoadEnd = useCallback(() => {
    webViewRef.current?.injectJavaScript(zoomScript(zoom));
  }, [zoom]);

  // M1: the route's own URL must still be a genuine `/s/<handle>/…`
  // sidecar URL on this pairing's endpoint, not merely same-origin — a
  // forged or stale push must not reach the WebView at all.
  const validRouteUrl =
    endpoint !== undefined && uri !== "" && isAllowedSidecarUrl(uri, endpoint.name, endpoint.port);

  // M8: the header title is resolved here, not read verbatim from a route
  // param — and only once the route's URL has passed the same M1 check
  // above; an unresolvable route (still loading, or a forged/stale push)
  // gets the generic title instead.
  const headerTitle = validRouteUrl
    ? resolveTitle(language, kindParam, labelParam)
    : t(language, "sidecars.title");

  let content: React.JSX.Element;
  if (failed) {
    content = (
      <View style={styles.center}>
        <Text style={styles.errorText}>{t(language, "sidecars.loadFailed")}</Text>
        <TouchableOpacity style={styles.button} onPress={() => router.back()}>
          <Text style={styles.buttonText}>{t(language, "sidecars.openAgain")}</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (endpoint === undefined || !validRouteUrl) {
    content = <View style={styles.center} />;
  } else {
    const origin = sidecarOrigin(endpoint.name, endpoint.port);
    content = (
      <WebView
        ref={webViewRef}
        source={{ uri }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        allowsBackForwardNavigationGestures
        setSupportMultipleWindows={false}
        {...sidecarDesktopWebViewProps(desktopSite, Platform.OS, zoom)}
        onLoadEnd={handleLoadEnd}
        onShouldStartLoadWithRequest={(request: ShouldStartLoadRequest) =>
          isOnSidecarOrigin(request.url, origin)
        }
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
      />
    );
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.headerSafeArea, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel={t(language, "common.back")}
          >
            <Text style={styles.iconButtonText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {headerTitle}
          </Text>
          {validRouteUrl ? (
            <View style={styles.zoomRow}>
              <TouchableOpacity
                style={styles.zoomButton}
                onPress={() => applyZoom("out")}
                disabled={zoom <= SIDECAR_ZOOM_MIN}
                accessibilityRole="button"
                accessibilityLabel={t(language, "sidecars.zoomOut")}
              >
                <Text style={styles.zoomButtonText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.zoomLabel}>{zoom}%</Text>
              <TouchableOpacity
                style={styles.zoomButton}
                onPress={() => applyZoom("in")}
                disabled={zoom >= SIDECAR_ZOOM_MAX}
                accessibilityRole="button"
                accessibilityLabel={t(language, "sidecars.zoomIn")}
              >
                <Text style={styles.zoomButtonText}>+</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {validRouteUrl ? (
            <TouchableOpacity
              style={[styles.desktopToggle, desktopSite && styles.desktopToggleActive]}
              onPress={toggleDesktopSite}
              accessibilityRole="switch"
              accessibilityState={{ checked: desktopSite }}
              accessibilityLabel={t(language, "sidecars.desktopSite")}
            >
              <Text
                style={[styles.desktopToggleGlyph, desktopSite && styles.desktopToggleGlyphActive]}
              >
                ▢
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
      <View style={styles.content}>{content}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  headerSafeArea: {
    backgroundColor: theme.colors.background,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairline,
  },
  // Slim-header fix: a fixed 44px row — back, title, zoom controls, the
  // desktop-site toggle, all in one line, never wrapping to a second.
  header: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  content: {
    flex: 1,
  },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonText: {
    color: theme.colors.text,
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.medium,
  },
  title: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: theme.font.weight.semibold,
  },
  zoomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
  },
  zoomButton: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomButtonText: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.semibold,
  },
  zoomLabel: {
    minWidth: 38,
    textAlign: "center",
    color: theme.colors.textMuted,
    fontFamily: theme.font.mono,
    fontSize: theme.font.size.sm,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: theme.font.size.md,
    textAlign: "center",
  },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  buttonText: {
    color: theme.colors.primaryText,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
  desktopToggle: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  desktopToggleActive: {
    backgroundColor: theme.colors.accentSoft,
    borderColor: theme.colors.accent,
  },
  desktopToggleGlyph: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.md,
  },
  desktopToggleGlyphActive: {
    color: theme.colors.accentText,
  },
});
