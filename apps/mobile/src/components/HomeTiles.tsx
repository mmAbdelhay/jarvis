import { StyleSheet, View } from "react-native";
import type { SystemMetrics } from "@jarvis/core";
import { CapacityTile } from "@/components/CapacityCards";
import { LaptopTile } from "@/components/LaptopTile";
import { SessionsTile } from "@/components/SessionsTile";
import type { CapacityCard, CapacityTrend } from "@/lib/home-capacity";
import { tileWidth } from "@/lib/home-wide";
import type { Language } from "@/lib/i18n";
import { homeTileColumns } from "@/lib/wide-breakpoints";

const GAP = 14;

/**
 * Wide Home's tiles row: one tile per capacity account, then Laptop and
 * Sessions · 14 days (those two always show). Four per row at content >= 1000,
 * otherwise two.
 */
export function HomeTiles(props: {
  language: Language;
  /** The routed content's width (window minus sidebar). */
  content: number;
  /** The row's own width after the page padding and the 1180 cap. */
  inner: number;
  cards: CapacityCard[];
  trends: CapacityTrend[];
  metrics: SystemMetrics | undefined;
  sessionsPerDay: number[];
  now: number;
}) {
  const width = tileWidth(props.inner, homeTileColumns(props.content), GAP);
  return (
    <View style={styles.row}>
      {props.cards.map((card) => (
        <CapacityTile
          key={card.id}
          language={props.language}
          card={card}
          trend={props.trends.find((entry) => entry.id === card.id)?.points ?? []}
          now={props.now}
          width={width}
        />
      ))}
      <LaptopTile language={props.language} metrics={props.metrics} width={width} />
      <SessionsTile language={props.language} counts={props.sessionsPerDay} width={width} />
    </View>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: "row", flexWrap: "wrap", gap: GAP } });
