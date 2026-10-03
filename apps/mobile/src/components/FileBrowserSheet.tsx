import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { FileList } from "@/components/FileList";
import { t, type Language } from "@/lib/i18n";
import type { RpcClient } from "@/lib/rpc-client";
import { theme } from "@/lib/theme";

/**
 * The pane's project, browsed from the phone (the terminal header's Files
 * button): the same list the Workspace shows inline, in a sheet, where a
 * file can also be typed into the terminal as its path.
 */
export function FileBrowserSheet(props: {
  visible: boolean;
  client: Pick<RpcClient, "call">;
  paneKey: string;
  language: Language;
  onInsert(text: string): void;
  onClose(): void;
}) {
  const { language } = props;
  return (
    <Modal transparent animationType="slide" visible={props.visible} onRequestClose={props.onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <Text style={styles.title}>{t(language, "files.title")}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t(language, "common.cancel")}
              onPress={props.onClose}
              style={styles.close}
            >
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            <FileList
              client={props.client}
              paneKey={props.paneKey}
              language={language}
              onInsert={(text) => {
                props.onInsert(text);
                props.onClose();
              }}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    height: "75%",
    backgroundColor: theme.colors.ground,
    borderTopStartRadius: theme.radius.sheet,
    borderTopEndRadius: theme.radius.sheet,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
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
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingTop: 6,
  },
  title: { ...theme.type.headerTitle, color: theme.colors.text },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  closeText: { color: theme.colors.textMuted, fontSize: 28 },
  list: { flex: 1 },
  listContent: { padding: theme.spacing.md },
});
