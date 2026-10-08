// The wide layout's desktop-style shell: a sidebar (240 wide, text items,
// waiting badge, CAPACITY card, Settings at the bottom) or, in the Workspace
// section and below 900 wide, a 64 icon rail, beside the routed content.
// Logic lives in wide-shell-model.ts.
//
// The wrapper tree is the same on a phone and on a wide screen (only the
// sidebar comes and goes), so crossing the breakpoint never remounts the
// screens underneath.

import { usePathname, useRouter } from "expo-router";
import type React from "react";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";
import type { TopBarView } from "@/lib/top-bar-store";
import { topBarStoreFor } from "@/lib/top-bar-store";
import { useLayoutClass } from "@/lib/use-layout-class";
import { textDirection } from "@/lib/voice-screen";
import { SIDEBAR_FULL_WIDTH, SIDEBAR_RAIL_WIDTH } from "@/lib/wide-breakpoints";
import {
  activeNavKey,
  capacityRows,
  navBadge,
  sidebarCard,
  sidebarMode,
  type WideNavItem,
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

function Sidebar(props: {
  compact: boolean;
  topInset: number;
  bottomInset: number;
}): React.JSX.Element {
  const language = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const client = useRpcClient();
  // One shared store per client for every shell (tabs, Settings): cached
  // values show at once, and no extra list calls.
  const store = topBarStoreFor(client);
  const [view, setView] = useState<TopBarView>(store.get());

  useEffect(() => {
    setView(store.get());
    return store.subscribe(setView);
  }, [store]);

  const active = activeNavKey(pathname);
  const rail = sidebarMode({ compact: props.compact, section: active }) === "rail";
  const items = wideNavItems(language);
  const card = rail ? undefined : sidebarCard(active, view.capacity);

  const navItem = (item: WideNavItem) => {
    const on = item.key === active;
    const badge = navBadge(item.key, view.waitingCount);
    const settings = item.key === "settings";
    const label = badge === undefined ? item.label : `${item.label}, ${badge}`;
    return (
      <Pressable
        key={item.key}
        style={[styles.navItem, rail && styles.navItemRail, on && styles.navItemOn]}
        onPress={() => {
          if (!on) router.navigate(item.href);
        }}
        accessibilityRole="tab"
        accessibilityLabel={label}
        accessibilityState={{ selected: on }}
      >
        {rail ? (
          <Icon
            name={item.icon}
            size={20}
            strokeWidth={2}
            color={on ? theme.colors.text : theme.colors.textMuted}
          />
        ) : (
          <Text
            style={[styles.navText, settings && styles.navTextSettings, on && styles.navTextOn]}
            numberOfLines={1}
          >
            {item.label}
          </Text>
        )}
        {badge !== undefined &&
          (rail ? <View style={styles.badgeDot} /> : <Text style={styles.badge}>{badge}</Text>)}
      </Pressable>
    );
  };

  return (
    <View
      style={[
        styles.sidebar,
        rail && styles.sidebarRail,
        { paddingTop: props.topInset + 20, paddingBottom: props.bottomInset + 20 },
      ]}
    >
      <View style={[styles.brandRow, rail && styles.brandRowRail]}>
        <View style={styles.brandMark}>
          <Icon name="brand" size={16} strokeWidth={2.4} color={theme.colors.primaryText} />
        </View>
        {!rail && <Text style={styles.brand}>Jarvis</Text>}
      </View>
      <View style={[styles.nav, rail && styles.navRail]} accessibilityRole="tablist">
        {items.filter((item) => item.key !== "settings").map(navItem)}
      </View>
      <View style={styles.spacer} />
      {card === "capacity" && (
        <View style={styles.card}>
          <Text style={styles.kicker}>{t(language, "nav.capacity")}</Text>
          {capacityRows(view.capacity, language).map((row) => (
            <View key={row.id} style={styles.capacityRow}>
              <View style={styles.capacityHead}>
                <Text style={styles.capacityName} numberOfLines={1}>
                  {row.label}
                </Text>
                <Text style={styles.capacityPercent}>{row.percent}%</Text>
              </View>
              <View style={styles.bar}>
                <View
                  style={[
                    styles.barFill,
                    { width: `${row.percent}%`, backgroundColor: theme.colors[row.tone] },
                  ]}
                />
              </View>
            </View>
          ))}
        </View>
      )}
      {items.filter((item) => item.key === "settings").map(navItem)}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", backgroundColor: theme.colors.background },
  content: { flex: 1, minWidth: 0 },
  sidebar: {
    width: SIDEBAR_FULL_WIDTH,
    paddingHorizontal: 14,
    gap: 4,
    backgroundColor: theme.colors.surfaceDim,
    borderEndWidth: 1,
    borderEndColor: theme.colors.hairlineSoft,
  },
  sidebarRail: { width: SIDEBAR_RAIL_WIDTH, paddingHorizontal: 10, gap: 6, alignItems: "center" },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingBottom: 18,
  },
  brandRowRail: { paddingHorizontal: 0, paddingBottom: 14 },
  brandMark: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 18 },
  nav: { gap: 4 },
  navRail: { gap: 6 },
  navItem: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  navItemRail: { width: 44, height: 44, justifyContent: "center", paddingHorizontal: 0 },
  navItemOn: { backgroundColor: theme.colors.selected },
  navText: {
    flex: 1,
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 14,
  },
  navTextSettings: { color: theme.colors.textMuted },
  navTextOn: { color: theme.colors.text, fontFamily: theme.font.bold },
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: "hidden",
    textAlign: "center",
    color: theme.colors.warning,
    backgroundColor: theme.colors.warningSurface,
    fontFamily: theme.font.bold,
    fontSize: 11,
  },
  badgeDot: {
    position: "absolute",
    top: 6,
    end: 6,
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: theme.colors.warning,
  },
  spacer: { flex: 1 },
  card: {
    gap: 8,
    marginBottom: 6,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  kicker: {
    color: theme.colors.textDim,
    fontFamily: theme.font.bold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  capacityRow: { gap: 8 },
  capacityHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  capacityName: {
    flex: 1,
    color: theme.colors.textSecondary,
    fontFamily: theme.font.body,
    fontSize: 12,
  },
  capacityPercent: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 12 },
  bar: {
    height: 6,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: theme.colors.selected,
  },
  barFill: { height: 6, borderRadius: 999 },
});
