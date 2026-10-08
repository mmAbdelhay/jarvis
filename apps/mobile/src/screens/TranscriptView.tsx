import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ResumeButton } from "@/components/ResumeButton";
import { useWidePanelTitle } from "@/components/WidePanel";
import {
  chatTurnLabel,
  historyDetailSub,
  transcriptDisplay,
  withLrmPrefixes,
} from "@/lib/history-screen";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { type Language, t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { type SessionDateLabel, sessionDateLabel } from "@/lib/session-date-groups";
import { theme } from "@/lib/theme";
import { textDirection } from "@/lib/voice-screen";

/** "yesterday", "today" or "Sep 30" for the chat header's sub line. */
function dayWord(label: SessionDateLabel, language: Language): string {
  if (label.kind === "today") return t(language, "sessions.today").toLowerCase();
  if (label.kind === "yesterday") return t(language, "sessions.yesterday").toLowerCase();
  return new Date(label.ms).toLocaleDateString(language === "ar" ? "ar" : "en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * One session's recorded conversation. On its own route it names the
 * screen after the session; embedded beside History's list (wide layout)
 * it draws the title itself and touches no header.
 */
export function TranscriptBody({
  id,
  embedded = false,
  variant,
}: {
  id: string;
  embedded?: boolean;
  /** "chat": the wide History detail — header with Resume, bubbles and tool
   *  chips. Omitted, the phone transcript is unchanged. */
  variant?: "chat";
}) {
  const language = useLanguage();
  const client = useRpcClient();
  const store = useMemo(() => createHistoryStore({ client, pinnedId: id }), [client, id]);
  const [view, setView] = useState<HistoryState>(store.get());
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(
    useCallback(() => {
      const unsubscribe = store.subscribe(setView);
      store.open();
      setView(store.get());
      return () => {
        unsubscribe();
        store.close();
      };
    }, [store]),
  );

  useEffect(() => {
    if (view.sessions.some((session) => session.id === id) && view.selectedId !== id) {
      store.select(id);
    }
  }, [id, store, view.sessions, view.selectedId]);

  const selected = view.sessions.find((session) => session.id === id);
  // The panel header on a wide screen shows what the phone's stack header
  // shows: the session summary once the list has it.
  useWidePanelTitle(embedded ? undefined : selected?.summary);

  const refresh = useCallback(() => {
    setRefreshing(true);
    store.refresh();
    setTimeout(() => setRefreshing(false), 250);
  }, [store]);

  // Fix round 1 (Important 3): distinguishes "genuinely no such session",
  // "genuinely empty transcript", "still loading" and "the fetch failed" —
  // before this, a `session:transcript` timeout left `transcript: []` with
  // `loading: false`, which rendered the same "No transcript entries."
  // copy as a real empty transcript, and a `history:list` failure before
  // any session loaded rendered a false "Session not found."
  const display = transcriptDisplay(view, id, language);

  const chat = variant === "chat";

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={chat ? styles.contentChat : styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      {chat ? (
        selected !== undefined && (
          <View style={[styles.chatHeader, { direction: textDirection(language) }]}>
            <View style={styles.chatHeaderText}>
              <Text selectable style={styles.chatTitle}>
                {selected.summary}
              </Text>
              <Text selectable style={styles.chatSub}>
                {historyDetailSub(
                  selected,
                  dayWord(sessionDateLabel(selected.lastActivityAt, Date.now()), language),
                )}
              </Text>
            </View>
            {selected.project !== null && (
              <ResumeButton
                variant="header"
                sessionId={selected.id}
                project={selected.project}
                state={selected.state}
              />
            )}
          </View>
        )
      ) : embedded ? (
        selected !== undefined && <Text style={styles.heading}>{selected.summary}</Text>
      ) : (
        <Stack.Screen options={{ title: selected?.summary ?? t(language, "history.transcript") }} />
      )}
      {!chat && selected !== undefined && (
        <ResumeButton sessionId={selected.id} project={selected.project} state={selected.state} />
      )}
      {display.kind === "loading" && (
        <Text style={styles.empty}>{t(language, "history.loading")}</Text>
      )}
      {display.kind === "notFound" && (
        <Text style={styles.empty}>{t(language, "history.notFound")}</Text>
      )}
      {display.kind === "failed" && (
        <View style={styles.failedBlock}>
          <Text selectable style={styles.error}>
            {display.text}
          </Text>
          <TouchableOpacity onPress={() => store.refresh()}>
            <Text style={styles.retry}>{t(language, "common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}
      {display.kind === "empty" && (
        <Text style={styles.empty}>{t(language, "history.emptyTranscript")}</Text>
      )}
      {display.kind === "entries" && chat && (
        <View style={[styles.chatColumn, { direction: textDirection(language) }]}>
          {view.transcript.map((entry, index) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: entries carry no id; the list is replaced wholesale per selection, never reordered or spliced.
              key={`${entry.role}:${index}`}
              accessible
              accessibilityLabel={chatTurnLabel(entry, language)}
              style={entry.role === "user" ? styles.userTurn : styles.assistantTurn}
            >
              {entry.text !== "" && (
                <Text
                  selectable
                  style={entry.role === "user" ? styles.userText : styles.assistantText}
                >
                  {withLrmPrefixes(entry.text, language)}
                </Text>
              )}
              {entry.tools.length > 0 && (
                <View style={styles.chips}>
                  {entry.tools.map((tool, toolIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a tool name can repeat within one turn.
                    <View key={`${tool}:${toolIndex}`} style={styles.chip}>
                      <Text selectable style={styles.chipText}>
                        {tool}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
        </View>
      )}
      {display.kind === "entries" && !chat && (
        <View style={styles.list}>
          {view.transcript.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: entries carry no id; the list is replaced wholesale per selection, never reordered or spliced.
            <View key={`${entry.role}:${index}`} style={styles.turn}>
              <Text style={styles.role}>
                {entry.role === "user"
                  ? t(language, "history.user")
                  : t(language, "history.assistant")}
              </Text>
              {entry.text !== "" && (
                // M12 Task 8, rule 10: a transcript entry carries no
                // per-turn language tag (unlike TurnList.tsx's voice
                // turns) — each line is prefixed with U+200E when the UI
                // is RTL and that line is LTR code/diff content, instead
                // of the iOS-only `writingDirection` style (history-
                // screen.ts's `withLrmPrefixes`).
                <Text selectable style={styles.body}>
                  {withLrmPrefixes(entry.text, language)}
                </Text>
              )}
              {entry.tools.length > 0 && (
                <Text selectable style={styles.tools}>
                  {entry.tools.join(", ")}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}
      {display.kind === "entries" && view.notice && (
        <Text selectable style={styles.error}>
          {view.notice}
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  contentChat: { paddingVertical: 20, paddingHorizontal: 28, gap: 14 },
  list: { gap: theme.spacing.md },
  heading: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 20 },
  chatHeader: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
  },
  chatHeaderText: { flexShrink: 1, flexGrow: 1, gap: 4, minWidth: 240 },
  chatTitle: { color: theme.colors.text, fontFamily: theme.font.extrabold, fontSize: 22 },
  chatSub: { color: theme.colors.textMuted, fontFamily: theme.font.body, fontSize: 13 },
  chatColumn: { gap: 12, maxWidth: 760, width: "100%" },
  userTurn: { alignSelf: "flex-end", maxWidth: "80%", gap: 6 },
  userText: {
    color: theme.colors.text,
    backgroundColor: theme.colors.userBubble,
    borderRadius: theme.radius.lg,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontFamily: theme.font.body,
    fontSize: 14,
    lineHeight: 21,
    overflow: "hidden",
  },
  assistantTurn: { alignSelf: "flex-start", maxWidth: "90%", gap: 8 },
  assistantText: {
    color: theme.colors.transcriptText,
    fontFamily: theme.font.body,
    fontSize: 14,
    lineHeight: 22,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipText: { color: theme.colors.textMuted, fontFamily: theme.font.mono, fontSize: 11 },
  turn: {
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  role: { color: theme.colors.primary, fontWeight: theme.font.weight.bold },
  body: { color: theme.colors.text, lineHeight: 22 },
  tools: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  empty: { color: theme.colors.textMuted, padding: theme.spacing.lg },
  error: { color: theme.colors.danger },
  failedBlock: { gap: theme.spacing.xs, padding: theme.spacing.lg },
  retry: { color: theme.colors.primary, fontWeight: theme.font.weight.bold },
});
