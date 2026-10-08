import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { t } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { theme } from "@/lib/theme";

export type SheetAction = { key: string; label: string; onPress(): void };

/**
 * A short bottom sheet of actions (a screen's "⋯" menu). Choosing one closes
 * the sheet first, then runs it, so a navigation never leaves it open.
 */
export function ActionSheet(props: {
  visible: boolean;
  title: string;
  actions: readonly SheetAction[];
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
          <Text style={styles.title} numberOfLines={1}>
            {props.title}
          </Text>
          <View style={styles.list}>
            {props.actions.map((action) => (
              <Pressable
                key={action.key}
                accessibilityRole="button"
                onPress={() => {
                  props.onClose();
                  action.onPress();
                }}
                style={styles.row}
              >
                <Text style={styles.name} numberOfLines={1}>
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
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
  list: { padding: 16, gap: 8 },
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
});
