import type { GitFileChange } from "@jarvis/core";
import type React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { groupFiles, stageGroupTargets, unstageAllTargets } from "@/lib/changes-screen";
import type { ChangesState, ChangesStore } from "@/lib/changes-store";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

const STATUS_COLORS: Record<string, string> = {
  A: theme.colors.success,
  M: theme.colors.accentText,
  R: theme.colors.accentText,
  C: theme.colors.accentText,
  D: theme.colors.dangerText,
  U: theme.colors.warning,
  "?": theme.colors.textMuted,
};

/** Wide Changes' file lists: "STAGED n" and "NOT STAGED n", each with its
 *  group button. Tapping a row selects its diff; the status letter toggles
 *  that one file's staging. */
export function FileGroups(props: {
  language: Language;
  state: ChangesState;
  store: ChangesStore;
  disabled: boolean;
}) {
  const { language, state, store, disabled } = props;
  const files = state.changes?.changes.files ?? [];
  const groups = groupFiles(files);
  const section = (
    list: GitFileChange[],
    label: string,
    action: string,
    run: () => void,
  ): React.JSX.Element | null =>
    list.length === 0 ? null : (
      <View style={styles.section}>
        <View style={styles.header}>
          <Text style={styles.label}>{label}</Text>
          <TouchableOpacity
            disabled={disabled}
            accessibilityRole="button"
            style={disabled ? styles.disabled : undefined}
            onPress={run}
          >
            <Text style={styles.action}>{action}</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.list}>
          {list.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              language={language}
              open={state.diff?.path === file.path}
              disabled={disabled}
              store={store}
            />
          ))}
        </View>
      </View>
    );
  return (
    <View style={styles.sections}>
      {section(
        groups.staged,
        t(language, "changes.stagedCount", { count: groups.staged.length }),
        t(language, "changes.unstageAll"),
        () => {
          for (const path of unstageAllTargets(files)) void store.setStaged(path, false);
        },
      )}
      {section(
        groups.unstaged,
        t(language, "changes.notStaged", { count: groups.unstaged.length }),
        t(language, "changes.stageAll"),
        () => {
          for (const path of stageGroupTargets(files)) void store.setStaged(path, true);
        },
      )}
    </View>
  );
}

function FileRow(props: {
  file: GitFileChange;
  language: Language;
  open: boolean;
  disabled: boolean;
  store: ChangesStore;
}) {
  const { file, language, open, disabled, store } = props;
  return (
    <View style={[styles.row, open && styles.rowOpen]}>
      <TouchableOpacity
        disabled={disabled}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: file.staged, disabled }}
        accessibilityLabel={
          file.staged ? t(language, "changes.unstage") : t(language, "changes.stage")
        }
        hitSlop={8}
        onPress={() => {
          void store.setStaged(file.path, !file.staged);
        }}
      >
        <Text
          style={[styles.status, { color: STATUS_COLORS[file.status] ?? theme.colors.textMuted }]}
        >
          {file.status}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.name}
        accessibilityRole="button"
        onPress={() => store.selectFile(file.path)}
      >
        <Text selectable style={styles.path} numberOfLines={1}>
          {file.path}
        </Text>
      </TouchableOpacity>
      {file.insertions > 0 && <Text style={styles.added}>+{file.insertions}</Text>}
      {file.deletions > 0 && <Text style={styles.removed}>−{file.deletions}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  sections: { gap: 14 },
  section: { gap: 14 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  label: { ...theme.type.sectionLabel, color: theme.colors.textDim },
  action: { fontFamily: theme.font.bold, fontSize: 12, color: theme.colors.link },
  list: { gap: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: theme.radius.chip,
  },
  rowOpen: { backgroundColor: theme.colors.accentSoft },
  status: { ...theme.type.mono, minWidth: 12 },
  name: { flex: 1, minHeight: 16, justifyContent: "center" },
  path: { ...theme.type.mono, color: theme.colors.text },
  added: { ...theme.type.mono, color: theme.colors.success },
  removed: { ...theme.type.mono, color: theme.colors.dangerText },
  disabled: { opacity: 0.45 },
});
