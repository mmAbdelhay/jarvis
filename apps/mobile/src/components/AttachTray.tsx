import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/Icon";
import type { TrayItem } from "@/lib/claude-compose";
import { type Language, t } from "@/lib/i18n";
import { theme } from "@/lib/theme";

const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp|heic|heif)$/i;

/**
 * The attachments waiting to go with the next message: one chip each,
 * with its upload progress, "uploaded", or why it failed, and an ✕ that
 * drops it (or cancels its upload). File names are shown as picked.
 */
export function AttachTray(props: {
  language: Language;
  items: readonly TrayItem[];
  onRemove(id: string): void;
}) {
  if (props.items.length === 0) return null;
  return (
    <ScrollView
      horizontal
      style={styles.scroll}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
      {props.items.map((item) => (
        <View key={item.id} style={styles.chip}>
          <View style={styles.mini}>
            <Icon
              name={IMAGE_NAME.test(item.name) ? "image" : "file"}
              size={16}
              color={theme.colors.textMuted}
            />
          </View>
          <View style={styles.body}>
            <Text style={styles.name} numberOfLines={1}>
              {item.name}
            </Text>
            {item.state === "uploading" ? (
              <View style={styles.progress}>
                <View
                  style={[styles.fill, { width: `${Math.round((item.progress ?? 0) * 100)}%` }]}
                />
              </View>
            ) : item.state === "done" ? (
              <Text style={styles.ok}>{t(props.language, "claude.uploaded")}</Text>
            ) : (
              <Text style={styles.error} numberOfLines={1}>
                {item.error ?? t(props.language, "claude.upload.failed")}
              </Text>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              props.language,
              item.state === "uploading" ? "claude.cancelUpload" : "claude.removeFile",
              { name: item.name },
            )}
            hitSlop={6}
            onPress={() => props.onRemove(item.id)}
            style={styles.remove}
          >
            <Icon name="close" size={14} color={theme.colors.textMuted} strokeWidth={2.4} />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  row: { gap: 8 },
  chip: {
    width: 180,
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 6,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    backgroundColor: theme.colors.surface,
  },
  mini: {
    width: 36,
    height: 40,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.handle,
    backgroundColor: theme.colors.ground,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, minWidth: 0, gap: 3 },
  name: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.colors.text },
  progress: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    flexDirection: "row",
    backgroundColor: theme.colors.hairline,
  },
  fill: { backgroundColor: theme.colors.accent },
  ok: { fontFamily: theme.font.mono, fontSize: 11, color: theme.colors.successText },
  error: { fontFamily: theme.font.mono, fontSize: 11, color: theme.colors.dangerText },
  remove: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
});
