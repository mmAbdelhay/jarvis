import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import type { MergedRow } from "@/lib/sessions-merge";
import { theme } from "@/lib/theme";

/** The sessions (live and saved) as a bottom sheet, to pick the one whose
 *  changes the screen shows. Choosing one closes the sheet, then selects. */
export function SessionPickerSheet(props: {
  visible: boolean;
  rows: readonly MergedRow[];
  selectedId: string | undefined;
  onSelect(id: string): void;
  onClose(): void;
}) {
  const language = useLanguage();
  return (
    <Modal transparent animationType="slide" visible={props.visible} onRequestClose={props.onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityLabel={t(language, "common.cancel")}
        onPress={props.onClose}
      >
        <Pressable style={styles.sheet} accessible={false}>
          <View style={styles.grabber} />
          <Text style={styles.title}>{t(language, "changes.sessions")}</Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.list}>
            {props.rows.map((row) => (
              <Pressable
                key={row.id}
                accessibilityRole="button"
                accessibilityState={{ selected: row.id === props.selectedId }}
                onPress={() => {
                  props.onClose();
                  props.onSelect(row.id);
                }}
                style={[styles.row, row.id === props.selectedId && styles.rowSelected]}
              >
                <Text style={styles.name} numberOfLines={1}>
                  {row.summary}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {row.branch === undefined ? row.label : `${row.label} · ${row.branch}`}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  scroll: { flexGrow: 0 },
  list: { padding: 16, gap: 8 },
  row: {
    minHeight: 52,
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  rowSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  name: { ...theme.type.rowTitle, color: theme.colors.text },
  meta: { ...theme.type.meta, color: theme.colors.textMuted },
});
