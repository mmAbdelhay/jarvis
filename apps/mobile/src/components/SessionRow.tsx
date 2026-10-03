// One row of a sessions list: the Sessions tab and the dashboard's list both
// render through it. Active rows are filled cards, a row waiting for the
// user has an amber border and may say what it asks, and a finished row is
// an outline with a hollow dot and an optional trailing action (Resume).
// Everything shown is already-formatted text from the caller: `title` is
// server text, never routed through i18n.
import type { ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { RowVariant } from "@/lib/sessions-row";
import { theme } from "@/lib/theme";

export type SessionRowProps = {
  title: string;
  /** "api · claude-main", already composed. */
  subtitle: string;
  /** The elapsed time or clock time at the trailing edge. */
  time?: string;
  variant: RowVariant;
  /** A waiting row's question, already translated ("Asks: …"). */
  asks?: string;
  counts?: { insertions: number; deletions: number };
  /** An action beside the text, vertically centred (Resume). */
  trailing?: ReactNode;
  onPress?: () => void;
  /** Wide sessions split: the row whose detail is open beside the list. */
  selected?: boolean;
  /** "compact" (wide list): tighter, with no Asks line and no trailing action. */
  density?: "regular" | "compact";
};

export function SessionRow(props: SessionRowProps) {
  const { variant } = props;
  const done = variant === "done";
  const compact = props.density === "compact";
  return (
    <TouchableOpacity
      style={[
        styles.row,
        compact && styles.rowCompact,
        variant === "waiting" && styles.rowWaiting,
        done && styles.rowDone,
        props.selected && styles.rowSelected,
      ]}
      onPress={props.onPress}
      disabled={props.onPress === undefined}
      activeOpacity={0.7}
      accessibilityRole={props.onPress !== undefined ? "button" : undefined}
      accessibilityLabel={props.onPress !== undefined ? props.title : undefined}
      accessibilityState={props.selected ? { selected: true } : undefined}
    >
      <View
        style={[
          styles.dot,
          compact && styles.dotCompact,
          variant === "active" && { backgroundColor: theme.colors.accent },
          variant === "waiting" && { backgroundColor: theme.colors.warning },
          done && styles.dotDone,
        ]}
      />
      <View style={styles.text}>
        <View style={styles.top}>
          <Text style={[styles.title, done && styles.titleDone]} numberOfLines={1}>
            {props.title}
          </Text>
          {props.time !== undefined && (
            <Text style={[styles.time, done && styles.timeDone]}>{props.time}</Text>
          )}
        </View>
        <Text style={[styles.sub, done && styles.subDone]} numberOfLines={1}>
          {props.subtitle}
          {props.counts !== undefined && (
            <Text style={styles.mono}>
              {props.subtitle === "" ? "" : " · "}
              {props.counts.insertions > 0 && (
                <Text style={styles.added}>+{props.counts.insertions}</Text>
              )}
              {props.counts.insertions > 0 && props.counts.deletions > 0 ? " " : ""}
              {props.counts.deletions > 0 && (
                <Text style={styles.removed}>−{props.counts.deletions}</Text>
              )}
            </Text>
          )}
        </Text>
        {!compact && props.asks !== undefined && (
          <Text style={styles.asks} numberOfLines={2}>
            {props.asks}
          </Text>
        )}
      </View>
      {!compact && props.trailing !== undefined && (
        <View style={styles.trailing}>{props.trailing}</View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 12,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  rowWaiting: { borderColor: theme.colors.warningBorder },
  rowDone: { borderColor: theme.colors.hairlineSoft, backgroundColor: "transparent" },
  // The border keeps its variant colour: only the ground changes.
  rowSelected: { backgroundColor: theme.colors.surfaceAlt },
  rowCompact: { gap: 10, padding: 10, borderRadius: theme.radius.md },
  dotCompact: { width: 9, height: 9 },
  dot: { width: 10, height: 10, marginTop: 5, borderRadius: theme.radius.full },
  dotDone: { borderWidth: 2, borderColor: theme.colors.textFaint },
  text: { flex: 1, minWidth: 0, gap: 3 },
  top: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  title: { ...theme.type.rowTitle, flexShrink: 1, color: theme.colors.text },
  titleDone: { fontFamily: theme.font.semibold, color: theme.colors.textSecondary },
  time: { ...theme.type.meta, flexShrink: 0, color: theme.colors.textMuted },
  timeDone: { color: theme.colors.textDim },
  sub: { ...theme.type.meta, color: theme.colors.textMuted },
  subDone: { color: theme.colors.textDim },
  mono: { ...theme.type.mono },
  added: { color: theme.colors.success },
  removed: { color: theme.colors.dangerText },
  asks: { ...theme.type.meta, fontFamily: theme.font.semibold, color: theme.colors.warning },
  trailing: { alignSelf: "center" },
});
