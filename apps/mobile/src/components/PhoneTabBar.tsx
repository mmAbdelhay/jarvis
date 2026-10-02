import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t, type Language, type MessageKey } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** The parts of the navigator's tab-bar props this bar uses. */
export type TabBarInput = {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: { navigate(name: string): void };
};

type Slot =
  | { kind: "tab"; route: string; label: MessageKey; glyph: string }
  | { kind: "talk"; route: string }
  | { kind: "link"; label: MessageKey; glyph: string; onPress(): void };

/**
 * The phone's bottom bar: Home, Sessions, a raised Talk button in the
 * middle (the Voice tab), Workspace, and Changes — which is a screen of its
 * own above the tabs, so it is a link rather than a tab.
 */
export function PhoneTabBar(props: TabBarInput & { language: Language; onChanges(): void }) {
  const insets = useSafeAreaInsets();
  const current = props.state.routes[props.state.index]?.name;
  const slots: Slot[] = [
    { kind: "tab", route: "dashboard", label: "nav.dashboard", glyph: "⌂" },
    { kind: "tab", route: "sessions", label: "nav.sessions", glyph: "≡" },
    { kind: "talk", route: "voice" },
    { kind: "tab", route: "workspace", label: "nav.workspace", glyph: "⊞" },
    { kind: "link", label: "nav.changes", glyph: "±", onPress: props.onChanges },
  ];
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {slots.map((slot) => {
        if (slot.kind === "talk") {
          const active = current === slot.route;
          return (
            <View key="talk" style={styles.slot}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t(props.language, "nav.talk")}
                accessibilityState={{ selected: active }}
                onPress={() => props.navigation.navigate(slot.route)}
                style={[styles.talk, active && styles.talkActive]}
              >
                <View style={styles.micHead} />
                <View style={styles.micStem} />
              </TouchableOpacity>
            </View>
          );
        }
        const active = slot.kind === "tab" && current === slot.route;
        const color = active ? theme.colors.accent : theme.colors.textDim;
        return (
          <TouchableOpacity
            key={slot.label}
            accessibilityRole={slot.kind === "tab" ? "tab" : "link"}
            accessibilityState={{ selected: active }}
            onPress={() =>
              slot.kind === "tab" ? props.navigation.navigate(slot.route) : slot.onPress()
            }
            style={styles.slot}
          >
            <Text style={[styles.glyph, { color }]}>{slot.glyph}</Text>
            <Text style={[styles.label, { color }, active && styles.labelActive]} numberOfLines={1}>
              {t(props.language, slot.label)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 8,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.surfaceDim,
  },
  slot: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 2 },
  glyph: { fontFamily: theme.font.semibold, fontSize: 20, lineHeight: 24 },
  label: { fontFamily: theme.font.semibold, fontSize: 11 },
  labelActive: { fontFamily: theme.font.bold },
  talk: {
    width: 58,
    height: 58,
    marginTop: -24,
    borderRadius: 999,
    borderWidth: 4,
    borderColor: theme.colors.ground,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  talkActive: { borderColor: theme.colors.accentSoft },
  // A microphone from two views: a rounded capsule and its stand.
  micHead: { width: 10, height: 16, borderRadius: 5, backgroundColor: theme.colors.primaryText },
  micStem: { width: 2, height: 5, borderRadius: 1, backgroundColor: theme.colors.primaryText },
});
