import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Icon } from "@/components/Icon";
import { stageAllTargets } from "@/lib/changes-screen";
import type { ChangesState, ChangesStore } from "@/lib/changes-store";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** Each status letter's badge colours: added green, deleted red, modified
 *  and renamed blue, conflicted amber, untracked grey. */
const STATUS_TONES: Record<string, { text: string; ground: string }> = {
  A: { text: theme.colors.success, ground: theme.colors.successSurface },
  M: { text: theme.colors.accentText, ground: theme.colors.accentSoft },
  R: { text: theme.colors.accentText, ground: theme.colors.accentSoft },
  C: { text: theme.colors.accentText, ground: theme.colors.accentSoft },
  D: { text: theme.colors.dangerText, ground: theme.colors.dangerSurface },
  U: { text: theme.colors.warning, ground: theme.colors.warningSurface },
  "?": { text: theme.colors.textMuted, ground: theme.colors.surfaceAlt },
};

/** The changed files: a count line with Stage all, then one row per file
 *  with its status badge, path and stage checkbox. */
export function FileList(props: {
  language: Language;
  state: ChangesState;
  store: ChangesStore;
  disabled: boolean;
}) {
  const { language, state, store, disabled } = props;
  const view = state.changes?.changes;
  const files = view?.files ?? [];
  if (view === undefined || files.length === 0) return null;
  const all = stageAllTargets(files);
  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.title}>
          {t(language, "changes.fileCount", { count: files.length })} ·{" "}
          <Text style={styles.added}>+{view.insertions}</Text>{" "}
          <Text style={styles.removed}>−{view.deletions}</Text>
        </Text>
        <TouchableOpacity
          disabled={disabled}
          accessibilityRole="button"
          style={[styles.stageAll, disabled && styles.disabled]}
          onPress={() => {
            for (const path of all.paths) void store.setStaged(path, all.staged);
          }}
        >
          <Text style={styles.stageAllText}>
            {t(language, all.staged ? "changes.stageAll" : "changes.unstageAll")}
          </Text>
        </TouchableOpacity>
      </View>
      <View style={styles.list}>
        {files.map((file, index) => {
          const tone = STATUS_TONES[file.status] ?? STATUS_TONES["?"];
          const open = state.diff?.path === file.path;
          return (
            <View
              key={file.path}
              style={[styles.row, index > 0 && styles.divider, open && styles.rowOpen]}
            >
              <Text style={[styles.badge, { color: tone.text, backgroundColor: tone.ground }]}>
                {file.status}
              </Text>
              <TouchableOpacity
                style={styles.name}
                accessibilityRole="button"
                onPress={() => store.selectFile(file.path)}
              >
                <Text selectable style={styles.path} numberOfLines={1}>
                  {file.path}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={disabled}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: file.staged, disabled }}
                accessibilityLabel={
                  file.staged ? t(language, "changes.unstage") : t(language, "changes.stage")
                }
                hitSlop={12}
                style={[styles.box, file.staged && styles.boxOn, disabled && styles.disabled]}
                onPress={() => {
                  void store.setStaged(file.path, !file.staged);
                }}
              >
                {file.staged && (
                  <Icon name="check" size={14} color={theme.colors.primaryText} strokeWidth={3.4} />
                )}
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 6 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  title: { ...theme.type.sectionLabel, flexShrink: 1, color: theme.colors.textDim },
  stageAll: { minHeight: 32, justifyContent: "center" },
  stageAllText: { ...theme.type.sectionLabelLarge, letterSpacing: 0, color: theme.colors.link },
  added: { color: theme.colors.success },
  removed: { color: theme.colors.dangerText },
  list: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  divider: { borderTopWidth: 1, borderTopColor: theme.colors.hairlineSoft },
  rowOpen: { backgroundColor: theme.colors.surfaceAlt },
  badge: {
    width: 22,
    height: 22,
    borderRadius: theme.radius.tiny,
    overflow: "hidden",
    textAlign: "center",
    lineHeight: 22,
    fontFamily: theme.font.monoSemibold,
    fontSize: 11,
  },
  name: { flex: 1, minHeight: 24, justifyContent: "center" },
  path: { ...theme.type.mono, color: theme.colors.text },
  box: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: theme.colors.checkboxOff,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
  disabled: { opacity: 0.45 },
});
