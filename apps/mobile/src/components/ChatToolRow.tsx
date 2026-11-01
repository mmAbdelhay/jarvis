import { StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/Icon";
import { toolText } from "@/lib/claude-chat";
import type { IconName } from "@/lib/icon-paths";
import { theme } from "@/lib/theme";
import type { ChatTool } from "@jarvis/wire";

const TOOL_ICONS: Readonly<Record<string, IconName>> = {
  Edit: "pencil",
  MultiEdit: "pencil",
  Write: "pencil",
  NotebookEdit: "pencil",
  Bash: "terminal",
  Read: "file",
  Glob: "search",
  Grep: "search",
  WebFetch: "external",
  WebSearch: "search",
};

/** One tool Claude ran, as a 44-dp row: what it touched, and the lines
 *  added and removed when it edited. Names and paths are Claude's own. */
export function ChatToolRow(props: { tool: ChatTool }) {
  const { tool } = props;
  return (
    <View style={styles.row}>
      <Icon name={TOOL_ICONS[tool.name] ?? "file"} size={16} color={theme.colors.textMuted} />
      <Text style={styles.name} numberOfLines={1}>
        {toolText(tool)}
      </Text>
      {tool.added !== undefined && tool.added > 0 && (
        <Text style={styles.added}>+{tool.added}</Text>
      )}
      {tool.removed !== undefined && tool.removed > 0 && (
        <Text style={styles.removed}>−{tool.removed}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
  },
  name: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.font.body,
    fontSize: 13,
    color: theme.colors.textSecondary,
  },
  added: { fontFamily: theme.font.monoSemibold, fontSize: 12, color: theme.colors.successText },
  removed: { fontFamily: theme.font.monoSemibold, fontSize: 12, color: theme.colors.dangerText },
});
