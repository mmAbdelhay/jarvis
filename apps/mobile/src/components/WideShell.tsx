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
  const language = useLanguage();
  const insets = useSafeAreaInsets();
  const wide = layout.kind === "wide";
  return (
    // A row in the reading direction: the sidebar is at the start, so on
    // the right in Arabic. The tree is the same on a phone (no sidebar),
    // so crossing the breakpoint never remounts the screens underneath.
    <View style={[styles.root, wide && { direction: textDirection(language) }]}>
      {wide && (
        <Sidebar compact={layout.compact} topInset={insets.top} bottomInset={insets.bottom} />
      )}
      <View style={[styles.content, wide && { direction: "ltr" }]}>{props.children}</View>
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

function Sidebar(props: {
  compact: boolean;
  topInset: number;
  bottomInset: number;
}): React.JSX.Element {
  const language = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const client = useRpcClient();
  const connectionStore = useConnectionStore();
  // One shared store per client for every shell (tabs, Settings): cached
  // metrics show at once, and no extra list calls.
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
  const items = wideNavItems(language);
  const compact = props.compact;

  const navItem = (item: (typeof items)[number]) => {
    const on = item.key === active;
    const badge =
      item.key === "sessions" && model.running.count > 0 ? model.running.count : undefined;
    return (
      <Pressable
        key={item.key}
        style={[styles.navItem, compact && styles.navItemCompact, on && styles.navItemOn]}
        onPress={() => {
          if (!on) router.navigate(item.href);
        }}
        accessibilityRole="tab"
        accessibilityLabel={item.label}
        accessibilityState={{ selected: on }}
      >
        <Text style={[styles.glyph, on && styles.glyphOn]}>{item.glyph}</Text>
        {!compact && (
          <Text style={[styles.navText, on && styles.navTextOn]} numberOfLines={1}>
            {item.label}
          </Text>
        )}
        {badge !== undefined && (
          <Text style={[styles.badge, compact && styles.badgeCompact]}>{badge}</Text>
        )}
      </Pressable>
    );
  };

  return (
    <View
      style={[
        styles.sidebar,
        compact && styles.sidebarCompact,
        { paddingTop: props.topInset + 18, paddingBottom: props.bottomInset + 14 },
      ]}
    >
      <View style={[styles.brandRow, compact && styles.brandRowCompact]}>
        <View style={styles.brandMark}>
          <View style={styles.brandDot} />
        </View>
        {!compact && <Text style={styles.brand}>Jarvis</Text>}
      </View>
      <View style={styles.nav} accessibilityRole="tablist">
        {items.filter((item) => item.key !== "settings").map(navItem)}
      </View>
      <View style={styles.spacer} />
      <View
        style={[styles.status, compact && styles.statusCompact]}
        accessible
        accessibilityLabel={
          model.laptopName === undefined
            ? t(language, model.pill.key)
            : `${t(language, model.pill.key)} · ${model.laptopName}`
        }
      >
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: theme.colors[model.pill.tone] }]} />
          {!compact && (
            <Text style={styles.pillText} numberOfLines={1}>
              {model.laptopName ?? t(language, model.pill.key)}
            </Text>
          )}
        </View>
        {!compact && model.showMetrics && (
          <View style={styles.metrics}>
            <Text style={styles.metric}>CPU {model.readout.cpu}</Text>
            <Text style={styles.metric}>RAM {model.readout.ram}</Text>
            <Text style={styles.metric}>DISK {model.readout.disk}</Text>
            <Text style={styles.metric}>{model.readout.net}</Text>
          </View>
        )}
        {!compact && <Text style={styles.clock}>{clock}</Text>}
      </View>
      {items.filter((item) => item.key === "settings").map(navItem)}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", backgroundColor: theme.colors.background },
  content: { flex: 1, minWidth: 0 },
  sidebar: {
    width: 232,
    paddingHorizontal: 12,
    gap: 4,
    backgroundColor: theme.colors.surfaceDim,
    borderEndWidth: 1,
    borderEndColor: theme.colors.hairlineSoft,
  },
  sidebarCompact: { width: 68, paddingHorizontal: 10, alignItems: "center" },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingBottom: 18,
  },
  brandRowCompact: { paddingHorizontal: 0 },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  brandDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    borderWidth: 2.5,
    borderColor: theme.colors.primaryText,
  },
  brand: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 18 },
  nav: { gap: 2 },
  navItem: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  navItemCompact: { width: 46, justifyContent: "center", paddingHorizontal: 0 },
  navItemOn: { backgroundColor: theme.colors.selected },
  glyph: { width: 18, textAlign: "center", color: theme.colors.textMuted, fontSize: 16 },
  glyphOn: { color: theme.colors.text },
  navText: {
    flex: 1,
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 14,
  },
  navTextOn: { color: theme.colors.text, fontFamily: theme.font.bold },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    overflow: "hidden",
    textAlign: "center",
    color: theme.colors.accentText,
    backgroundColor: theme.colors.accentSoft,
    fontFamily: theme.font.bold,
    fontSize: 11,
  },
  badgeCompact: { position: "absolute", top: 2, end: 0, minWidth: 16, paddingHorizontal: 4 },
  spacer: { flex: 1 },
  status: {
    gap: 8,
    marginBottom: 6,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  statusCompact: { padding: 10, alignItems: "center" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: theme.radius.full },
  pillText: {
    flex: 1,
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 12,
  },
  metrics: { gap: 2, direction: "ltr" },
  metric: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.mono,
    fontSize: 11,
    writingDirection: "ltr",
  },
  clock: {
    color: theme.colors.textDim,
    fontFamily: theme.font.mono,
    fontSize: 11,
    writingDirection: "ltr",
  },
});
