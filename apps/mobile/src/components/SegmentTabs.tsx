import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { theme } from "@/lib/theme";

export type SegmentTab = {
  key: string;
  label: string;
  /** A short count beside the label ("5", "3/7"); omitted when none. */
  badge?: string;
  /** Green for a count of new work (Changes), grey for progress (Plan). */
  badgeTone?: "success" | "muted";
  selected: boolean;
  onPress(): void;
};

/**
 * A row of equal segments, the selected one raised: the session screen's
 * Live / Changes / Plan / Transcript switch. A segment that opens another
 * screen is still a segment here — the row is how a session's views are
 * reached, whichever of them happen to be separate screens.
 */
export function SegmentTabs(props: { tabs: SegmentTab[]; label: string; compact?: boolean }) {
  return (
    <View style={styles.row} accessibilityRole="tablist" accessibilityLabel={props.label}>
      {props.tabs.map((tab) => (
        <TouchableOpacity
          key={tab.key}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab.selected }}
          onPress={tab.onPress}
          style={[styles.tab, props.compact && styles.tabCompact, tab.selected && styles.tabOn]}
        >
          <Text style={[styles.label, tab.selected && styles.labelOn]} numberOfLines={1}>
            {tab.label}
            {tab.badge !== undefined && (
              <Text style={[styles.badge, tab.badgeTone === "muted" && styles.badgeMuted]}>
                {" "}
                {tab.badge}
              </Text>
            )}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: theme.radius.control,
    backgroundColor: theme.colors.surface,
  },
  tab: {
    flex: 1,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    borderRadius: 9,
  },
  tabCompact: { minHeight: 34 },
  tabOn: { backgroundColor: theme.colors.selected },
  label: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 13 },
  labelOn: { color: theme.colors.text, fontFamily: theme.font.bold },
  badge: { color: theme.colors.success, fontFamily: theme.font.semibold, fontSize: 11 },
  badgeMuted: { color: theme.colors.textMuted },
});
