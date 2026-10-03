import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { IconButton } from "@/components/IconButton";
import type { ProjectSummary } from "@/lib/dashboard-store";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

/**
 * The "New" sheet: pick a project to open a terminal in, or ask Jarvis.
 * `projects` is undefined while loading and null when the list failed.
 */
export function NewSessionSheet(props: {
  language: Language;
  visible: boolean;
  projects: ProjectSummary[] | null | undefined;
  busy: boolean;
  error: string | undefined;
  onPick(project: string): void;
  onAskJarvis(): void;
  onClose(): void;
  /** "terminal": titled "New terminal", with no Ask-Jarvis row. */
  mode?: "session" | "terminal";
}) {
  const terminal = props.mode === "terminal";
  const { language } = props;
  return (
    <Modal transparent animationType="slide" visible={props.visible} onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <View style={styles.titles}>
              <Text style={styles.title}>
                {t(language, terminal ? "home.newTerminal" : "sessions.newTitle")}
              </Text>
              <Text style={styles.hint}>{t(language, "sessions.newHint")}</Text>
            </View>
            <IconButton
              icon="close"
              size={40}
              label={t(language, "common.cancel")}
              onPress={props.onClose}
            />
          </View>
          <ScrollView contentContainerStyle={styles.list}>
            {props.projects === undefined && (
              <Text style={styles.note}>{t(language, "files.loading")}</Text>
            )}
            {props.projects === null && (
              <Text style={styles.note}>{t(language, "common.loadFailed")}</Text>
            )}
            {props.projects?.length === 0 && (
              <Text style={styles.note}>{t(language, "sessions.newNoProjects")}</Text>
            )}
            {props.projects?.map((project) => (
              <Pressable
                key={project.name}
                accessibilityRole="button"
                disabled={props.busy}
                onPress={() => props.onPick(project.name)}
                style={[styles.row, props.busy && styles.dim]}
              >
                <Text style={styles.name} numberOfLines={1}>
                  {project.name}
                </Text>
              </Pressable>
            ))}
            {!terminal && (
              <Pressable
                accessibilityRole="button"
                disabled={props.busy}
                onPress={props.onAskJarvis}
                style={[styles.row, styles.ask, props.busy && styles.dim]}
              >
                <Text style={styles.askText}>{t(language, "sessions.newAskJarvis")}</Text>
              </Pressable>
            )}
            {props.error !== undefined && (
              <Text selectable style={styles.error}>
                {props.error}
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    maxHeight: "75%",
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  titles: { flex: 1, minWidth: 0 },
  title: { ...theme.type.headerTitle, color: theme.colors.text },
  hint: { ...theme.type.meta, color: theme.colors.textMuted },
  list: { padding: 16, gap: 8 },
  note: { ...theme.type.body, color: theme.colors.textMuted },
  row: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  name: { ...theme.type.rowTitle, color: theme.colors.text },
  ask: { borderColor: theme.colors.accentBorder, backgroundColor: theme.colors.accentSoft },
  askText: { ...theme.type.button, color: theme.colors.accentText },
  dim: { opacity: 0.5 },
  error: { ...theme.type.meta, color: theme.colors.danger },
});
