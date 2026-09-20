// One tile in the Dashboard's `dashboard.system` grid (Task 6, rule 5).
// Pure layout — no logic, no i18n lookups beyond the label/value strings it
// is handed, so it has nothing of its own to unit test.
import { StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";

export function MetricTile({
  label,
  value,
  percent,
  tone = "accent",
}: {
  label: string;
  value: string;
  percent?: number;
  tone?: "accent" | "warning" | "danger";
}) {
  return (
    <View style={styles.tile}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            {
              width: `${Math.max(0, Math.min(100, percent ?? 0))}%`,
              backgroundColor: theme.colors[tone],
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: 12,
    gap: 8,
  },
  label: {
    color: theme.colors.textDim,
    fontFamily: theme.font.semibold,
    fontSize: 11,
    letterSpacing: 0.8,
  },
  value: {
    color: theme.colors.text,
    fontFamily: theme.font.monoSemibold,
    fontSize: 22,
  },
  track: {
    height: 3,
    borderRadius: 999,
    backgroundColor: theme.colors.hairline,
    overflow: "hidden",
  },
  fill: { height: 3, borderRadius: 999 },
});
