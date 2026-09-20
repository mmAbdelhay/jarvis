import type { SessionState } from "@jarvis/core";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionRow } from "@/components/SessionRow";
import { formatSessionElapsed } from "@/lib/format";
import type { Language, MessageKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import type { SessionDateGroup } from "@/lib/session-date-groups";
import { groupEndedByDate } from "@/lib/session-date-groups";
import type { SessionRowView, SessionsView } from "@/lib/sessions-store";
import { createSessionsStore } from "@/lib/sessions-store";
import { theme } from "@/lib/theme";

const STATE_KEYS: Record<SessionState, MessageKey> = {
  starting: "sessions.state.starting",
  running: "sessions.state.running",
  waiting: "sessions.state.waiting",
  done: "sessions.state.done",
  dead: "sessions.state.dead",
};

const ACTIVE_STATES = new Set<SessionState>(["starting", "running", "waiting"]);

/** The row's mono elapsed field (item 6): time since it started for an
 *  active row, or its total duration (end minus start) for an ended one —
 *  both from `startedAt`, added to `SessionRowView` for exactly this
 *  (sessions-store.ts). */
function rowElapsed(row: SessionRowView, nowMs: number): string {
  const end = ACTIVE_STATES.has(row.state) ? nowMs : (row.endedAt ?? row.lastActivityAt);
  return formatSessionElapsed(Math.max(0, end - row.startedAt));
}

/** The ended-group section header text (item 7): a real date label instead
 *  of a hardcoded "TODAY" — `groupEndedByDate` (session-date-groups.ts)
 *  already buckets rows by calendar day; this just turns a bucket's label
 *  into display text. A day older than yesterday shows a short localized
 *  date rather than a third bilingual key, the same "no new STRINGS entry
 *  for open-ended data" approach session/[id].tsx and settings.tsx already
 *  take for dates (`toLocaleDateString`).
 */
function dateGroupLabelText(label: SessionDateGroup["label"], language: Language): string {
  if (label.kind === "today") return t(language, "sessions.today");
  if (label.kind === "yesterday") return t(language, "sessions.yesterday");
  return new Date(label.ms)
    .toLocaleDateString(language === "ar" ? "ar" : "en-US", { month: "short", day: "numeric" })
    .toUpperCase();
}

// The full session table (Task 7): every session the laptop knows about,
// grouped active/ended. Screen logic (subscribing on focus, parsing,
// grouping) lives in sessions-store.ts; this file is layout only.
export default function SessionsScreen() {
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const store = useMemo(() => createSessionsStore({ client }), [client]);
  const [view, setView] = useState<SessionsView>(store.get());
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<"active" | "ended">("active");
  const insets = useSafeAreaInsets();

  useFocusEffect(
    useCallback(() => {
      setView(store.get());
      const unsubscribe = store.subscribe(setView);
      store.focus();
      return () => {
        unsubscribe();
        store.blur();
      };
    }, [store]),
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    // Pull-to-refresh asks the laptop to look again — re-import transcripts
    // and re-scan the process table for agents running outside Jarvis
    // (process-scan.ts) — never a plain re-list, which could only repeat
    // whatever the laptop already had before the pull.
    void store.pullToRefresh().finally(() => setRefreshing(false));
  }, [store]);

  const openSession = useCallback(
    (id: string) => {
      router.push({ pathname: "/session/[id]", params: { id } });
    },
    [router],
  );

  const empty = view.active.length === 0 && view.ended.length === 0;
  const now = Date.now();
  const endedGroups = useMemo(() => groupEndedByDate(view.ended, now), [view.ended, now]);

  const renderRows = useCallback(
    (rows: SessionRowView[]) =>
      rows.length === 0 ? (
        <Text style={styles.empty}>{t(language, "sessions.none")}</Text>
      ) : (
        <View style={styles.list}>
          {rows.map((row) => (
            <SessionRow
              key={row.id}
              summary={row.summary}
              label={row.label}
              state={row.state}
              stateLabel={t(language, STATE_KEYS[row.state])}
              elapsed={rowElapsed(row, now)}
              externalLabel={
                row.origin === "external" ? t(language, "sessions.external") : undefined
              }
              // A row outside Jarvis has no pty behind it — never navigate
              // into a terminal nothing is attached to.
              onPress={row.origin === "external" ? undefined : () => openSession(row.id)}
            />
          ))}
        </View>
      ),
    [language, openSession, now],
  );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      <Text style={styles.title}>{t(language, "sessions.title")}</Text>
      <View style={styles.segment}>
        <TouchableOpacity
          style={[styles.segmentButton, activeTab === "active" && styles.segmentActive]}
          onPress={() => setActiveTab("active")}
        >
          <Text style={[styles.segmentText, activeTab !== "active" && styles.segmentDim]}>
            {t(language, "sessions.active")} · {view.active.length}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segmentButton, activeTab === "ended" && styles.segmentActive]}
          onPress={() => setActiveTab("ended")}
        >
          <Text style={[styles.segmentText, activeTab !== "ended" && styles.segmentDim]}>
            {t(language, "sessions.ended")} · {view.ended.length}
          </Text>
        </TouchableOpacity>
      </View>
      {empty ? (
        <Text style={styles.empty}>{t(language, "sessions.none")}</Text>
      ) : activeTab === "active" ? (
        renderRows(view.active)
      ) : endedGroups.length === 0 ? (
        <Text style={styles.empty}>{t(language, "sessions.none")}</Text>
      ) : (
        endedGroups.map((group) => (
          <View key={group.rows[0]?.id ?? group.label.kind}>
            <Text style={styles.sectionTitle}>{dateGroupLabelText(group.label, language)}</Text>
            {renderRows(group.rows)}
          </View>
        ))
      )}

      {view.error?.kind === "remote" && <Text style={styles.error}>{view.error.text}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 20,
    gap: 10,
  },
  title: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 26, marginBottom: 4 },
  segment: {
    flexDirection: "row",
    padding: 3,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    marginBottom: 4,
  },
  segmentButton: {
    flex: 1,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
  },
  segmentActive: { backgroundColor: theme.colors.selected },
  segmentText: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 13 },
  segmentDim: { color: theme.colors.textDim, fontFamily: theme.font.semibold },
  sectionTitle: {
    color: theme.colors.textDim,
    fontFamily: theme.font.bold,
    fontSize: 12,
    letterSpacing: 1.2,
    marginTop: 12,
  },
  list: {
    gap: theme.spacing.sm,
  },
  empty: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  error: {
    color: theme.colors.danger,
    fontSize: theme.font.size.sm,
  },
});
