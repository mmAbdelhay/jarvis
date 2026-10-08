// The Workspace's project picker, and (wide layout) the browser-style tab
// strip above the inline pane: every project's tabs side by side, a "+" for
// a new one. Layout only: which tabs exist and which one is active come from
// workspace-tabs.ts, and the screen owns every action.
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, Pressable } from "react-native";
import { Icon } from "@/components/Icon";
import { t, type Language, type MessageKey } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import { isLaptopTabId, type WorkspaceStripTab } from "@/lib/workspace-tabs";
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

/** Wide: the tab strip (every project's tabs, "+" at the end), the chat
 *  names once listed and, for a terminal tab with several panes, the pane
 *  chips. */
export function WorkspaceTabStrip(props: {
  language: Language;
  tabs: readonly WorkspaceStripTab[];
  activeId: string | undefined;
  /** Tab ids that show the exited dot. */
  exitedIds: ReadonlySet<string>;
  plusDisabled: boolean;
  onPlus(): void;
  onSelectTab(tab: WorkspaceStripTab): void;
  onCloseTab(tab: WorkspaceStripTab): void;
  /** Rename or close a tab on the laptop itself (long press). */
  onTabActions(tab: WorkspaceStripTab): void;
  onCloseLaptopTab(tab: WorkspaceStripTab): void;
  /** Chat names once the Chat tool has listed them. */
  chatNames: readonly string[] | undefined;
  chatBusy: boolean;
  onOpenChat(name: string): void;
  panes: readonly string[];
  activePane: string | undefined;
  onSelectPane(paneKey: string): void;
}) {
  const { language } = props;
  return (
    <View>
      <View style={styles.stripBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.stripContent}
          accessibilityRole="tablist"
        >
          {props.tabs.map((tab) => {
            const active = tab.id === props.activeId;
            const laptop = !tab.closable && isLaptopTabId(tab.id);
            const closeColor = active ? theme.colors.textDim : theme.colors.textFaint;
            return (
              <View key={tab.id} style={[styles.tab, active && styles.tabActive]}>
                <Pressable
                  style={styles.tabButton}
                  onPress={() => props.onSelectTab(tab)}
                  onLongPress={laptop ? () => props.onTabActions(tab) : undefined}
                  // A tab that opens elsewhere is an action, not a selection.
                  accessibilityRole={tab.inline ? "tab" : "button"}
                  accessibilityState={tab.inline ? { selected: active } : undefined}
                  accessibilityActions={
                    laptop
                      ? [
                          {
                            name: "longpress",
                            label: t(language, "workspace.tabActions", { title: tab.title }),
                          },
                        ]
                      : undefined
                  }
                  onAccessibilityAction={() => props.onTabActions(tab)}
                >
                  {props.exitedIds.has(tab.id) && <View style={styles.dot} />}
                  <Text
                    style={[styles.tabTitle, active && styles.tabTitleActive]}
                    numberOfLines={1}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
                {(tab.closable || laptop) && (
                  <Pressable
                    style={styles.tabClose}
                    onPress={() =>
                      tab.closable ? props.onCloseTab(tab) : props.onCloseLaptopTab(tab)
                    }
                    accessibilityRole="button"
                    accessibilityLabel={t(language, "workspace.closeTab", { title: tab.title })}
                  >
                    <Icon name="close" size={12} strokeWidth={2.6} color={closeColor} />
                  </Pressable>
                )}
              </View>
            );
          })}
          <Pressable
            style={[styles.plus, props.plusDisabled && styles.dim]}
            disabled={props.plusDisabled}
            onPress={props.onPlus}
            accessibilityRole="button"
            accessibilityLabel={t(language, "workspace.newTab")}
          >
            <Icon name="plus" size={16} strokeWidth={2.4} color={theme.colors.textMuted} />
          </Pressable>
        </ScrollView>
      </View>
      {props.chatNames !== undefined && (
        <View style={styles.subRow}>
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
      {props.panes.length > 1 && (
        <View style={styles.subRow}>
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
  stripBar: {
    backgroundColor: theme.colors.surfaceDim,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairlineSoft,
  },
  stripContent: { alignItems: "center", gap: 2, paddingTop: 8, paddingHorizontal: 10 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingStart: 14,
    paddingEnd: 8,
    paddingVertical: 9,
    borderTopStartRadius: theme.radius.sm,
    borderTopEndRadius: theme.radius.sm,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: "transparent",
  },
  tabActive: {
    backgroundColor: theme.colors.terminalGround,
    borderColor: theme.colors.hairlineSoft,
  },
  tabButton: { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 260 },
  dot: {
    width: 7,
    height: 7,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.disabledDot,
  },
  tabTitle: {
    flexShrink: 1,
    color: theme.colors.textMuted,
    fontFamily: theme.font.semibold,
    fontSize: 13,
  },
  tabTitleActive: { color: theme.colors.text, fontFamily: theme.font.bold },
  tabClose: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.tiny,
  },
  plus: {
    width: 32,
    height: 32,
    marginStart: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  dim: { opacity: 0.5 },
  subRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  tool: {
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  toolText: { color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 12 },
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
