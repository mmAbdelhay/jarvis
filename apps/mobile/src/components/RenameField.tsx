import { useState } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { t, type Language, type MessageKey } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/**
 * An inline rename box: a text field with Save and Cancel. The caller says
 * what is wrong with a draft (`problem`) and what a failed save said
 * (`error`); this only draws and gathers the text.
 */
export function RenameField(props: {
  language: Language;
  initial: string;
  label: string;
  problem(draft: string): MessageKey | undefined;
  /** A failure from the laptop, already translated. */
  error?: string | undefined;
  busy?: boolean;
  onSubmit(draft: string): void;
  onCancel(): void;
}) {
  const { language } = props;
  const [draft, setDraft] = useState(props.initial);
  const problem = props.problem(draft);
  return (
    <View style={styles.box}>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        accessibilityLabel={props.label}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        editable={props.busy !== true}
        onSubmitEditing={() => problem === undefined && props.onSubmit(draft)}
        style={styles.input}
      />
      {problem !== undefined && <Text style={styles.error}>{t(language, problem)}</Text>}
      {props.error !== undefined && (
        <Text selectable style={styles.error}>
          {props.error}
        </Text>
      )}
      <View style={styles.buttons}>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={problem !== undefined || props.busy === true}
          onPress={() => props.onSubmit(draft)}
          style={[styles.save, (problem !== undefined || props.busy === true) && styles.dim]}
        >
          <Text style={styles.saveText}>{t(language, "rename.save")}</Text>
        </TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" onPress={props.onCancel} style={styles.cancel}>
          <Text style={styles.cancelText}>{t(language, "common.cancel")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 6, paddingVertical: 6 },
  input: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    fontFamily: theme.font.body,
    fontSize: 14,
  },
  error: { color: theme.colors.danger, fontFamily: theme.font.body, fontSize: 12 },
  buttons: { flexDirection: "row", gap: 8 },
  save: {
    minHeight: 36,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: theme.colors.accentSoft,
  },
  saveText: { color: theme.colors.accentText, fontFamily: theme.font.bold, fontSize: 13 },
  cancel: { minHeight: 36, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  cancelText: { color: theme.colors.textMuted, fontFamily: theme.font.semibold, fontSize: 13 },
  dim: { opacity: 0.5 },
});
