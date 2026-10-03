import { StyleSheet, Text, View } from "react-native";
import { type CapacityCard, type CapacityTrend, resetsIn } from "@/lib/home-capacity";
import { t, type Language, type MessageKey } from "@/lib/i18n";
import { theme } from "@/lib/theme";

const WINDOW_KEYS: Record<CapacityCard["window"], MessageKey> = {
  "5h": "home.window5h",
  month: "home.windowMonth",
  window: "home.windowOther",
};

/** Bar colour by how much is left: the same thresholds read at a glance as
 *  the desktop meter's. */
function tone(remaining: number): string {
  if (remaining <= 10) return theme.colors.danger;
  if (remaining <= 30) return theme.colors.warning;
  return theme.colors.accent;
}

/**
 * One card per account with a known window: what is left, a small bar trend
 * of the last day, and when it resets. Drawn with plain views — the app
 * carries no SVG library, and bars read as well as a line at this size.
 */
export function CapacityCards(props: {
  language: Language;
  cards: CapacityCard[];
  trends: CapacityTrend[];
  now: number;
}) {
  if (props.cards.length === 0) return null;
  return (
    <View style={styles.section} accessibilityLabel={t(props.language, "home.capacity")}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t(props.language, "home.capacity")}</Text>
        <Text style={styles.caption}>{t(props.language, "home.lastDay")}</Text>
      </View>
      <View style={styles.grid}>
        {props.cards.map((card) => {
          const trend = props.trends.find((entry) => entry.id === card.id)?.points ?? [];
          const until = resetsIn(card.resetsAt, props.now);
          const color = tone(card.left);
          return (
            <View key={card.id} style={styles.card}>
              <Text style={styles.name} numberOfLines={1}>
                {card.id} · {t(props.language, WINDOW_KEYS[card.window])}
              </Text>
              <Text style={styles.value}>
                {t(props.language, "home.left", { percent: card.left })}
              </Text>
              <View
                style={styles.trend}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                {trend.map((left, index) => (
                  <View
                    // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional samples.
                    key={index}
                    style={[
                      styles.bar,
                      { height: `${Math.max(8, left)}%`, backgroundColor: color },
                      index < trend.length - 1 && styles.barPast,
                    ]}
                  />
                ))}
              </View>
              <Text style={styles.caption}>
                {until === undefined
                  ? t(props.language, "home.resetPassed")
                  : t(props.language, "home.resetsIn", { time: until })}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  title: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.bold,
    fontSize: 13,
    letterSpacing: 0.6,
  },
  caption: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 11 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: {
    flexGrow: 1,
    flexBasis: 150,
    gap: 6,
    padding: 12,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  name: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 12 },
  value: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 20 },
  trend: { height: 28, flexDirection: "row", alignItems: "flex-end", gap: 3 },
  bar: { flex: 1, borderRadius: 2 },
  barPast: { opacity: 0.45 },
});
