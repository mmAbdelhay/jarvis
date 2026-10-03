import { StyleSheet, Text, View } from "react-native";
import { SESSIONS_DAYS, tileDays, todayCount } from "@/lib/home-wide";
import { t, type Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/**
 * Wide Home: sessions started per day over 14 days as bars scaled to the
 * busiest day, today in accent. Before the laptop reports a history it shows
 * empty days and "today: 0 sessions".
 */
export function SessionsTile(props: { language: Language; counts: number[]; width: number }) {
  const days = tileDays(props.counts, SESSIONS_DAYS);
  const peak = Math.max(1, ...days);
  return (
    <View style={[styles.tile, { width: props.width }]}>
      <Text style={styles.name}>{t(props.language, "home.sessions14")}</Text>
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
              index === days.length - 1 && styles.barToday,
            ]}
          />
        ))}
      </View>
      <Text style={styles.caption}>
        {t(props.language, "home.today", { count: todayCount(props.counts) })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    gap: 6,
    padding: 14,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  name: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 12 },
  chart: { height: 64, flexDirection: "row", alignItems: "flex-end", gap: 4 },
  bar: { flex: 1, borderRadius: 3, backgroundColor: theme.colors.accentBorder },
  barToday: { backgroundColor: theme.colors.accent },
  caption: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 12 },
});
