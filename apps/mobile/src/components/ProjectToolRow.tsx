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

/** Wide Home: one project, its name and a button per tool. */
export function ProjectToolRow(props: {
  language: Language;
  name: string;
  tools: readonly ProjectTool[];
  /** Tools that cannot run right now (the terminal while offline or busy). */
  disabled: readonly ProjectTool[];
  onTool(tool: ProjectTool): void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.name} numberOfLines={1}>
        {props.name}
      </Text>
      {props.tools.map((tool) => {
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
      })}
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
