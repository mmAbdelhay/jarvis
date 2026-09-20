// One row of a sessions list — the Dashboard's `dashboard.sessions` section
// (Task 6, rule 5) and the full session table (Task 7, `app/sessions.tsx`)
// both render through this one component: summary, an optional label
// (project name or path segment) and a running/idle indicator dot. Task 7
// adds an optional tap target (a session row opens `/session/[id]`) and an
// optional state chip (the session table shows one; the Dashboard doesn't).
// `summary`/`label` are shown verbatim — server text, never routed through
// i18n. `stateLabel`, if given, is already-translated text from the
// screen's own i18n lookup — this component does no translation itself.
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { SessionState } from "@jarvis/core";
import { theme } from "@/lib/theme";

function isRunning(state: SessionState): boolean {
  return state === "starting" || state === "running";
}

export type SessionRowProps = {
  summary: string;
  label: string | null;
  state: SessionState;
  stateLabel?: string;
  // Fix round (2026-09-19 redesign): the board's mono elapsed field
  // (`12m`, `1h 04m`) — already formatted by the caller (formatSessionElapsed,
  // format.ts), never computed here. Shown alone (Dashboard's rows have no
  // `stateLabel`) or under the state chip (the Sessions table).
  elapsed?: string;
  // Sessions-refresh feature: already-translated text ("outside Jarvis" /
  // "خارج جارفيس"), shown only for a row process-scan.ts found running
  // outside Jarvis. Its own chip, distinct from stateLabel's, so a
  // read-only row still reads its ordinary running/waiting/done state too.
  externalLabel?: string;
  onPress?: () => void;
};

export function SessionRow({
  summary,
  label,
  state,
  stateLabel,
  elapsed,
  externalLabel,
  onPress,
}: SessionRowProps) {
  const running = isRunning(state);
  const waiting = state === "waiting";
  const color = running
    ? theme.colors.success
    : waiting
      ? theme.colors.warning
      : theme.colors.disabledDot;
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      disabled={onPress === undefined}
      activeOpacity={0.7}
      accessibilityRole={onPress !== undefined ? "button" : undefined}
      accessibilityLabel={onPress !== undefined ? summary : undefined}
    >
      <View
        style={[
          styles.indicator,
          {
            backgroundColor: color,
            shadowColor: color,
            shadowOpacity: running || waiting ? 0.35 : 0,
            shadowRadius: 5,
          },
        ]}
      />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {summary}
        </Text>
        {label !== null && label.length > 0 && (
          <Text style={styles.project} numberOfLines={1}>
            {label}
          </Text>
        )}
      </View>
      {(stateLabel !== undefined || elapsed !== undefined || externalLabel !== undefined) && (
        <View style={styles.trailing}>
          {externalLabel !== undefined && (
            <View style={[styles.chip, styles.externalChip]}>
              <Text style={[styles.chipText, styles.externalChipText]}>{externalLabel}</Text>
            </View>
          )}
          {stateLabel !== undefined && (
            <View style={[styles.chip, { backgroundColor: `${color}24` }]}>
              <Text style={[styles.chipText, { color }]}>{stateLabel}</Text>
            </View>
          )}
          {elapsed !== undefined && <Text style={styles.elapsed}>{elapsed}</Text>}
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
    gap: 12,
    minHeight: 68,
  },
  indicator: {
    width: 10,
    height: 10,
    borderRadius: theme.radius.full,
  },
  text: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
    fontFamily: theme.font.semibold,
  },
  project: {
    color: theme.colors.textDim,
    fontSize: theme.font.size.sm,
  },
  trailing: { alignItems: "flex-end", gap: 4 },
  chip: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.full,
    paddingVertical: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
  },
  chipText: {
    fontFamily: theme.font.bold,
    fontSize: 11,
  },
  externalChip: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  externalChipText: {
    color: theme.colors.primary,
  },
  elapsed: {
    color: theme.colors.textDim,
    fontFamily: theme.font.mono,
    fontSize: 11,
  },
});
