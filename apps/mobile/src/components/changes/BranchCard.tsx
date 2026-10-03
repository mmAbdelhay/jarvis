import { Linking, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Icon } from "@/components/Icon";
import { doneText, pushLabel, trackingParts } from "@/lib/changes-screen";
import type { ChangesState, ChangesStore } from "@/lib/changes-store";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** The branch, its tracking line, the sync buttons and (for a session in
 *  its own worktree) the merge row. The branch button opens the branch sheet. */
export function BranchCard(props: {
  language: Language;
  state: ChangesState;
  store: ChangesStore;
  disabled: boolean;
  showRepoPath: boolean;
  onOpenBranches(): void;
}) {
  const { language, state, store, disabled } = props;
  const changes = state.changes?.changes;
  if (changes === undefined) return null;
  const tracking = trackingParts(state);
  const worktree = state.worktree;
  const branchName = changes.detached ? "HEAD" : changes.branch;
  const buttons = [
    { key: "pull", label: t(language, "changes.pull"), run: () => store.pull(), primary: false },
    {
      key: "push",
      label: pushLabel(changes.ahead, language),
      run: () => store.push(),
      primary: false,
    },
    {
      key: "pr",
      label: t(language, "changes.openPr"),
      run: () => store.pullRequest(),
      primary: true,
    },
  ];
  return (
    <View style={styles.card}>
      <View style={styles.top}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={t(language, "changes.branches")}
          accessibilityHint={changes.repoPath}
          disabled={state.branches === undefined}
          onPress={props.onOpenBranches}
          style={styles.branchButton}
        >
          <Icon name="branch" size={14} color={theme.colors.textMuted} />
          <Text style={styles.branchText} numberOfLines={1}>
            {branchName}
            {state.branches !== undefined && " ▾"}
          </Text>
        </TouchableOpacity>
        {tracking !== undefined && (
          <Text selectable style={[styles.tracking, { writingDirection: "ltr" }]} numberOfLines={1}>
            {tracking.kind === "none" ? (
              t(language, "changes.noUpstream")
            ) : (
              <>
                {tracking.upstream} <Text style={styles.ahead}>↑{tracking.ahead}</Text>{" "}
                <Text style={styles.behind}>↓{tracking.behind}</Text>
              </>
            )}
          </Text>
        )}
      </View>
      {props.showRepoPath && (
        <Text selectable style={styles.repoPath} numberOfLines={1}>
          {changes.repoPath}
        </Text>
      )}
      <View style={styles.syncGrid}>
        {buttons.map((button) => (
          <TouchableOpacity
            key={button.key}
            disabled={disabled}
            accessibilityRole="button"
            style={[
              styles.syncButton,
              button.primary && styles.syncPrimary,
              disabled && styles.disabled,
            ]}
            onPress={() => {
              void button.run();
            }}
          >
            <Text style={[styles.syncText, button.primary && styles.syncPrimaryText]}>
              {button.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {worktree && (
        <View style={styles.worktreeRow}>
          <Text selectable style={styles.meta} numberOfLines={2}>
            {t(language, "changes.worktree")}
            {worktree.baseBranch !== "" && (
              <>
                {" · "}
                {t(language, "changes.base")} <Text style={styles.mono}>{worktree.baseBranch}</Text>
              </>
            )}
          </Text>
          {worktree.baseBranch !== "" && (
            <TouchableOpacity
              disabled={disabled}
              accessibilityRole="button"
              style={[styles.mergeButton, disabled && styles.disabled]}
              onPress={() => {
                void store.mergeWorktree();
              }}
            >
              <Text style={styles.mergeText}>
                {t(language, "changes.mergeInto", { branch: worktree.baseBranch })}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {state.done && (
        <Text style={styles.success}>
          {doneText(state.done, language)}
          {state.done.kind === "pullRequest" && " "}
          {state.done.kind === "pullRequest" && (
            <Text
              style={styles.link}
              onPress={() => {
                if (state.done?.kind === "pullRequest") {
                  void Linking.openURL(state.done.url).catch(() => undefined);
                }
              }}
            >
              {state.done.url}
            </Text>
          )}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 10,
    padding: 12,
    borderRadius: theme.radius.card16,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  branchButton: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  branchText: { ...theme.type.mono, fontSize: 13, color: theme.colors.text, flexShrink: 1 },
  tracking: { ...theme.type.mono, flexShrink: 1, color: theme.colors.textMuted },
  ahead: { color: theme.colors.accent },
  behind: { color: theme.colors.warning },
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
  syncPrimary: { borderWidth: 0, backgroundColor: theme.colors.accent },
  syncText: { ...theme.type.chipSelected, color: theme.colors.textSecondary },
  syncPrimaryText: { color: theme.colors.primaryText },
  worktreeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairline,
  },
  meta: { ...theme.type.meta, flex: 1, color: theme.colors.textMuted },
  mono: { fontFamily: theme.font.mono, color: theme.colors.textSecondary },
  mergeButton: {
    minHeight: 36,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  mergeText: { ...theme.type.meta, fontFamily: theme.font.bold, color: theme.colors.link },
  success: { color: theme.colors.success, fontFamily: theme.font.semibold },
  link: { color: theme.colors.accentText, textDecorationLine: "underline" },
  disabled: { opacity: 0.45 },
});
