// The Workspace's project picker, and (wide layout, 2026-09-28 spec §3) the
// desktop-style tool buttons and tab strip above the inline pane. Layout
// only: which tabs exist and which one is active come from
// workspace-tabs.ts, and the screen owns every action.
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { t, type Language, type MessageKey } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import { isLaptopTabId, type WorkspaceTabItem } from "@/lib/workspace-tabs";
import type { WorkspaceProjectView } from "@/lib/workspace-store";

/** The project chips, shared by the phone list and the wide header. */
export function ProjectPicker(props: {
  projects: readonly WorkspaceProjectView[];
  selected: string | undefined;
  onSelect(name: string): void;
}) {
  return (
    <View style={styles.projectRow} accessibilityRole="tablist">
      {props.projects.map((project) => (
        <TouchableOpacity
          key={project.name}
          style={[
            styles.projectChip,
            project.name === props.selected && styles.projectChipSelected,
          ]}
          onPress={() => props.onSelect(project.name)}
          accessibilityRole="tab"
          accessibilityState={{ selected: project.name === props.selected }}
        >
          <Text
            style={[
              styles.projectChipText,
              project.name === props.selected && styles.projectChipTextSelected,
            ]}
          >
            {project.name}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export type WorkspaceTool =
  | "terminal"
  | "api"
  | "docker"
  | "editor"
  | "database"
  | "cluster"
  | "changes"
  | "chat";

// The desktop's order.
export const TOOLS: readonly { tool: WorkspaceTool; label: MessageKey }[] = [
  { tool: "terminal", label: "workspace.terminal" },
  { tool: "api", label: "api.title" },
  { tool: "docker", label: "docker.title" },
  { tool: "editor", label: "sidecars.editor" },
  { tool: "database", label: "sidecars.database" },
  { tool: "cluster", label: "sidecars.cluster" },
  { tool: "changes", label: "dashboard.changes" },
  // The phone's Chat action: lists the project's chats, each opening in
  // the browser.
  { tool: "chat", label: "workspace.chat" },
];

/** Wide: the project picker, the tool buttons, the tab strip and, for a
 *  terminal tab with several panes, the pane chips. */
export function WorkspaceTools(props: {
  language: Language;
  projects: readonly WorkspaceProjectView[];
  selectedProject: string | undefined;
  onSelectProject(name: string): void;
  terminalBusy: boolean;
  onTool(tool: WorkspaceTool): void;
  /** Chat names once the Chat tool has listed them. */
  chatNames: readonly string[] | undefined;
  chatBusy: boolean;
  onOpenChat(name: string): void;
  tabs: readonly WorkspaceTabItem[];
  activeId: string | undefined;
  onSelectTab(tab: WorkspaceTabItem): void;
  onCloseTab(tab: WorkspaceTabItem): void;
  /** Rename or close a tab on the laptop itself. */
  onRenameLaptopTab(tab: WorkspaceTabItem): void;
  onCloseLaptopTab(tab: WorkspaceTabItem): void;
  panes: readonly string[];
  activePane: string | undefined;
  onSelectPane(paneKey: string): void;
}) {
  const { language } = props;
  const hasProject = props.selectedProject !== undefined;
  return (
    <View style={styles.header}>
      <ProjectPicker
        projects={props.projects}
        selected={props.selectedProject}
        onSelect={props.onSelectProject}
      />
      <View style={styles.toolRow}>
        {TOOLS.map(({ tool, label }) => {
          const busy =
            (tool === "terminal" && props.terminalBusy) || (tool === "chat" && props.chatBusy);
          return (
            <TouchableOpacity
              key={tool}
              style={[styles.tool, !hasProject && styles.dim]}
              disabled={!hasProject || busy}
              onPress={() => props.onTool(tool)}
              accessibilityRole="button"
            >
              <Text style={styles.toolText}>
                {tool === "terminal" && busy
                  ? t(language, "workspace.openingTerminal")
                  : t(language, label)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {props.chatNames !== undefined && (
        <View style={styles.toolRow}>
          {props.chatNames.length === 0 ? (
            <Text style={styles.empty}>{t(language, "workspace.chatUnavailable")}</Text>
          ) : (
            props.chatNames.map((name) => (
              <TouchableOpacity
                key={name}
                style={styles.tool}
                disabled={props.chatBusy}
                onPress={() => props.onOpenChat(name)}
                accessibilityRole="button"
              >
                {/* Server-originated text: shown verbatim. */}
                <Text style={styles.toolText}>↗ {name}</Text>
              </TouchableOpacity>
            ))
          )}
        </View>
      )}
      {props.tabs.length > 0 && (
        <View style={styles.strip} accessibilityRole="tablist">
          {props.tabs.map((tab) => {
            const active = tab.id === props.activeId;
            return (
              <View key={tab.id} style={[styles.tab, active && styles.tabActive]}>
                <TouchableOpacity
                  style={styles.tabButton}
                  onPress={() => props.onSelectTab(tab)}
                  // A tab that opens elsewhere is an action, not a selection.
                  accessibilityRole={tab.inline ? "tab" : "button"}
                  accessibilityState={tab.inline ? { selected: active } : undefined}
                >
                  <Text style={styles.tabKind}>
                    {tab.kind === "terminal" ? ">_" : tab.inline ? "▣" : "↗"}
                  </Text>
                  <Text
                    style={[styles.tabTitle, active && styles.tabTitleActive]}
                    numberOfLines={1}
                  >
                    {tab.title}
                  </Text>
                </TouchableOpacity>
                {!tab.closable && isLaptopTabId(tab.id) && (
                  <>
                    <TouchableOpacity
                      style={styles.tabClose}
                      onPress={() => props.onRenameLaptopTab(tab)}
                      accessibilityRole="button"
                      accessibilityLabel={t(language, "workspace.renameTab", { title: tab.title })}
                    >
                      <Text style={styles.tabCloseText}>✎</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.tabClose}
                      onPress={() => props.onCloseLaptopTab(tab)}
                      accessibilityRole="button"
                      accessibilityLabel={t(language, "workspace.closeTab", { title: tab.title })}
                    >
                      <Text style={styles.tabCloseText}>×</Text>
                    </TouchableOpacity>
                  </>
                )}
                {tab.closable && (
                  <TouchableOpacity
                    style={styles.tabClose}
                    onPress={() => props.onCloseTab(tab)}
                    accessibilityRole="button"
                    accessibilityLabel={t(language, "workspace.closeTab", { title: tab.title })}
                  >
                    <Text style={styles.tabCloseText}>×</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>
      )}
      {props.panes.length > 1 && (
        <View style={styles.paneRow}>
          {props.panes.map((paneKey) => (
            <TouchableOpacity
              key={paneKey}
              style={[styles.pane, paneKey === props.activePane && styles.paneActive]}
              onPress={() => props.onSelectPane(paneKey)}
              accessibilityRole="button"
              accessibilityState={{ selected: paneKey === props.activePane }}
            >
              <Text style={styles.paneText}>{paneKey}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  projectRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  projectChip: {
    minHeight: 36,
    justifyContent: "center",
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
  },
  projectChipSelected: {
    backgroundColor: theme.colors.text,
    borderColor: theme.colors.text,
  },
  projectChipText: { ...theme.type.chip, color: theme.colors.textSecondary },
  projectChipTextSelected: { ...theme.type.chipSelected, color: theme.colors.primaryText },
  header: { gap: 10 },
  toolRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tool: {
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  dim: { opacity: 0.5 },
  toolText: { color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 12 },
  strip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairlineSoft,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 240,
    borderTopStartRadius: theme.radius.tiny,
    borderTopEndRadius: theme.radius.tiny,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "transparent",
  },
  tabActive: { backgroundColor: theme.colors.surface, borderColor: theme.colors.hairline },
  tabButton: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 32,
  },
  tabKind: { color: theme.colors.textDim, fontFamily: theme.font.mono, fontSize: 11 },
  tabTitle: {
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontFamily: theme.font.semibold,
    fontSize: 12,
  },
  tabTitleActive: { color: theme.colors.text },
  tabClose: { height: 32, justifyContent: "center", paddingHorizontal: 8 },
  tabCloseText: { color: theme.colors.textDim, fontSize: 14 },
  paneRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  empty: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  pane: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: theme.radius.tiny,
    backgroundColor: theme.colors.surfaceAlt,
  },
  paneActive: { backgroundColor: theme.colors.accentSoft },
  paneText: { color: theme.colors.textSecondary, fontFamily: theme.font.mono, fontSize: 11 },
});
