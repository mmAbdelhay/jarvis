import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ProjectTool } from "@/lib/home-wide";
import { type Language, type MessageKey, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

const TOOL_LABELS: Record<ProjectTool, MessageKey> = {
  terminal: "workspace.terminal",
  docker: "docker.title",
  api: "api.title",
  editor: "sidecars.editor",
};

/** One project, its name and a button per tool: in one row on wide Home,
 *  the name over the buttons on phone (`stacked`), where four buttons beside
 *  the name would squeeze it to nothing. */
export function ProjectToolRow(props: {
  language: Language;
  name: string;
  tools: readonly ProjectTool[];
  /** Tools that cannot run right now (the terminal while offline or busy). */
  disabled: readonly ProjectTool[];
  onTool(tool: ProjectTool): void;
  stacked?: boolean;
}) {
  const buttons = props.tools.map((tool) => {
    const disabled = props.disabled.includes(tool);
    return (
      <Pressable
        key={tool}
        accessibilityRole="button"
        disabled={disabled}
        onPress={() => props.onTool(tool)}
        style={[styles.button, disabled && styles.disabled]}
      >
        <Text style={styles.buttonText}>{t(props.language, TOOL_LABELS[tool])}</Text>
      </Pressable>
    );
  });
  const name = (
    <Text style={[styles.name, props.stacked === true && styles.nameStacked]} numberOfLines={1}>
      {props.name}
    </Text>
  );
  if (props.stacked === true)
    return (
      <View style={[styles.row, styles.stacked]}>
        {name}
        <View style={styles.buttons}>{buttons}</View>
      </View>
    );
  return (
    <View style={styles.row}>
      {name}
      {buttons}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
  },
  stacked: { flexDirection: "column", alignItems: "stretch" },
  // In a column, the row's flex: 1 would stretch the name's height instead.
  nameStacked: { flex: 0 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  name: { flex: 1, minWidth: 0, ...theme.type.rowTitle, color: theme.colors.text },
  button: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: theme.radius.chip,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  buttonText: { color: theme.colors.textSecondary, fontFamily: theme.font.bold, fontSize: 12 },
  disabled: { opacity: 0.5 },
});
