import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BranchCard } from "@/components/changes/BranchCard";
import { BranchSheet } from "@/components/changes/BranchSheet";
import { CommitFooter } from "@/components/changes/CommitFooter";
import { DiffView } from "@/components/changes/DiffView";
import { FileList } from "@/components/changes/FileList";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SessionPickerSheet } from "@/components/SessionPickerSheet";
import {
  defaultChangesSession,
  failedText,
  noticeText,
  sessionIdToReopen,
  shouldClearDraft,
} from "@/lib/changes-screen";
import { createChangesStore, ENDED_SESSION_NOTICE, type ChangesState } from "@/lib/changes-store";
import { historyListDisplay } from "@/lib/history-screen";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { t } from "@/lib/i18n";
import { keyboardAvoidingBehavior, keyboardBottomPadding } from "@/lib/keyboard-offset";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { findRow, isActiveRow, mergeSessions } from "@/lib/sessions-merge";
import { createSessionsStore, type SessionsView } from "@/lib/sessions-store";
import { theme } from "@/lib/theme";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useLayoutClass } from "@/lib/use-layout-class";

/** Git changes: the full-screen `/changes` route on a phone (with the
 *  session a detail link names, else the most recent one), or an inline
 *  Workspace tab on a wide screen. On a phone the header's subtitle names
 *  the session and opens a picker; wide and embedded keep a chip strip. */
export function ChangesScreen(props: { sessionId: string | undefined; embedded: boolean }) {
  const language = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  // The wide panel and the Workspace tab carry their own titles.
  const wideLayout = useLayoutClass().kind === "wide";
  const phoneHeader = !props.embedded && !wideLayout;
  const client = useRpcClient();
  const routeSessionId = props.sessionId;
  const historyStore = useMemo(() => createHistoryStore({ client }), [client]);
  const sessionsStore = useMemo(() => createSessionsStore({ client }), [client]);
  const changesStore = useMemo(() => createChangesStore({ client }), [client]);
  const [history, setHistory] = useState<HistoryState>(historyStore.get());
  const [sessions, setSessions] = useState<SessionsView>(sessionsStore.get());
  const [changes, setChanges] = useState<ChangesState>(changesStore.get());
  const [connection, setConnection] = useState(client.state());
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Fix round 2 (New Breakage 1): the route id from a session-detail link
  // is consumed once, not on every refocus — otherwise it would keep
  // overriding any session the user picks afterward for the life of this
  // screen instance. See sessionIdToReopen's doc comment.
  const consumedRouteIdRef = useRef<string | undefined>(undefined);

  // Fix round 1 (Important 2): the store's own `sessionId` survives
  // `close()` — only its subscriptions and visible data are torn down — so
  // reopening it here (or a route id from a session-detail link, once)
  // restores the session, the body and pull-to-refresh on every refocus.
  useFocusEffect(
    useCallback(() => {
      const unHistory = historyStore.subscribe(setHistory);
      const unSessions = sessionsStore.subscribe(setSessions);
      const unChanges = changesStore.subscribe(setChanges);
      const unConnection = client.onState((state) => setConnection(state));
      setConnection(client.state());
      historyStore.open();
      sessionsStore.focus();
      const toOpen = sessionIdToReopen(
        changesStore.get(),
        routeSessionId,
        consumedRouteIdRef.current,
      );
      if (routeSessionId !== undefined) consumedRouteIdRef.current = routeSessionId;
      if (toOpen !== undefined) changesStore.open(toOpen);
      setHistory(historyStore.get());
      setSessions(sessionsStore.get());
      setChanges(changesStore.get());
      return () => {
        unHistory();
        unSessions();
        unChanges();
        unConnection();
        historyStore.close();
        sessionsStore.blur();
        changesStore.close();
      };
    }, [historyStore, sessionsStore, changesStore, client, routeSessionId]),
  );

  const merged = useMemo(
    () => mergeSessions([...sessions.active, ...sessions.ended], history.sessions),
    [sessions, history.sessions],
  );
  const defaultId = useMemo(
    () =>
      defaultChangesSession(
        merged.filter(isActiveRow),
        merged.filter((row) => !isActiveRow(row)),
      ),
    [merged],
  );
  // No route id and nothing chosen yet: open the default session as soon as
  // the lists land, so the screen never sits on an empty picker.
  useEffect(() => {
    if (changes.sessionId === undefined && defaultId !== undefined) changesStore.open(defaultId);
  }, [changes.sessionId, defaultId, changesStore]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    historyStore.refresh();
    void sessionsStore.refresh();
    changesStore.refresh();
    setTimeout(() => setRefreshing(false), 250);
  }, [historyStore, sessionsStore, changesStore]);

  const selectedFiles = changes.changes?.changes.files ?? [];
  const diff = changes.diff;
  const stagedCount = selectedFiles.filter((file) => file.staged).length;
  const sessionsDisplay = historyListDisplay(history, language);
  const selectedRow = findRow(merged, changes.sessionId);
  // Fix round 2 (New Breakage 2): also gate on a session being chosen —
  // Commit/Stage previously reached the store's mutation queue with no
  // session at all, which the store now guards but the button shouldn't
  // even invite.
  const disabled = changes.busy || connection !== "open" || changes.sessionId === undefined;

  async function commit(): Promise<void> {
    await changesStore.commit(message);
    if (shouldClearDraft(changesStore.get())) setMessage("");
  }

  const subtitle =
    selectedRow === undefined
      ? undefined
      : phoneHeader && merged.length > 1
        ? `${selectedRow.summary} ▾`
        : selectedRow.summary;
  const footerBottom = phoneHeader ? (keyboardHeight > 0 ? 10 : Math.max(insets.bottom, 26)) : 10;

  return (
    <KeyboardAvoidingView
      style={[
        styles.screen,
        { paddingBottom: keyboardBottomPadding(Platform.OS, keyboardHeight, insets.bottom) },
      ]}
      behavior={keyboardAvoidingBehavior(Platform.OS)}
    >
      {phoneHeader && (
        <ScreenHeader
          title={t(language, "changes.title")}
          size="page"
          bordered={false}
          onBack={router.back}
          {...(subtitle === undefined ? {} : { subtitle })}
          {...(merged.length > 1 ? { onSubtitlePress: () => setPickerOpen(true) } : {})}
        />
      )}
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
        {!phoneHeader && merged.length > 0 && (
          <ScrollView horizontal contentContainerStyle={styles.sessionStrip}>
            {merged.map((row) => (
              <TouchableOpacity
                key={row.id}
                style={[styles.chip, changes.sessionId === row.id && styles.chipActive]}
                onPress={() => changesStore.open(row.id)}
              >
                <Text style={styles.chipText}>{row.summary}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
        {merged.length === 0 && sessionsDisplay.kind === "empty" && (
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
        {changes.uncertain && (
          <Text style={styles.warning}>{t(language, "changes.uncertain")}</Text>
        )}

        <BranchCard
          language={language}
          state={changes}
          store={changesStore}
          disabled={disabled}
          showRepoPath={!phoneHeader}
          onOpenBranches={() => setBranchesOpen(true)}
        />

        <FileList language={language} state={changes} store={changesStore} disabled={disabled} />

        {changes.changes && selectedFiles.length === 0 && (
          <Text style={styles.empty}>{t(language, "changes.clean")}</Text>
        )}

        {diff && <DiffView language={language} diff={diff} />}
      </ScrollView>
      <CommitFooter
        language={language}
        message={message}
        onChangeMessage={setMessage}
        stagedCount={stagedCount}
        disabled={disabled}
        bottomPadding={footerBottom}
        onCommit={() => {
          void commit();
        }}
      />
      <BranchSheet
        visible={branchesOpen}
        language={language}
        state={changes}
        store={changesStore}
        disabled={disabled}
        onClose={() => setBranchesOpen(false)}
      />
      <SessionPickerSheet
        visible={pickerOpen}
        rows={merged}
        selectedId={changes.sessionId}
        onSelect={(id) => changesStore.open(id)}
        onClose={() => setPickerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: 16, paddingBottom: 12, paddingTop: 4, gap: 12 },
  sessionStrip: { gap: theme.spacing.sm },
  chip: {
    minHeight: 36,
    justifyContent: "center",
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 14,
  },
  chipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  chipText: { ...theme.type.chip, color: theme.colors.text, maxWidth: 220 },
  empty: { color: theme.colors.textMuted, fontFamily: theme.font.body },
  warning: { color: theme.colors.warning, fontFamily: theme.font.body },
  error: { color: theme.colors.danger, fontFamily: theme.font.body },
  failedBlock: { gap: theme.spacing.xs },
  retry: { color: theme.colors.accentText, fontFamily: theme.font.bold },
});
