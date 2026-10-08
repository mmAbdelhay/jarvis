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

/** Wide Home: one account as a tile of the four-up row. */
export function CapacityTile(props: {
  language: Language;
  card: CapacityCard;
  trend: number[];
  now: number;
  width: number;
}) {
  const { card } = props;
  return (
    <View style={[styles.tile, { width: props.width }]}>
      <Text style={styles.tileName} numberOfLines={1}>
        {t(props.language, "home.capacityWindow", {
          name: card.id,
          window: t(props.language, WINDOW_KEYS[card.window]),
        })}
      </Text>
      <Text
        style={styles.tileValue}
        accessibilityLabel={t(props.language, "home.left", { percent: card.left })}
      >
        {card.left}%
      </Text>
      <Sparkline points={props.trend} color={theme.colors[capacityTone(card)]} height={34} />
      <Text style={styles.tileCaption}>{resetLabel(card, props.now, props.language)}</Text>
    </View>
  );
}

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
  tile: {
    gap: 6,
    padding: 14,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  tileName: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 12 },
  tileValue: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 26 },
  tileCaption: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 12 },
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
