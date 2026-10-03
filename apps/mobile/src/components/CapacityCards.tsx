import { StyleSheet, Text, View } from "react-native";
import { Sparkline } from "@/components/Sparkline";
import {
  type CapacityCard,
  type CapacityTrend,
  capacityTone,
  resetLabel,
} from "@/lib/home-capacity";
import { t, type Language, type MessageKey } from "@/lib/i18n";
import { theme } from "@/lib/theme";

const WINDOW_KEYS: Record<CapacityCard["window"], MessageKey> = {
  "5h": "home.window5h",
  month: "home.windowMonth",
  window: "home.windowOther",
};

/**
 * One card per account with a known window: what is left, a line trend of
 * the last day, and when it resets.
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
        <Text style={styles.lastDay}>{t(props.language, "home.lastDay")}</Text>
      </View>
      <View style={styles.grid}>
        {props.cards.map((card) => {
          const trend = props.trends.find((entry) => entry.id === card.id)?.points ?? [];
          return (
            <View key={card.id} style={styles.card}>
              <Text style={styles.name} numberOfLines={1}>
                {card.id} · {t(props.language, WINDOW_KEYS[card.window])}
              </Text>
              <Text
                style={styles.value}
                accessibilityLabel={t(props.language, "home.left", { percent: card.left })}
              >
                {card.left}%
              </Text>
              <Sparkline points={trend} color={theme.colors[capacityTone(card)]} />
              <Text style={styles.caption}>{resetLabel(card, props.now, props.language)}</Text>
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
  title: { ...theme.type.sectionLabelLarge, color: theme.colors.textMuted },
  lastDay: { ...theme.type.meta, color: theme.colors.textDim },
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
  value: { ...theme.type.cardValue, color: theme.colors.text },
  caption: { ...theme.type.micro, color: theme.colors.textDim },
});
