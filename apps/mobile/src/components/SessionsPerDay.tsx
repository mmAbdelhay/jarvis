import { StyleSheet, Text, View } from "react-native";
import { t, type Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** How many days the tile shows: two weeks reads as a rhythm at phone width. */
export const SESSIONS_DAYS = 14;

/**
 * Sessions started per day over the last two weeks, as plain-view bars
 * scaled to the busiest day (the app carries no SVG library). Nothing is
 * drawn until the laptop has reported a history.
 */
export function SessionsPerDay(props: { language: Language; counts: number[] }) {
  const days = props.counts.slice(-SESSIONS_DAYS);
  if (days.length === 0) return null;
  const peak = Math.max(1, ...days);
  const total = days.reduce((sum, count) => sum + count, 0);
  const label = t(props.language, "home.sessionsPerDay");
  return (
    <View style={styles.card} accessibilityLabel={label}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.caption}>
          {t(props.language, "home.sessionsDays", { days: days.length })}
        </Text>
      </View>
      <Text style={styles.value}>{t(props.language, "home.sessionsTotal", { count: total })}</Text>
      <View
        style={styles.chart}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {days.map((count, index) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional days.
            key={index}
            style={[
              styles.bar,
              { height: `${Math.max(4, (count / peak) * 100)}%` },
              index < days.length - 1 && styles.barPast,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 6,
    padding: 12,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  title: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.bold,
    fontSize: 13,
    letterSpacing: 0.6,
  },
  caption: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 11 },
  value: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 20 },
  chart: { height: 44, flexDirection: "row", alignItems: "flex-end", gap: 3 },
  bar: { flex: 1, borderRadius: 2, backgroundColor: theme.colors.accent },
  barPast: { opacity: 0.45 },
});
