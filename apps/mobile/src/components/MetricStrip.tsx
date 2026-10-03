import type { SystemMetrics } from "@jarvis/core";
import { StyleSheet, Text, View } from "react-native";
import { formatPercent } from "@/lib/format";
import { metricPercents } from "@/lib/home-metrics";
import { meterTone } from "@/lib/home-wide";
import { type Language, type MessageKey, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

function Tile(props: { label: string; percent: number | undefined }) {
  const tone = props.percent === undefined ? "accent" : meterTone(props.percent);
  const fill = props.percent === undefined ? 0 : Math.min(100, Math.max(0, props.percent));
  return (
    <View style={styles.tile}>
      <Text style={styles.label} numberOfLines={1}>
        {props.label}
      </Text>
      <Text style={styles.value}>
        {props.percent === undefined ? "--%" : formatPercent(props.percent)}
      </Text>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${fill}%`, backgroundColor: theme.colors[tone] }]} />
      </View>
    </View>
  );
}

const TILES: readonly { key: "cpu" | "memory" | "disk"; label: MessageKey }[] = [
  { key: "cpu", label: "metric.cpu" },
  { key: "memory", label: "metric.memory" },
  { key: "disk", label: "metric.disk" },
];

/** Phone Home: the laptop's CPU, memory and disk as three compact tiles, the
 *  wide Laptop tile's meters (same tones), "--%" until the laptop reports. */
export function MetricStrip(props: { language: Language; metrics: SystemMetrics | undefined }) {
  const percents = metricPercents(props.metrics);
  return (
    <View style={styles.strip}>
      {TILES.map((tile) => (
        <Tile key={tile.key} label={t(props.language, tile.label)} percent={percents[tile.key]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row", gap: 8 },
  tile: {
    flex: 1,
    minWidth: 0,
    gap: 6,
    padding: 12,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  label: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 12 },
  value: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 17 },
  track: { height: 4, borderRadius: theme.radius.full, backgroundColor: theme.colors.ringTrack },
  fill: { height: 4, borderRadius: theme.radius.full },
});
