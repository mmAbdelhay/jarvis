import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Icon } from "@/components/Icon";
import { RenameField } from "@/components/RenameField";
import { dialogs } from "@/lib/dialog";
import {
  childPath,
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
import { breadcrumbParts } from "@/lib/workspace-rows";

/**
 * A project's files, read through one terminal pane: a breadcrumb and a
 * list. Folders open in place (a long press selects one); a tapped file is
 * selected, and a selected entry can be renamed or moved to the laptop's
 * Trash after a confirmation. Creating stays on the laptop. With `onInsert`
 * a selected entry can also be typed into the terminal as its path.
 */
export function FileList(props: {
  client: Pick<RpcClient, "call">;
  paneKey: string;
  language: Language;
  onInsert?: (text: string) => void;
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
  }, [props.client, props.paneKey, path, revision]);

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

  const parts = breadcrumbParts(t(language, "files.root"), path);

  return (
    <View style={styles.root}>
      <ScrollView horizontal contentContainerStyle={styles.crumbs} style={styles.crumbRow}>
        {parts.map((part, index) => (
          <View key={part.path} style={styles.crumbStep}>
            {index > 0 && <Text style={styles.crumbSep}>/</Text>}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ selected: part.current }}
              onPress={() => setPath(part.path)}
            >
              <Text style={[styles.crumb, part.current && styles.crumbHere]}>{part.name}</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
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
      {!loading && entries !== undefined && entries.length > 0 && (
        <View style={styles.list}>
          {entries.map((entry, index) => {
            const full = childPath(path, entry.name);
            const open = picked === full;
            return (
              <View key={entry.name} style={index > 0 && styles.divided}>
                <View style={[styles.row, open && styles.rowOpen]}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: open }}
                    onPress={() =>
                      entry.directory ? setPath(full) : setPicked(open ? undefined : full)
                    }
                    onLongPress={() => setPicked(open ? undefined : full)}
                    style={styles.rowMain}
                  >
                    <Icon
                      name={entry.directory ? "folderFilled" : "file"}
                      size={16}
                      color={entry.directory ? theme.colors.warning : theme.colors.link}
                    />
                    <Text
                      style={[styles.name, !entry.directory && styles.fileName]}
                      numberOfLines={1}
                    >
                      {entry.name}
                    </Text>
                    {entry.directory && !open && (
                      <Text style={styles.chevron}>{language === "ar" ? "‹" : "›"}</Text>
                    )}
                  </Pressable>
                  {open && (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${t(language, "files.rename")} ${entry.name}`}
                        disabled={busy}
                        onPress={() => {
                          setOpError(undefined);
                          setRenaming(renaming === full ? undefined : full);
                        }}
                        style={styles.action}
                      >
                        <Text style={styles.renameText}>{t(language, "files.rename")}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${t(language, "files.trash")} ${entry.name}`}
                        disabled={busy}
                        onPress={() => confirmTrash(entry, full)}
                        style={styles.action}
                      >
                        <Text style={styles.trashText}>{t(language, "files.trashShort")}</Text>
                      </Pressable>
                    </>
                  )}
                </View>
                {renaming === full && (
                  <View style={styles.renameBox}>
                    <RenameField
                      language={language}
                      initial={entry.name}
                      label={t(language, "files.rename")}
                      problem={(draft) =>
                        validateEntryName(draft) === undefined ? undefined : "files.errInvalidName"
                      }
                      busy={busy}
                      onCancel={() => setRenaming(undefined)}
                      onSubmit={(draft) =>
                        void finish(() => renameEntry(props.client, props.paneKey, full, draft))
                      }
                    />
                  </View>
                )}
                {open && props.onInsert !== undefined && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => props.onInsert?.(`${shellQuote(full)} `)}
                    style={styles.insert}
                  >
                    <Text style={styles.insertText}>{t(language, "files.insertPath")}</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  crumbRow: { flexGrow: 0 },
  crumbs: { alignItems: "center", gap: 4 },
  crumbStep: { flexDirection: "row", alignItems: "center", gap: 4 },
  crumb: { ...theme.type.mono, minHeight: 28, paddingVertical: 6, color: theme.colors.textMuted },
  crumbHere: { color: theme.colors.text },
  crumbSep: { ...theme.type.mono, color: theme.colors.textMuted },
  note: { ...theme.type.body, color: theme.colors.textMuted, paddingVertical: 8 },
  list: {
    borderRadius: theme.radius.card,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    overflow: "hidden",
  },
  divided: { borderTopWidth: 1, borderTopColor: theme.colors.hairlineSoft },
  row: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    paddingStart: 12,
    paddingEnd: 4,
  },
  rowOpen: { backgroundColor: theme.colors.surfaceAlt },
  rowMain: { flex: 1, minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10 },
  name: { ...theme.type.body, flex: 1, color: theme.colors.text },
  chevron: { ...theme.type.body, color: theme.colors.textFaint },
  fileName: { fontFamily: theme.font.mono, fontSize: 13 },
  action: {
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: theme.radius.chip,
    justifyContent: "center",
  },
  renameText: { ...theme.type.meta, fontFamily: theme.font.bold, color: theme.colors.link },
  trashText: { ...theme.type.meta, fontFamily: theme.font.bold, color: theme.colors.dangerText },
  renameBox: { paddingHorizontal: 12, paddingBottom: 8 },
  opError: { ...theme.type.meta, color: theme.colors.danger },
  insert: {
    marginHorizontal: 12,
    marginBottom: 8,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: theme.colors.accentSoft,
  },
  insertText: { color: theme.colors.accentText, fontFamily: theme.font.bold, fontSize: 13 },
});
