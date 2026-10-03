import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChangeCountsView } from "@/lib/change-counts";
import type { SessionSummary } from "@/lib/dashboard-store";
import { type ActiveRow, activeRows, activeSubtitle, activeTitle } from "@/lib/home-active";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/**
 * Phone Home's "Active" section: the live sessions, waiting ones first, each
 * with the agent, how long it has run and (once the laptop has pushed them)
 * its +/- line counts. A session found outside Jarvis is shown but cannot be
 * opened.
 */
export function ActiveList(props: {
  language: Language;
  sessions: readonly SessionSummary[];
  counts: ChangeCountsView;
  now: number;
  onOpen(sessionId: string): void;
  onAll(): void;
}) {
  const rows = activeRows(props.sessions, props.counts);
  return (
    <View style={styles.section} accessibilityLabel={t(props.language, "home.active")}>
      <View style={styles.header}>
        <Text style={styles.title}>{t(props.language, "home.active")}</Text>
        <Pressable accessibilityRole="link" onPress={props.onAll}>
          <Text style={styles.link}>{t(props.language, "dashboard.allSessions")}</Text>
        </Pressable>
      </View>
      {rows.length === 0 ? (
        <Text style={styles.empty}>{t(props.language, "dashboard.noSessions")}</Text>
      ) : (
        rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            subtitle={activeSubtitle(props.language, row, props.now)}
            onPress={row.external ? undefined : () => props.onOpen(row.id)}
          />
        ))
      )}
    </View>
  );
}

function Row(props: { row: ActiveRow; subtitle: string; onPress: (() => void) | undefined }) {
  const { row } = props;
  const title = activeTitle(row);
  return (
    <Pressable
      style={styles.row}
      onPress={props.onPress}
      disabled={props.onPress === undefined}
      accessibilityRole={props.onPress === undefined ? undefined : "button"}
      accessibilityLabel={props.onPress === undefined ? undefined : title}
    >
      <View
        style={[
          styles.dot,
          { backgroundColor: row.waiting ? theme.colors.warning : theme.colors.accent },
        ]}
      />
      <View style={styles.text}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {props.subtitle}
        </Text>
      </View>
      {row.counts !== undefined && (
        <Text style={styles.counts}>
          <Text style={styles.added}>+{row.counts.insertions}</Text>{" "}
          <Text style={styles.removed}>−{row.counts.deletions}</Text>
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  title: { ...theme.type.sectionLabelLarge, color: theme.colors.textMuted },
  link: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.colors.link },
  empty: { ...theme.type.body, color: theme.colors.textMuted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  dot: { width: 10, height: 10, borderRadius: theme.radius.full },
  text: { flex: 1, minWidth: 0 },
  rowTitle: { ...theme.type.rowTitle, color: theme.colors.text },
  sub: { ...theme.type.meta, color: theme.colors.textMuted },
  counts: { ...theme.type.mono, color: theme.colors.textMuted },
  added: { color: theme.colors.success },
  removed: { color: theme.colors.dangerText },
});
