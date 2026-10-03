import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ActionSheet } from "@/components/ActionSheet";
import { RenameField } from "@/components/RenameField";
import { dialogs } from "@/lib/dialog";
import {
  type DirEntry,
  FILE_OP_ERROR_KEYS,
  type FileOpOutcome,
  listDir,
  renameEntry,
  shellQuote,
  trashEntry,
  validateEntryName,
} from "@/lib/file-browser";
import {
  type FileTreeState,
  flattenTree,
  initialTree,
  loadedFolder,
  refreshedTree,
  reloadPaths,
  toggleFolder,
} from "@/lib/file-tree";
import { t, type Language } from "@/lib/i18n";
import type { RpcClient } from "@/lib/rpc-client";
import { theme } from "@/lib/theme";

/**
 * The wide Workspace's Files aside: the project's tree, read lazily through
 * one terminal pane. A folder opens in place; a file (or a long-pressed
 * folder) offers rename and move to the laptop's Trash after a confirmation,
 * the same as the phone's list. New file and New folder stay on the laptop.
 * Git status letters need a tab-to-session link the wire does not carry, so
 * none are drawn. Key it by pane: a new pane starts a new tree.
 */
export function FileTree(props: {
  client: Pick<RpcClient, "call">;
  paneKey: string;
  language: Language;
  onInsert?: (text: string) => void;
}) {
  const { language, client, paneKey } = props;
  const [tree, setTree] = useState<FileTreeState>(initialTree);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [actions, setActions] = useState<{ path: string; name: string } | undefined>(undefined);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | undefined>(undefined);
  const [opError, setOpError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(
    async (path: string): Promise<void> => {
      const entries: DirEntry[] | undefined = await listDir(client, paneKey, path);
      if (alive.current) setTree((current) => loadedFolder(current, path, entries));
    },
    [client, paneKey],
  );

  // The root, once per pane.
  useEffect(() => {
    void read("");
  }, [read]);

  function toggle(path: string): void {
    const next = toggleFolder(tree, path);
    setTree(next.state);
    if (next.load) void read(path);
  }

  async function finish(run: () => Promise<FileOpOutcome>): Promise<void> {
    setBusy(true);
    setOpError(undefined);
    const outcome = await run();
    if (!alive.current) return;
    setBusy(false);
    if (outcome.ok) {
      setRenaming(undefined);
      setPicked(undefined);
      const paths = reloadPaths(tree);
      setTree(refreshedTree(tree));
      for (const path of paths) void read(path);
      return;
    }
    setOpError(t(language, FILE_OP_ERROR_KEYS[outcome.reason]));
  }

  function confirmTrash(target: { path: string; name: string }): void {
    dialogs.confirm({
      title: t(language, "files.trashTitle"),
      message: t(language, "files.trashMessage", { name: target.name }),
      confirmText: t(language, "files.trash"),
      cancelText: t(language, "common.cancel"),
      destructive: true,
      onConfirm: () => void finish(() => trashEntry(client, paneKey, target.path)),
    });
  }

  const rows = flattenTree(tree);
  const sheetActions =
    actions === undefined
      ? []
      : [
          {
            key: "rename",
            label: t(language, "files.rename"),
            onPress: () => {
              setOpError(undefined);
              setRenaming(actions);
            },
          },
          {
            key: "trash",
            label: t(language, "files.trash"),
            onPress: () => confirmTrash(actions),
          },
          ...(props.onInsert === undefined
            ? []
            : [
                {
                  key: "insert",
                  label: t(language, "files.insertPath"),
                  onPress: () => props.onInsert?.(`${shellQuote(actions.path)} `),
                },
              ]),
        ];

  return (
    <View style={styles.aside} accessibilityLabel={t(language, "files.title")}>
      <View style={styles.header}>
        <Text style={styles.headerText}>{t(language, "workspace.files")}</Text>
      </View>
      {opError !== undefined && (
        <Text selectable style={styles.opError}>
          {opError}
        </Text>
      )}
      {renaming !== undefined && (
        <View style={styles.renameBox}>
          <RenameField
            key={renaming.path}
            language={language}
            initial={renaming.name}
            label={t(language, "files.rename")}
            problem={(draft) =>
              validateEntryName(draft) === undefined ? undefined : "files.errInvalidName"
            }
            busy={busy}
            onCancel={() => setRenaming(undefined)}
            onSubmit={(draft) =>
              void finish(() => renameEntry(client, paneKey, renaming.path, draft))
            }
          />
        </View>
      )}
      <ScrollView contentContainerStyle={styles.rows}>
        {rows.map((entry) => {
          const indent = 8 + entry.depth * 16;
          if (entry.kind === "loading" || entry.kind === "error") {
            return (
              <Text
                key={`${entry.kind}:${entry.path}`}
                style={[styles.note, { paddingStart: indent }]}
              >
                {t(language, entry.kind === "loading" ? "files.loading" : "files.unavailable")}
              </Text>
            );
          }
          const row = entry;
          const isFolder = row.kind === "folder";
          const on = picked === row.path;
          return (
            <Pressable
              key={row.path}
              accessibilityRole="button"
              accessibilityState={isFolder ? { expanded: row.expanded } : { selected: on }}
              onPress={() => {
                if (isFolder) {
                  toggle(row.path);
                  return;
                }
                setPicked(row.path);
                setActions({ path: row.path, name: row.name });
              }}
              onLongPress={() => setActions({ path: row.path, name: row.name })}
              style={[styles.row, { paddingStart: indent }, on && styles.rowOn]}
            >
              <Text
                style={[isFolder ? styles.folder : styles.file, on && styles.fileOn]}
                numberOfLines={1}
              >
                {isFolder ? `${row.expanded ? "▾" : language === "ar" ? "◂" : "▸"} ` : ""}
                {row.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <ActionSheet
        visible={actions !== undefined}
        title={actions?.name ?? ""}
        actions={sheetActions}
        onClose={() => setActions(undefined)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  aside: {
    flex: 1,
    flexBasis: 220,
    maxWidth: 250,
    minHeight: 0,
    paddingVertical: 12,
    paddingHorizontal: 8,
    gap: 2,
    borderEndWidth: 1,
    borderEndColor: theme.colors.hairlineSoft,
    backgroundColor: theme.colors.ground,
  },
  header: { paddingHorizontal: 6, paddingBottom: 8 },
  headerText: {
    fontFamily: theme.font.bold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: theme.colors.textDim,
  },
  rows: { gap: 2 },
  row: { paddingVertical: 5, paddingEnd: 8, borderRadius: 7 },
  rowOn: { backgroundColor: theme.colors.accentSoft },
  folder: { fontFamily: theme.font.body, fontSize: 13, color: theme.colors.textSecondary },
  file: { fontFamily: theme.font.mono, fontSize: 12, color: theme.colors.textSecondary },
  fileOn: { color: theme.colors.text },
  note: { ...theme.type.meta, color: theme.colors.textMuted, paddingVertical: 5 },
  opError: { ...theme.type.meta, color: theme.colors.danger, paddingHorizontal: 6 },
  renameBox: { paddingBottom: 6 },
});
