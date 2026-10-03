import type { SystemMetrics } from "@jarvis/core";
import { StyleSheet, Text, View } from "react-native";
import { formatPercent } from "@/lib/format";
import { meterTone } from "@/lib/home-wide";
import { t, type Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";

function Meter(props: { label: string; percent: number | undefined }) {
  const tone = props.percent === undefined ? "accent" : meterTone(props.percent);
  const fill = props.percent === undefined ? 0 : Math.min(100, Math.max(0, props.percent));
  return (
    <View style={styles.meter}>
      <View style={styles.meterRow}>
        <Text style={styles.meterLabel}>{props.label}</Text>
        <Text style={styles.meterValue}>
          {props.percent === undefined ? "--%" : formatPercent(props.percent)}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${fill}%`, backgroundColor: theme.colors[tone] }]} />
      </View>
    </View>
  );
}

/** Wide Home: the laptop's CPU and memory (no disk), "--%" until known. */
export function LaptopTile(props: {
  language: Language;
  metrics: SystemMetrics | undefined;
  width: number;
}) {
  const { metrics } = props;
  const memory =
    metrics !== undefined && metrics.memoryTotalBytes > 0
      ? (metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100
      : undefined;
  return (
    <View style={[styles.tile, { width: props.width }]}>
      <Text style={styles.name}>{t(props.language, "home.laptop")}</Text>
      <Meter label={t(props.language, "metric.cpu")} percent={metrics?.cpuPercent} />
      <Meter label={t(props.language, "metric.memory")} percent={memory} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    gap: 10,
    padding: 14,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  name: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 12 },
  meter: { gap: 10 },
  meterRow: { flexDirection: "row", justifyContent: "space-between" },
  meterLabel: { color: theme.colors.textSecondary, fontFamily: theme.font.body, fontSize: 13 },
  meterValue: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 13 },
  track: { height: 6, borderRadius: theme.radius.full, backgroundColor: theme.colors.ringTrack },
  fill: { height: 6, borderRadius: theme.radius.full },
});
