import { useEffect, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { RenameField } from "@/components/RenameField";
import { dialogs } from "@/lib/dialog";
import {
  childPath,
  crumbs,
  type DirEntry,
  FILE_OP_ERROR_KEYS,
  type FileOpOutcome,
  listDir,
  renameEntry,
  shellQuote,
  trashEntry,
  validateEntryName,
} from "@/lib/file-browser";
import { t, type Language } from "@/lib/i18n";
import type { RpcClient } from "@/lib/rpc-client";
import { theme } from "@/lib/theme";

/**
 * The pane's project, browsed from the phone: folders open in place, and a
 * file can be typed into the terminal as its path. Each entry can be renamed
 * or moved to the laptop's Trash (after a confirmation); creating stays on
 * the laptop's own sidebar.
 */
export function FileBrowserSheet(props: {
  visible: boolean;
  client: Pick<RpcClient, "call">;
  paneKey: string;
  language: Language;
  onInsert(text: string): void;
  onClose(): void;
}) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [opError, setOpError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Bumped after a rename or trash so the listing is read again.
  const [revision, setRevision] = useState(0);

  // A failure shown for one folder is not about the next one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `path` is the trigger, not a value read here.
  useEffect(() => {
    setOpError(undefined);
  }, [path]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is a re-read trigger bumped after a rename or trash.
  useEffect(() => {
    if (!props.visible) return;
    let cancelled = false;
    setLoading(true);
    setPicked(undefined);
    void listDir(props.client, props.paneKey, path).then((next) => {
      if (cancelled) return;
      setEntries(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [props.visible, props.client, props.paneKey, path, revision]);

  const { language } = props;

  async function finish(run: () => Promise<FileOpOutcome>): Promise<void> {
    setBusy(true);
    setOpError(undefined);
    const outcome = await run();
    setBusy(false);
    if (outcome.ok) {
      setRenaming(undefined);
      setPicked(undefined);
      setRevision((value) => value + 1);
      return;
    }
    setOpError(t(language, FILE_OP_ERROR_KEYS[outcome.reason]));
  }

  function confirmTrash(entry: DirEntry, full: string): void {
    dialogs.confirm({
      title: t(language, "files.trashTitle"),
      message: t(language, "files.trashMessage", { name: entry.name }),
      confirmText: t(language, "files.trash"),
      cancelText: t(language, "common.cancel"),
      destructive: true,
      onConfirm: () => void finish(() => trashEntry(props.client, props.paneKey, full)),
    });
  }

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
          <ScrollView horizontal contentContainerStyle={styles.crumbs} style={styles.crumbRow}>
            <TouchableOpacity accessibilityRole="button" onPress={() => setPath("")}>
              <Text style={[styles.crumb, path === "" && styles.crumbHere]}>
                {t(language, "files.root")}
              </Text>
            </TouchableOpacity>
            {crumbs(path).map((step) => (
              <View key={step.path} style={styles.crumbStep}>
                <Text style={styles.crumbSep}>/</Text>
                <TouchableOpacity accessibilityRole="button" onPress={() => setPath(step.path)}>
                  <Text style={[styles.crumb, step.path === path && styles.crumbHere]}>
                    {step.name}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {opError !== undefined && (
              <Text selectable style={styles.opError}>
                {opError}
              </Text>
            )}
            {loading && <Text style={styles.note}>{t(language, "files.loading")}</Text>}
            {!loading && entries === undefined && (
              <Text style={styles.note}>{t(language, "files.unavailable")}</Text>
            )}
            {!loading && entries?.length === 0 && (
              <Text style={styles.note}>{t(language, "files.empty")}</Text>
            )}
            {!loading &&
              entries?.map((entry) => {
                const full = childPath(path, entry.name);
                const open = picked === full;
                return (
                  <View key={entry.name}>
                    <View style={[styles.row, open && styles.rowOpen]}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={() =>
                          entry.directory ? setPath(full) : setPicked(open ? undefined : full)
                        }
                        style={styles.rowMain}
                      >
                        <Text style={[styles.icon, entry.directory ? styles.folder : styles.file]}>
                          {entry.directory ? "▸" : "·"}
                        </Text>
                        <Text
                          style={[styles.name, !entry.directory && styles.fileName]}
                          numberOfLines={1}
                        >
                          {entry.name}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`${t(language, "files.rename")} ${entry.name}`}
                        disabled={busy}
                        onPress={() => {
                          setOpError(undefined);
                          setRenaming(renaming === full ? undefined : full);
                        }}
                        style={styles.action}
                      >
                        <Text style={styles.actionText}>✎</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel={`${t(language, "files.trash")} ${entry.name}`}
                        disabled={busy}
                        onPress={() => confirmTrash(entry, full)}
                        style={styles.action}
                      >
                        <Text style={styles.trashText}>⌫</Text>
                      </TouchableOpacity>
                    </View>
                    {renaming === full && (
                      <View style={styles.renameBox}>
                        <RenameField
                          language={language}
                          initial={entry.name}
                          label={t(language, "files.rename")}
                          problem={(draft) =>
                            validateEntryName(draft) === undefined
                              ? undefined
                              : "files.errInvalidName"
                          }
                          busy={busy}
                          onCancel={() => setRenaming(undefined)}
                          onSubmit={(draft) =>
                            void finish(() => renameEntry(props.client, props.paneKey, full, draft))
                          }
                        />
                      </View>
                    )}
                    {open && (
                      <TouchableOpacity
                        accessibilityRole="button"
                        onPress={() => {
                          props.onInsert(`${shellQuote(full)} `);
                          props.onClose();
                        }}
                        style={styles.insert}
                      >
                        <Text style={styles.insertText}>{t(language, "files.insertPath")}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })}
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
    borderTopStartRadius: 22,
    borderTopEndRadius: 22,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  grabber: {
    width: 42,
    height: 4,
    alignSelf: "center",
    marginTop: 7,
    borderRadius: 2,
    backgroundColor: theme.colors.textFaint,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
    paddingTop: 6,
  },
  title: { color: theme.colors.text, fontFamily: theme.font.bold, fontSize: 18 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  closeText: { color: theme.colors.textMuted, fontSize: 28 },
  crumbRow: { flexGrow: 0 },
  crumbs: { paddingHorizontal: theme.spacing.md, paddingBottom: 10, alignItems: "center", gap: 4 },
  crumbStep: { flexDirection: "row", alignItems: "center", gap: 4 },
  crumb: {
    minHeight: 32,
    paddingVertical: 6,
    color: theme.colors.textMuted,
    fontFamily: theme.font.mono,
    fontSize: 12,
  },
  crumbHere: { color: theme.colors.text, fontFamily: theme.font.monoSemibold },
  crumbSep: { color: theme.colors.textFaint, fontFamily: theme.font.mono, fontSize: 12 },
  list: { flex: 1, borderTopWidth: 1, borderTopColor: theme.colors.hairlineSoft },
  listContent: { paddingVertical: 6 },
  note: { padding: theme.spacing.md, color: theme.colors.textMuted, fontFamily: theme.font.body },
  row: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    paddingStart: theme.spacing.md,
    paddingEnd: 4,
  },
  rowMain: { flex: 1, minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10 },
  rowOpen: { backgroundColor: theme.colors.surfaceAlt },
  action: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  actionText: { color: theme.colors.textMuted, fontSize: 17 },
  trashText: { color: theme.colors.danger, fontSize: 17 },
  renameBox: { paddingHorizontal: theme.spacing.md },
  opError: {
    paddingHorizontal: theme.spacing.md,
    paddingBottom: 6,
    color: theme.colors.danger,
    fontFamily: theme.font.body,
    fontSize: 12,
  },
  icon: { width: 14, fontFamily: theme.font.monoSemibold, fontSize: 14 },
  folder: { color: theme.colors.warning },
  file: { color: theme.colors.accentText },
  name: { flex: 1, color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 14 },
  fileName: { fontFamily: theme.font.mono, fontSize: 13 },
  insert: {
    marginHorizontal: theme.spacing.md,
    marginBottom: 8,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: theme.colors.accentSoft,
  },
  insertText: { color: theme.colors.accentText, fontFamily: theme.font.bold, fontSize: 13 },
});
