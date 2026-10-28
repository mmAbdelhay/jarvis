import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/Icon";
import { IconButton } from "@/components/IconButton";
import type { IconName } from "@/lib/icon-paths";
import { type Language, type MessageKey, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

export type AttachSource = "library" | "camera" | "files";

const SOURCES: readonly { source: AttachSource; icon: IconName; label: MessageKey }[] = [
  { source: "library", icon: "image", label: "claude.photos" },
  { source: "camera", icon: "camera", label: "claude.camera" },
  { source: "files", icon: "file", label: "claude.files" },
];

/**
 * "Add to message": where an attachment comes from. Choosing a source
 * closes the sheet; the screen then opens that picker.
 */
export function AttachSheet(props: {
  visible: boolean;
  language: Language;
  onPick(source: AttachSource): void;
  onClose(): void;
}) {
  return (
    <Modal transparent animationType="slide" visible={props.visible} onRequestClose={props.onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityLabel={t(props.language, "common.cancel")}
        onPress={props.onClose}
      >
        <Pressable
          style={styles.sheet}
          accessible={false}
          accessibilityViewIsModal
          accessibilityLabel={t(props.language, "claude.attachTitle")}
        >
          <View style={styles.grabber} />
          <View style={styles.head}>
            <Text style={styles.title}>{t(props.language, "claude.attachTitle")}</Text>
            <IconButton
              icon="close"
              size={40}
              label={t(props.language, "claude.attachClose")}
              onPress={props.onClose}
            />
          </View>
          <View style={styles.sources}>
            {SOURCES.map((item) => (
              <Pressable
                key={item.source}
                accessibilityRole="button"
                onPress={() => props.onPick(item.source)}
                style={styles.source}
              >
                <Icon name={item.icon} size={22} color={theme.colors.accent} />
                <Text style={styles.sourceText}>{t(props.language, item.label)}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.where}>
            <Icon name="laptop" size={16} color={theme.colors.textMuted} />
            <Text style={styles.whereText}>{t(props.language, "claude.attachWhere")}</Text>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.colors.scrim, justifyContent: "flex-end" },
  sheet: {
    gap: 14,
    paddingTop: 10,
    paddingHorizontal: 16,
    paddingBottom: 24,
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderColor: theme.colors.hairline,
    borderTopStartRadius: 24,
    borderTopEndRadius: 24,
  },
  grabber: {
    width: 40,
    height: 4,
    alignSelf: "center",
    borderRadius: 2,
    backgroundColor: theme.colors.handle,
  },
  head: { flexDirection: "row", alignItems: "center" },
  title: { flex: 1, fontFamily: theme.font.bold, fontSize: 17, color: theme.colors.text },
  sources: { flexDirection: "row", gap: 10 },
  source: {
    flex: 1,
    height: 84,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.ground,
  },
  sourceText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.colors.text },
  where: { flexDirection: "row", alignItems: "center", gap: 8 },
  whereText: {
    flex: 1,
    fontFamily: theme.font.body,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.textMuted,
  },
});
