import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import {
  doneText,
  failedText,
  noticeText,
  sessionIdToReopen,
  shouldClearDraft,
  trackingText,
} from "@/lib/changes-screen";
import { createChangesStore, ENDED_SESSION_NOTICE, type ChangesState } from "@/lib/changes-store";
import { historyListDisplay } from "@/lib/history-screen";
import { createHistoryStore, type HistoryState } from "@/lib/history-store";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { useLayoutClass } from "@/lib/use-layout-class";
import { theme } from "@/lib/theme";

/** Each status letter's badge colours: added green, deleted red, modified
 *  and renamed blue, conflicted amber, untracked grey. */
const STATUS_TONES: Record<string, { text: string; ground: string }> = {
  A: { text: theme.colors.success, ground: theme.colors.successSurface },
  M: { text: theme.colors.accentText, ground: theme.colors.accentSoft },
  R: { text: theme.colors.accentText, ground: theme.colors.accentSoft },
  C: { text: theme.colors.accentText, ground: theme.colors.accentSoft },
  D: { text: theme.colors.danger, ground: theme.colors.dangerSurface },
  U: { text: theme.colors.warning, ground: theme.colors.warningSurface },
  "?": { text: theme.colors.textMuted, ground: theme.colors.surfaceAlt },
};

/** Git changes: the full-screen `/changes` route on a phone (with the
 *  session a detail link names), or an inline Workspace tab on a wide
 *  screen. The screen has no header of its own, so `embedded` changes
 *  nothing it draws today. */
export function ChangesScreen(props: { sessionId: string | undefined; embedded: boolean }) {
  const language = useLanguage();
  const router = useRouter();
  // The wide panel and the Workspace tab carry their own titles.
  const wideLayout = useLayoutClass().kind === "wide";
  const phoneHeader = !props.embedded && !wideLayout;
  const client = useRpcClient();
  const routeSessionId = props.sessionId;
  const historyStore = useMemo(() => createHistoryStore({ client }), [client]);
  const changesStore = useMemo(() => createChangesStore({ client }), [client]);
  const [history, setHistory] = useState<HistoryState>(historyStore.get());
  const [changes, setChanges] = useState<ChangesState>(changesStore.get());
  const [connection, setConnection] = useState(client.state());
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [branchesOpen, setBranchesOpen] = useState(false);
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
  const stagedCount = selectedFiles.filter((file) => file.staged).length;
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
    <View style={styles.screen}>
      {phoneHeader && (
        <ScreenHeader title={t(language, "changes.title")} size="page" onBack={router.back} />
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
        <Text style={styles.sectionTitle}>{t(language, "changes.sessions")}</Text>
        <ScrollView horizontal contentContainerStyle={styles.sessionStrip}>
          {history.sessions.map((session) => (
            <TouchableOpacity
              key={session.id}
              style={[
                styles.chip,
                changes.sessionId === session.id ? styles.chipActive : undefined,
              ]}
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
        {changes.uncertain && (
          <Text style={styles.warning}>{t(language, "changes.uncertain")}</Text>
        )}

        {changes.changes && (
          <View style={styles.card}>
            <View style={styles.cardTop}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t(language, "changes.branches")}
                accessibilityState={{ expanded: branchesOpen }}
                disabled={changes.branches === undefined}
                onPress={() => setBranchesOpen((open) => !open)}
                style={styles.branchButton}
              >
                <Text style={styles.branchText} numberOfLines={1}>
                  {changes.changes.changes.detached ? "HEAD" : changes.changes.changes.branch}
                  {changes.branches !== undefined && (branchesOpen ? " ▴" : " ▾")}
                </Text>
              </TouchableOpacity>
              <Text
                selectable
                style={[styles.tracking, { writingDirection: "ltr" }]}
                numberOfLines={1}
              >
                {trackingText(changes, language)}
              </Text>
            </View>
            <Text selectable style={styles.repoPath} numberOfLines={1}>
              {changes.changes.changes.repoPath}
            </Text>
            <View style={styles.syncGrid}>
              {(
                [
                  ["changes.pull", () => changesStore.pull(), false],
                  ["changes.push", () => changesStore.push(), false],
                  ["changes.pullRequest", () => changesStore.pullRequest(), true],
                ] as const
              ).map(([key, run, primary]) => (
                <TouchableOpacity
                  key={key}
                  disabled={disabled}
                  accessibilityRole="button"
                  style={[
                    styles.syncButton,
                    primary && styles.syncPrimary,
                    disabled ? styles.buttonDisabled : undefined,
                  ]}
                  onPress={() => {
                    void run();
                  }}
                >
                  <Text style={[styles.syncText, primary && styles.syncPrimaryText]}>
                    {t(language, key)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {branchesOpen && changes.branches && (
              <View style={styles.branches}>
                <ScrollView horizontal contentContainerStyle={styles.sessionStrip}>
                  {changes.branches.local.map((branch) => {
                    const current =
                      !changes.branches?.detached && changes.branches?.current === branch;
                    return (
                      <TouchableOpacity
                        key={branch}
                        disabled={disabled || current}
                        accessibilityRole="button"
                        accessibilityState={{ selected: current }}
                        style={[styles.chip, current ? styles.chipActive : undefined]}
                        onPress={() => {
                          void changesStore.switchBranch(branch, false);
                        }}
                      >
                        <Text style={styles.chipMono}>{branch}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <View style={styles.actionRow}>
                  <TextInput
                    style={styles.branchInput}
                    value={newBranch}
                    onChangeText={setNewBranch}
                    placeholder={t(language, "changes.newBranchPlaceholder")}
                    placeholderTextColor={theme.colors.textDim}
                    accessibilityLabel={t(language, "changes.newBranchPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity
                    disabled={disabled || newBranch.trim() === ""}
                    accessibilityRole="button"
                    style={[
                      styles.smallButton,
                      disabled || newBranch.trim() === "" ? styles.buttonDisabled : undefined,
                    ]}
                    onPress={() => {
                      const name = newBranch.trim();
                      void changesStore.switchBranch(name, true).then(() => {
                        if (changesStore.get().done?.kind === "switched") setNewBranch("");
                      });
                    }}
                  >
                    <Text style={styles.buttonText}>{t(language, "changes.createBranch")}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            {changes.worktree && (
              <View style={styles.worktreeRow}>
                <Text selectable style={styles.meta}>
                  {t(language, "changes.worktree")}
                </Text>
                <View style={styles.actionRow}>
                  {changes.worktree.baseBranch !== "" && (
                    <TouchableOpacity
                      disabled={disabled}
                      accessibilityRole="button"
                      style={[styles.smallButton, disabled ? styles.buttonDisabled : undefined]}
                      onPress={() => {
                        void changesStore.mergeWorktree();
                      }}
                    >
                      <Text style={styles.linkButtonText}>
                        {t(language, "changes.mergeInto", { branch: changes.worktree.baseBranch })}
                      </Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    disabled={disabled}
                    accessibilityRole="button"
                    style={[styles.smallButton, disabled ? styles.buttonDisabled : undefined]}
                    onPress={() => {
                      void changesStore.removeWorktree();
                    }}
                  >
                    <Text style={styles.buttonText}>{t(language, "changes.removeWorktree")}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
            {changes.done && (
              <Text style={styles.success}>
                {doneText(changes.done, language)}
                {changes.done.kind === "pullRequest" && " "}
                {changes.done.kind === "pullRequest" && (
                  <Text
                    style={styles.link}
                    onPress={() => {
                      if (changes.done?.kind === "pullRequest") {
                        void Linking.openURL(changes.done.url).catch(() => undefined);
                      }
                    }}
                  >
                    {changes.done.url}
                  </Text>
                )}
              </Text>
            )}
          </View>
        )}

        {selectedFiles.length > 0 && changes.changes && (
          <View style={styles.filesSection}>
            <Text style={styles.filesTitle}>
              {t(language, "changes.fileCount", { count: selectedFiles.length })} ·{" "}
              <Text style={styles.added}>+{changes.changes.changes.insertions}</Text>{" "}
              <Text style={styles.removed}>−{changes.changes.changes.deletions}</Text>
            </Text>
            <View style={styles.fileList}>
              {selectedFiles.map((file, index) => {
                const tone = STATUS_TONES[file.status] ?? STATUS_TONES["?"];
                const open = diff?.path === file.path;
                return (
                  <View
                    key={file.path}
                    style={[
                      styles.fileRow,
                      index > 0 && styles.fileRowDivider,
                      open && styles.fileRowOpen,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusBadge,
                        { color: tone.text, backgroundColor: tone.ground },
                      ]}
                    >
                      {file.status}
                    </Text>
                    <TouchableOpacity
                      style={styles.fileName}
                      accessibilityRole="button"
                      onPress={() => changesStore.selectFile(file.path)}
                    >
                      <Text selectable style={styles.path} numberOfLines={1}>
                        {file.path}
                      </Text>
                      <Text style={styles.meta}>
                        <Text style={styles.added}>+{file.insertions}</Text>{" "}
                        <Text style={styles.removed}>−{file.deletions}</Text>
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      disabled={disabled}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: file.staged, disabled }}
                      accessibilityLabel={
                        file.staged ? t(language, "changes.unstage") : t(language, "changes.stage")
                      }
                      style={[
                        styles.stageButton,
                        file.staged && styles.stageButtonOn,
                        disabled ? styles.buttonDisabled : undefined,
                      ]}
                      onPress={() => {
                        void changesStore.setStaged(file.path, !file.staged);
                      }}
                    >
                      <Text style={[styles.stageText, file.staged && styles.stageTextOn]}>
                        {file.staged
                          ? `✓ ${t(language, "changes.staged")}`
                          : t(language, "changes.stage")}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
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

        <View style={styles.commitRow}>
          <TextInput
            style={styles.input}
            value={message}
            onChangeText={setMessage}
            placeholder={t(language, "changes.commitPlaceholder")}
            placeholderTextColor={theme.colors.textDim}
            accessibilityLabel={t(language, "changes.commitPlaceholder")}
            multiline
          />
          <TouchableOpacity
            disabled={disabled || message.trim() === ""}
            accessibilityRole="button"
            style={[
              styles.button,
              disabled || message.trim() === "" ? styles.buttonDisabled : undefined,
            ]}
            onPress={() => {
              void commit();
            }}
          >
            <Text style={styles.primaryButtonText}>
              {stagedCount > 0
                ? t(language, "changes.commitCount", { count: stagedCount })
                : t(language, "changes.commit")}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  sectionTitle: {
    color: theme.colors.text,
    fontFamily: theme.font.bold,
    fontSize: theme.font.size.lg,
  },
  sessionStrip: { gap: theme.spacing.sm },
  chip: {
    minHeight: 36,
    justifyContent: "center",
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
  },
  chipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  chipText: {
    color: theme.colors.text,
    fontFamily: theme.font.semibold,
    fontSize: 13,
    maxWidth: 220,
  },
  chipMono: { color: theme.colors.text, fontFamily: theme.font.mono, fontSize: 12 },
  empty: { color: theme.colors.textMuted, fontFamily: theme.font.body },
  warning: { color: theme.colors.warning, fontFamily: theme.font.body },
  error: { color: theme.colors.danger, fontFamily: theme.font.body },
  failedBlock: { gap: theme.spacing.xs },
  retry: { color: theme.colors.accentText, fontFamily: theme.font.bold },
  card: {
    gap: 10,
    padding: 12,
    borderRadius: theme.radius.card + 2,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  branchButton: {
    flexShrink: 1,
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  branchText: { color: theme.colors.text, fontFamily: theme.font.mono, fontSize: 13 },
  tracking: {
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontFamily: theme.font.mono,
    fontSize: 12,
  },
  repoPath: { color: theme.colors.textDim, fontFamily: theme.font.mono, fontSize: 11 },
  syncGrid: { flexDirection: "row", gap: 8 },
  syncButton: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  syncPrimary: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  syncText: { color: theme.colors.textSecondary, fontFamily: theme.font.bold, fontSize: 13 },
  syncPrimaryText: { color: theme.colors.primaryText },
  branches: { gap: 8 },
  worktreeRow: {
    gap: 8,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairline,
  },
  meta: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.body,
    fontSize: theme.font.size.sm,
  },
  filesSection: { gap: 6 },
  filesTitle: {
    color: theme.colors.textDim,
    fontFamily: theme.font.bold,
    fontSize: 12,
    letterSpacing: 0.6,
  },
  fileList: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    overflow: "hidden",
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  fileRowDivider: { borderTopWidth: 1, borderTopColor: theme.colors.hairlineSoft },
  fileRowOpen: { backgroundColor: theme.colors.surfaceAlt },
  statusBadge: {
    width: 22,
    height: 22,
    borderRadius: 6,
    overflow: "hidden",
    textAlign: "center",
    lineHeight: 22,
    fontFamily: theme.font.monoSemibold,
    fontSize: 11,
  },
  fileName: { flex: 1, minHeight: 40, justifyContent: "center", gap: 2 },
  path: { color: theme.colors.text, fontFamily: theme.font.mono, fontSize: 12 },
  stageButton: {
    minHeight: 34,
    minWidth: 76,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  stageButtonOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  stageText: { color: theme.colors.textSecondary, fontFamily: theme.font.semibold, fontSize: 12 },
  stageTextOn: { color: theme.colors.accentText, fontFamily: theme.font.bold },
  smallButton: {
    minHeight: 36,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  buttonText: { color: theme.colors.textSecondary, fontFamily: theme.font.semibold, fontSize: 13 },
  linkButtonText: { color: theme.colors.accentText, fontFamily: theme.font.bold, fontSize: 13 },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  branchInput: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 12,
    color: theme.colors.text,
    fontFamily: theme.font.mono,
    fontSize: 13,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  success: { color: theme.colors.success, fontFamily: theme.font.semibold },
  link: { color: theme.colors.accentText, textDecorationLine: "underline" },
  diffBlock: {
    gap: theme.spacing.sm,
    padding: 10,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.terminalGround,
  },
  // Fix round 1 (Important 4): forced LTR, like the terminal
  // (TerminalWebView.tsx) and key bar (KeyBar.tsx) — a unified diff's
  // +/-, padded line numbers and monospace content must not be bidi
  // reordered under the Arabic UI, even when the changed lines themselves
  // contain Arabic text (constraint 7: real RTL stays outside code/
  // terminal/diff content).
  diffContent: { minWidth: 720, gap: theme.spacing.md, direction: "ltr" },
  hunk: { gap: 0 },
  hunkHeader: { color: theme.colors.accentText, fontFamily: theme.font.mono, fontSize: 12 },
  diffLine: {
    color: theme.colors.textSecondary,
    fontFamily: theme.font.mono,
    fontSize: 12,
    lineHeight: 19,
  },
  added: { color: theme.colors.success },
  removed: { color: theme.colors.danger },
  commitRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 120,
    color: theme.colors.text,
    fontFamily: theme.font.body,
    fontSize: 15,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: theme.colors.surface,
    textAlignVertical: "top",
  },
  button: {
    minHeight: 46,
    paddingHorizontal: 16,
    justifyContent: "center",
    backgroundColor: theme.colors.success,
    borderRadius: theme.radius.card,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.45 },
  primaryButtonText: { color: theme.colors.ground, fontFamily: theme.font.bold, fontSize: 14 },
});
