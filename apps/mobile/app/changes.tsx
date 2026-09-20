import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { failedText, noticeText, sessionIdToReopen, shouldClearDraft } from "@/lib/changes-screen";
import { createChangesStore, ENDED_SESSION_NOTICE, type ChangesState } from "@/lib/changes-store";
import { historyListDisplay } from "@/lib/history-screen";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { sessionRouteId } from "@/lib/session-screen";
import { theme } from "@/lib/theme";

export default function ChangesScreen() {
  const language = useLanguage();
  const client = useRpcClient();
  const routeSessionId = sessionRouteId(useLocalSearchParams().id);
  const historyStore = useMemo(() => createHistoryStore({ client }), [client]);
  const changesStore = useMemo(() => createChangesStore({ client }), [client]);
  const [history, setHistory] = useState<HistoryState>(historyStore.get());
  const [changes, setChanges] = useState<ChangesState>(changesStore.get());
  const [connection, setConnection] = useState(client.state());
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  // Fix round 2 (New Breakage 1): the route id from a session-detail link
  // is consumed once, not on every refocus — otherwise it would keep
  // overriding any chip the user taps afterward for the life of this
  // screen instance. See sessionIdToReopen's doc comment.
  const consumedRouteIdRef = useRef<string | undefined>(undefined);

  // Fix round 1 (Important 2): the store's own `sessionId` survives
  // `close()` — only its subscriptions and visible data are torn down — so
  // reopening it here (or a route id from a session-detail link, once)
  // restores the chip highlight, the body and pull-to-refresh on every
  // refocus, not just the first visit.
  useFocusEffect(
    useCallback(() => {
      const unHistory = historyStore.subscribe(setHistory);
      const unChanges = changesStore.subscribe(setChanges);
      const unConnection = client.onState((state) => setConnection(state));
      setConnection(client.state());
      historyStore.open();
      const toOpen = sessionIdToReopen(
        changesStore.get(),
        routeSessionId,
        consumedRouteIdRef.current,
      );
      if (routeSessionId !== undefined) consumedRouteIdRef.current = routeSessionId;
      if (toOpen !== undefined) changesStore.open(toOpen);
      setHistory(historyStore.get());
      setChanges(changesStore.get());
      return () => {
        unHistory();
        unChanges();
        unConnection();
        historyStore.close();
        changesStore.close();
      };
    }, [historyStore, changesStore, client, routeSessionId]),
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    historyStore.refresh();
    changesStore.refresh();
    setTimeout(() => setRefreshing(false), 250);
  }, [historyStore, changesStore]);

  const selectedFiles = changes.changes?.changes.files ?? [];
  const diff = changes.diff;
  const sessionsDisplay = historyListDisplay(history, language);
  // Fix round 2 (New Breakage 2): also gate on a session being chosen —
  // Commit/Stage previously reached the store's mutation queue with no
  // session at all, which the store now guards but the button shouldn't
  // even invite.
  const disabled = changes.busy || connection !== "open" || changes.sessionId === undefined;

  async function commit(): Promise<void> {
    await changesStore.commit(message);
    if (shouldClearDraft(changesStore.get())) setMessage("");
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      <Text style={styles.sectionTitle}>{t(language, "changes.sessions")}</Text>
      <ScrollView horizontal contentContainerStyle={styles.sessionStrip}>
        {history.sessions.map((session) => (
          <TouchableOpacity
            key={session.id}
            style={[styles.chip, changes.sessionId === session.id ? styles.chipActive : undefined]}
            onPress={() => changesStore.open(session.id)}
          >
            <Text style={styles.chipText}>{session.summary}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      {sessionsDisplay.kind === "empty" && (
        <Text style={styles.empty}>{t(language, "changes.noSessions")}</Text>
      )}
      {sessionsDisplay.kind === "failed" && (
        <View style={styles.failedBlock}>
          <Text selectable style={styles.error}>
            {sessionsDisplay.text}
          </Text>
          <TouchableOpacity onPress={() => historyStore.refresh()}>
            <Text style={styles.retry}>{t(language, "common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {changes.phase === "loading" && (
        <Text style={styles.empty}>{t(language, "changes.loading")}</Text>
      )}

      {changes.phase === "failed" && (
        <View style={styles.failedBlock}>
          <Text selectable style={styles.error}>
            {failedText(changes, language)}
          </Text>
          <TouchableOpacity onPress={() => changesStore.refresh()}>
            <Text style={styles.retry}>{t(language, "common.retry")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {changes.notice === ENDED_SESSION_NOTICE && (
        <Text style={styles.warning}>{t(language, "changes.endedWarning")}</Text>
      )}
      {changes.notice !== undefined &&
        changes.notice !== ENDED_SESSION_NOTICE &&
        changes.phase !== "failed" && (
          <Text selectable style={styles.error}>
            {noticeText(changes.notice, language)}
          </Text>
        )}
      {changes.stale && !changes.uncertain && changes.notice === undefined && (
        <Text style={styles.empty}>{t(language, "common.stale")}</Text>
      )}
      {changes.uncertain && <Text style={styles.warning}>{t(language, "changes.uncertain")}</Text>}

      {changes.changes && (
        <View style={styles.repoBlock}>
          <Text selectable style={styles.repoText}>
            {changes.changes.changes.repoPath}
          </Text>
          <Text style={styles.meta}>
            {changes.changes.changes.detached ? "HEAD" : changes.changes.changes.branch} · +
            {changes.changes.changes.insertions} -{changes.changes.changes.deletions}
          </Text>
        </View>
      )}

      {selectedFiles.length > 0 && (
        <View style={styles.fileList}>
          {selectedFiles.map((file) => (
            <View key={file.path} style={styles.fileRow}>
              <TouchableOpacity
                style={styles.fileName}
                onPress={() => changesStore.selectFile(file.path)}
              >
                <Text selectable style={styles.path}>
                  {file.path}
                </Text>
                <Text style={styles.meta}>
                  {file.status} · +{file.insertions} -{file.deletions}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={disabled}
                style={[styles.smallButton, disabled ? styles.buttonDisabled : undefined]}
                onPress={() => {
                  void changesStore.setStaged(file.path, !file.staged);
                }}
              >
                <Text style={styles.buttonText}>
                  {file.staged ? t(language, "changes.unstage") : t(language, "changes.stage")}
                </Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {changes.changes && selectedFiles.length === 0 && (
        <Text style={styles.empty}>{t(language, "changes.clean")}</Text>
      )}

      {diff && (
        <View style={styles.diffBlock}>
          <Text selectable style={styles.path}>
            {diff.path}
          </Text>
          {diff.binary && <Text style={styles.empty}>{t(language, "changes.binary")}</Text>}
          {diff.tooLarge && <Text style={styles.empty}>{t(language, "changes.tooLarge")}</Text>}
          {!diff.binary && !diff.tooLarge && (
            <ScrollView horizontal>
              <View style={styles.diffContent}>
                {diff.hunks.map((hunk) => (
                  <View key={hunk.header} style={styles.hunk}>
                    <Text selectable style={[styles.hunkHeader, { writingDirection: "ltr" }]}>
                      {hunk.header}
                    </Text>
                    {hunk.lines.map((line) => (
                      <Text
                        selectable
                        key={`${hunk.header}:${line.kind}:${line.beforeLine ?? "-"}:${line.afterLine ?? "-"}`}
                        style={[
                          styles.diffLine,
                          { writingDirection: "ltr" },
                          line.kind === "added" ? styles.added : undefined,
                          line.kind === "removed" ? styles.removed : undefined,
                        ]}
                      >
                        {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
                        {String(line.beforeLine ?? "").padStart(4, " ")}{" "}
                        {String(line.afterLine ?? "").padStart(4, " ")} {line.text}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          )}
        </View>
      )}

      <TextInput
        style={styles.input}
        value={message}
        onChangeText={setMessage}
        placeholder={t(language, "changes.commitPlaceholder")}
        placeholderTextColor={theme.colors.textMuted}
        multiline
      />
      <TouchableOpacity
        disabled={disabled || message.trim() === ""}
        style={[
          styles.button,
          disabled || message.trim() === "" ? styles.buttonDisabled : undefined,
        ]}
        onPress={() => {
          void commit();
        }}
      >
        <Text style={styles.primaryButtonText}>{t(language, "changes.commit")}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
  },
  sessionStrip: { gap: theme.spacing.sm },
  chip: {
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
  },
  chipActive: { borderColor: theme.colors.primary, backgroundColor: theme.colors.surfaceAlt },
  chipText: { color: theme.colors.text, maxWidth: 220 },
  empty: { color: theme.colors.textMuted },
  warning: { color: theme.colors.warning },
  error: { color: theme.colors.danger },
  failedBlock: { gap: theme.spacing.xs },
  retry: { color: theme.colors.primary, fontWeight: theme.font.weight.bold },
  repoBlock: {
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  repoText: { color: theme.colors.text },
  meta: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  fileList: { gap: theme.spacing.sm },
  fileRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  fileName: {
    flex: 1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
  },
  path: { color: theme.colors.text },
  smallButton: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    minWidth: 76,
    alignItems: "center",
  },
  buttonText: { color: theme.colors.text },
  diffBlock: { gap: theme.spacing.sm },
  // Fix round 1 (Important 4): forced LTR, like the terminal
  // (TerminalWebView.tsx) and key bar (KeyBar.tsx) — a unified diff's
  // +/-, padded line numbers and monospace content must not be bidi
  // reordered under the Arabic UI, even when the changed lines themselves
  // contain Arabic text (constraint 7: real RTL stays outside code/
  // terminal/diff content).
  diffContent: { minWidth: 720, gap: theme.spacing.md, direction: "ltr" },
  hunk: { gap: theme.spacing.xs },
  hunkHeader: { color: theme.colors.primary, fontFamily: "monospace" },
  diffLine: { color: theme.colors.text, fontFamily: "monospace" },
  added: { color: theme.colors.success },
  removed: { color: theme.colors.danger },
  input: {
    minHeight: 72,
    color: theme.colors.text,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    textAlignVertical: "top",
  },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.45 },
  primaryButtonText: { color: theme.colors.primaryText, fontWeight: theme.font.weight.bold },
});
