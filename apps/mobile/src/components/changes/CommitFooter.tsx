import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { commitFilesLabel } from "@/lib/changes-screen";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/** The commit message and button, pinned under the scrolling content. */
export function CommitFooter(props: {
  language: Language;
  message: string;
  onChangeMessage(message: string): void;
  stagedCount: number;
  disabled: boolean;
  bottomPadding: number;
  /** "column" (wide split): a labelled 3-row box and a full-width button at
   *  the column's bottom, not a footer row. */
  variant?: "footer" | "column";
  onCommit(): void;
}) {
  const { language } = props;
  const off = props.disabled || props.message.trim() === "";
  if (props.variant === "column") {
    return (
      <View style={styles.column}>
        <Text style={styles.columnLabel}>{t(language, "changes.commitMessage")}</Text>
        <TextInput
          style={styles.columnInput}
          value={props.message}
          onChangeText={props.onChangeMessage}
          accessibilityLabel={t(language, "changes.commitMessage")}
          multiline
          numberOfLines={3}
        />
        <TouchableOpacity
          disabled={off}
          accessibilityRole="button"
          style={[styles.columnButton, off && styles.disabled]}
          onPress={props.onCommit}
        >
          <Text style={styles.columnButtonText}>
            {commitFilesLabel(props.stagedCount, language)}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <View style={[styles.footer, { paddingBottom: props.bottomPadding }]}>
      <TextInput
        style={styles.input}
        value={props.message}
        onChangeText={props.onChangeMessage}
        placeholder={t(language, "changes.commitPlaceholder")}
        placeholderTextColor={theme.colors.textDim}
        accessibilityLabel={t(language, "changes.commitPlaceholder")}
        multiline
      />
      <TouchableOpacity
        disabled={off}
        accessibilityRole="button"
        style={[styles.button, off && styles.disabled]}
        onPress={props.onCommit}
      >
        <Text style={styles.buttonText}>
          {props.stagedCount > 0
            ? t(language, "changes.commitCount", { count: props.stagedCount })
            : t(language, "changes.commit")}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.surfaceDim,
  },
  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 120,
    color: theme.colors.text,
    fontFamily: theme.font.body,
    fontSize: 15,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: theme.colors.surface,
    textAlignVertical: "top",
  },
  button: {
    minHeight: 46,
    paddingHorizontal: 16,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: theme.colors.success,
    borderRadius: theme.radius.lg,
  },
  buttonText: { ...theme.type.buttonStrong, color: theme.colors.onSuccess },
  disabled: { opacity: 0.45 },
  column: { gap: 6 },
  columnLabel: { fontFamily: theme.font.body, fontSize: 12, color: theme.colors.textMuted },
  columnInput: {
    minHeight: 84,
    color: theme.colors.text,
    fontFamily: theme.font.body,
    fontSize: 14,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: 10,
    backgroundColor: theme.colors.surface,
    textAlignVertical: "top",
  },
  columnButton: {
    minHeight: 42,
    marginTop: 6,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: theme.colors.success,
    borderRadius: theme.radius.md,
  },
  columnButtonText: { ...theme.type.buttonStrong, color: theme.colors.onSuccess },
});
