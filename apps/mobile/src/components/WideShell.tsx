// The wide layout's desktop-style shell (2026-09-28 spec §2): a 48px top
// bar — brand, nav, metrics readout, "N running" pill, connection pill,
// clock — over the routed content. Logic lives in wide-shell-model.ts.
//
// The wrapper tree is the same on a phone and on a wide screen (only the
// top bar comes and goes), so crossing the breakpoint never remounts the
// screens underneath.

import { usePathname, useRouter } from "expo-router";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectionView } from "@/lib/connection-store";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadPairing } from "@/lib/pairing-record";
import { useConnectionStore, useRpcClient } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import { theme } from "@/lib/theme";
import type { TopBarView } from "@/lib/top-bar-store";
import { topBarStoreFor } from "@/lib/top-bar-store";
import { useLayoutClass } from "@/lib/use-layout-class";
import { textDirection } from "@/lib/voice-screen";
import {
  activeNavKey,
  clockText,
  shellLaptopName,
  topBarModel,
  wideNavItems,
} from "@/lib/wide-shell-model";

export function WideShell(props: { children: React.ReactNode }): React.JSX.Element {
  const layout = useLayoutClass();
  const insets = useSafeAreaInsets();
  const wide = layout.kind === "wide";
  // The top bar owns the top inset on a wide screen, so the screens below
  // it must not pad for it a second time.
  const contentInsets = useMemo(() => (wide ? { ...insets, top: 0 } : insets), [wide, insets]);
  return (
    <View style={styles.root}>
      {wide && <TopBar compact={layout.compact} topInset={insets.top} />}
      <SafeAreaInsetsContext.Provider value={contentInsets}>
        {props.children}
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

function useClock(): string {
  const [text, setText] = useState(() => clockText(new Date()));
  useEffect(() => {
    const timer = setInterval(() => setText(clockText(new Date())), 10_000);
    return () => clearInterval(timer);
  }, []);
  return text;
}

/** The paired laptop's name, from the same pairing record the phone's
 *  Dashboard header reads. A re-pair goes through /pair, which remounts the
 *  shell, so reading it once per mount is enough. Falls back to the
 *  certificate's machine label (see `shellLaptopName`). */
function useLaptopName(): string | undefined {
  const [name, setName] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadPairing(expoSecureStore).then((loaded) => {
      if (!cancelled) setName(shellLaptopName(loaded?.record));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return name;
}

function TopBar(props: { compact: boolean; topInset: number }): React.JSX.Element {
  const language = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const client = useRpcClient();
  const connectionStore = useConnectionStore();
  // One shared store per client for every top bar (tabs shell, Settings):
  // cached metrics show at once, and no extra list calls.
  const store = topBarStoreFor(client);
  const [view, setView] = useState<TopBarView>(store.get());
  const [connection, setConnection] = useState<ConnectionView>(connectionStore.get());
  const clock = useClock();
  const laptopName = useLaptopName();

  useEffect(() => {
    setView(store.get());
    return store.subscribe(setView);
  }, [store]);
  useEffect(() => {
    setConnection(connectionStore.get());
    return connectionStore.subscribe(setConnection);
  }, [connectionStore]);

  const model = topBarModel({
    metrics: view.metrics,
    runningCount: view.runningCount,
    connection,
    compact: props.compact,
    laptopName,
  });
  const active = activeNavKey(pathname);

  return (
    // `direction` mirrors the whole bar in Arabic on native and web alike.
    <View style={[styles.bar, { paddingTop: props.topInset, direction: textDirection(language) }]}>
      <Text style={styles.brand}>JARVIS</Text>
      <View style={styles.nav} accessibilityRole="tablist">
        {wideNavItems(language).map((item) => {
          const on = item.key === active;
          return (
            <Pressable
              key={item.key}
              style={[styles.navButton, on && styles.navButtonOn]}
              onPress={() => {
                if (!on) router.navigate(item.href);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.navText, on && styles.navTextOn]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.status}>
        {model.showMetrics && (
          <View style={styles.metrics}>
            <Text style={styles.unit}>CPU</Text>
            <Text style={styles.metricValue}>{model.readout.cpu}</Text>
            <Text style={styles.sep}>·</Text>
            <Text style={styles.unit}>RAM</Text>
            <Text style={styles.metricValue}>{model.readout.ram}</Text>
            <Text style={styles.sep}>·</Text>
            <Text style={styles.unit}>DISK</Text>
            <Text style={styles.metricValue}>{model.readout.disk}</Text>
            <Text style={styles.sep}>·</Text>
            <Text style={styles.metricValue}>{model.readout.net}</Text>
          </View>
        )}
        <View
          style={[styles.pill, styles.connectionPill]}
          accessible
          accessibilityLabel={
            model.laptopName === undefined
              ? t(language, model.pill.key)
              : `${t(language, model.pill.key)} · ${model.laptopName}`
          }
        >
          <View style={[styles.dot, { backgroundColor: theme.colors[model.pill.tone] }]} />
          {model.showPillLabel && (
            <Text style={styles.pillText} numberOfLines={1}>
              {t(language, model.pill.key)}
            </Text>
          )}
          {model.laptopName !== undefined && (
            <Text
              style={[styles.laptopName, { maxWidth: model.laptopNameMaxWidth }]}
              numberOfLines={1}
            >
              {model.laptopName}
            </Text>
          )}
        </View>
        <View style={styles.divider} />
        <Pressable
          style={styles.pill}
          onPress={() => router.navigate("/sessions")}
          accessibilityRole="button"
        >
          <Text style={[styles.running, model.running.idle && styles.runningIdle]}>
            {t(language, "shell.running", { count: model.running.count })}
          </Text>
        </Pressable>
        <View style={styles.divider} />
        <Text style={styles.clock}>{clock}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  bar: {
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 48,
    paddingStart: 20,
    paddingEnd: 16,
    backgroundColor: theme.colors.ground,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairlineSoft,
  },
  brand: {
    alignSelf: "center",
    marginEnd: 22,
    color: theme.colors.text,
    fontFamily: theme.font.bold,
    fontSize: 14,
    letterSpacing: 3.4,
  },
  nav: { flexDirection: "row", alignItems: "stretch", gap: 2, flexShrink: 0 },
  navButton: {
    justifyContent: "center",
    paddingHorizontal: 12,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  navButtonOn: { borderBottomColor: theme.colors.accent },
  navText: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 13 },
  navTextOn: { color: theme.colors.text },
  status: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 14,
    minWidth: 0,
    overflow: "hidden",
  },
  metrics: { flexDirection: "row", alignItems: "center", gap: 6, direction: "ltr" },
  unit: { color: theme.colors.textMuted, fontFamily: theme.font.mono, fontSize: 10 },
  metricValue: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.mono,
    fontSize: 11,
    writingDirection: "ltr",
  },
  sep: { color: theme.colors.border, fontFamily: theme.font.mono, fontSize: 11 },
  pill: { flexDirection: "row", alignItems: "center", gap: 7 },
  connectionPill: { flexShrink: 1, minWidth: 0 },
  dot: { width: 7, height: 7, borderRadius: theme.radius.full },
  pillText: { color: theme.colors.textSecondary, fontFamily: theme.font.body, fontSize: 12 },
  laptopName: {
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontFamily: theme.font.body,
    fontSize: 12,
  },
  // Not mono: the label is Arabic in ar, which the mono face lacks.
  running: { color: theme.colors.accentText, fontFamily: theme.font.medium, fontSize: 12 },
  runningIdle: { color: theme.colors.textMuted },
  divider: { width: 1, height: 14, backgroundColor: theme.colors.border },
  clock: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.mono,
    fontSize: 11,
    writingDirection: "ltr",
  },
});
