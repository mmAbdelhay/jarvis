import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChangeCountsView } from "@/lib/change-counts";
import type { SessionSummary } from "@/lib/dashboard-store";
import { activeRows } from "@/lib/home-active";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/**
 * Wide Home's Active sessions table: dot, title, project, agent and the +/-
 * counts (once the laptop has pushed them). Waiting rows sit on the surface
 * ground; a session found outside Jarvis cannot be opened.
 */
export function ActiveTable(props: {
  language: Language;
  sessions: readonly SessionSummary[];
  counts: ChangeCountsView;
  onOpen(sessionId: string): void;
  onAll(): void;
}) {
  const rows = activeRows(props.sessions, props.counts);
  return (
    <View style={styles.section} accessibilityLabel={t(props.language, "home.activeSessions")}>
      <View style={styles.header}>
        <Text style={styles.title}>{t(props.language, "home.activeSessions")}</Text>
        <Pressable accessibilityRole="link" onPress={props.onAll}>
          <Text style={styles.link}>{t(props.language, "dashboard.allSessions")}</Text>
        </Pressable>
      </View>
      <View style={styles.table}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>{t(props.language, "dashboard.noSessions")}</Text>
        ) : (
          rows.map((row, index) => (
            <Pressable
              key={row.id}
              onPress={row.external ? undefined : () => props.onOpen(row.id)}
              disabled={row.external}
              accessibilityRole={row.external ? undefined : "button"}
              accessibilityLabel={row.external ? undefined : row.title}
              style={[styles.row, index > 0 && styles.rowDivider, row.waiting && styles.rowWaiting]}
            >
              <View
                style={[
                  styles.dot,
                  { backgroundColor: row.waiting ? theme.colors.warning : theme.colors.accent },
                ]}
              />
              <Text style={styles.rowTitle} numberOfLines={1}>
                {row.title}
              </Text>
              <Text style={[styles.cell, styles.project]} numberOfLines={1}>
                {row.project ?? ""}
              </Text>
              <Text style={[styles.cell, styles.agent]} numberOfLines={1}>
                {row.agentId}
              </Text>
              <View style={styles.counts}>
                {row.counts !== undefined && (
                  <Text style={styles.countsText} numberOfLines={1}>
                    <Text style={styles.added}>+{row.counts.insertions}</Text>{" "}
                    <Text style={styles.removed}>−{row.counts.deletions}</Text>
                  </Text>
                )}
              </View>
            </Pressable>
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8, minWidth: 0 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  title: { ...theme.type.sectionLabelLarge, color: theme.colors.textMuted },
  link: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.colors.link },
  table: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    overflow: "hidden",
  },
  empty: { ...theme.type.body, color: theme.colors.textMuted, padding: 14 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: theme.colors.hairlineSoft },
  rowWaiting: { backgroundColor: theme.colors.surface },
  dot: { width: 10, height: 10, borderRadius: theme.radius.full },
  rowTitle: { flex: 1, minWidth: 0, ...theme.type.rowTitle, color: theme.colors.text },
  cell: { ...theme.type.chip, fontFamily: theme.font.body, color: theme.colors.textMuted },
  project: { width: 120 },
  agent: { width: 110 },
  counts: { width: 90, alignItems: "flex-end" },
  countsText: { ...theme.type.mono },
  added: { color: theme.colors.success },
  removed: { color: theme.colors.dangerText },
});
