import { useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type { ChangesState, ChangesStore } from "@/lib/changes-store";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** The branch menu: switch to a local branch, create one, or remove the
 *  session's own worktree. Each action closes the sheet first. */
export function BranchSheet(props: {
  visible: boolean;
  language: Language;
  state: ChangesState;
  store: ChangesStore;
  disabled: boolean;
  onClose(): void;
}) {
  const { language, state, store, disabled } = props;
  const [newBranch, setNewBranch] = useState("");
  const branches = state.branches;
  const blankName = newBranch.trim() === "";
  return (
    <Modal transparent animationType="slide" visible={props.visible} onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          style={styles.backdrop}
          accessibilityLabel={t(language, "common.cancel")}
          onPress={props.onClose}
        >
          <Pressable style={styles.sheet} accessible={false}>
            <View style={styles.grabber} />
            <Text style={styles.title}>{t(language, "changes.branches")}</Text>
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {branches?.local.map((branch) => {
                const current = !branches.detached && branches.current === branch;
                return (
                  <TouchableOpacity
                    key={branch}
                    disabled={disabled || current}
                    accessibilityRole="button"
                    accessibilityState={{ selected: current }}
                    style={[styles.row, current && styles.rowCurrent]}
                    onPress={() => {
                      props.onClose();
                      void store.switchBranch(branch, false);
                    }}
                  >
                    <Text style={styles.branchName} numberOfLines={1}>
                      {branch}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              <View style={styles.createRow}>
                <TextInput
                  style={styles.input}
                  value={newBranch}
                  onChangeText={setNewBranch}
                  placeholder={t(language, "changes.newBranchPlaceholder")}
                  placeholderTextColor={theme.colors.textDim}
                  accessibilityLabel={t(language, "changes.newBranchPlaceholder")}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  disabled={disabled || blankName}
                  accessibilityRole="button"
                  style={[styles.button, (disabled || blankName) && styles.disabled]}
                  onPress={() => {
                    const name = newBranch.trim();
                    props.onClose();
                    setNewBranch("");
                    void store.switchBranch(name, true);
                  }}
                >
                  <Text style={styles.buttonText}>{t(language, "changes.createBranch")}</Text>
                </TouchableOpacity>
              </View>
              {state.worktree && (
                <TouchableOpacity
                  disabled={disabled}
                  accessibilityRole="button"
                  style={[styles.row, disabled && styles.disabled]}
                  onPress={() => {
                    props.onClose();
                    void store.removeWorktree();
                  }}
                >
                  <Text style={styles.removeText}>{t(language, "changes.removeWorktree")}</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    maxHeight: "80%",
    backgroundColor: theme.colors.ground,
    borderTopStartRadius: theme.radius.sheet,
    borderTopEndRadius: theme.radius.sheet,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingBottom: theme.spacing.lg,
  },
  grabber: {
    width: 40,
    height: 5,
    alignSelf: "center",
    marginTop: 8,
    borderRadius: 3,
    backgroundColor: theme.colors.handle,
  },
  title: {
    ...theme.type.headerTitle,
    color: theme.colors.text,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  list: { flexGrow: 0 },
  listContent: { padding: 16, gap: 8 },
  row: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  rowCurrent: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  branchName: { ...theme.type.mono, fontSize: 13, color: theme.colors.text },
  createRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    flex: 1,
    minHeight: 46,
    paddingHorizontal: 12,
    color: theme.colors.text,
    fontFamily: theme.font.mono,
    fontSize: 13,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  button: {
    minHeight: 46,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  buttonText: { ...theme.type.chip, color: theme.colors.textSecondary },
  removeText: { ...theme.type.rowTitle, color: theme.colors.dangerText },
  disabled: { opacity: 0.45 },
});
