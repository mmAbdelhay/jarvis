// Collection -> folder -> request drill-down (Behaviour rule 1). Purely a
// view over `ApiTree` — every path shown is a `Record`'s own field, never
// re-derived; tapping a request hands its `path` straight back to the
// caller, which is what `readRequest`/CRUD actions key on.
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { ApiFolder, ApiTree } from "@/lib/api-store";
import { t } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { theme } from "@/lib/theme";

type TreeCallbacks = {
  onSelectRequest: (path: string) => void;
  onAddRequest: (folderPath: string) => void;
  onAddFolder: (parentPath: string) => void;
  onDeleteEntry: (path: string, isFolder: boolean) => void;
  /** Fix round 1 (I5): collection/folder/request rename — the brief's own
   *  "collection/folder/request create/rename/delete" (store already
   *  supports it via ApiAction "rename"; only the row-level affordance was
   *  missing here). */
  onRenameEntry: (path: string, isFolder: boolean, currentName: string) => void;
};

function FolderView(
  props: {
    folder: ApiFolder;
    depth: number;
    selectedRequestPath: string | undefined;
    language: Language;
  } & TreeCallbacks,
) {
  const indent = { paddingStart: theme.spacing.md * props.depth };
  return (
    <View>
      {props.depth > 0 && (
        <View style={[styles.folderRow, indent]}>
          <Text style={styles.folderName}>{props.folder.name}</Text>
          <View style={styles.rowActions}>
            <TouchableOpacity
              onPress={() => props.onRenameEntry(props.folder.path, true, props.folder.name)}
            >
              <Text style={styles.rename}>{t(props.language, "api.rename.title")}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => props.onDeleteEntry(props.folder.path, true)}>
              <Text style={styles.remove}>{t(props.language, "api.kv.remove")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      {props.folder.requests.map((request) => (
        <View
          key={request.path}
          style={[
            styles.requestRow,
            indent,
            request.path === props.selectedRequestPath ? styles.requestRowSelected : undefined,
          ]}
        >
          <TouchableOpacity
            style={styles.requestMain}
            onPress={() => props.onSelectRequest(request.path)}
            accessibilityRole="button"
          >
            <Text style={styles.method}>{request.method.toUpperCase()}</Text>
            <Text style={styles.requestName} numberOfLines={1}>
              {request.name}
            </Text>
          </TouchableOpacity>
          <View style={styles.rowActions}>
            <TouchableOpacity
              onPress={() => props.onRenameEntry(request.path, false, request.name)}
            >
              <Text style={styles.rename}>{t(props.language, "api.rename.title")}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => props.onDeleteEntry(request.path, false)}>
              <Text style={styles.remove}>{t(props.language, "api.kv.remove")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ))}
      {props.folder.folders.map((child) => (
        <FolderView
          key={child.path}
          folder={child}
          depth={props.depth + 1}
          selectedRequestPath={props.selectedRequestPath}
          onSelectRequest={props.onSelectRequest}
          onAddRequest={props.onAddRequest}
          onAddFolder={props.onAddFolder}
          onDeleteEntry={props.onDeleteEntry}
          onRenameEntry={props.onRenameEntry}
          language={props.language}
        />
      ))}
      <View style={[styles.addRow, { paddingStart: theme.spacing.md * (props.depth + 1) }]}>
        <TouchableOpacity onPress={() => props.onAddRequest(props.folder.path)}>
          <Text style={styles.addText}>{t(props.language, "api.tree.addRequest")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => props.onAddFolder(props.folder.path)}>
          <Text style={styles.addText}>{t(props.language, "api.tree.addFolder")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function CollectionTree(
  props: {
    tree: ApiTree | undefined;
    loading: boolean;
    selectedRequestPath: string | undefined;
    language: Language;
  } & TreeCallbacks,
) {
  if (props.loading) {
    return <Text style={styles.empty}>{t(props.language, "api.tree.loading")}</Text>;
  }
  if (props.tree === undefined) {
    return <Text style={styles.empty}>{t(props.language, "api.tree.none")}</Text>;
  }
  return (
    <View style={styles.container}>
      <FolderView
        folder={props.tree.root}
        depth={0}
        selectedRequestPath={props.selectedRequestPath}
        onSelectRequest={props.onSelectRequest}
        onAddRequest={props.onAddRequest}
        onAddFolder={props.onAddFolder}
        onDeleteEntry={props.onDeleteEntry}
        onRenameEntry={props.onRenameEntry}
        language={props.language}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: theme.spacing.xs },
  folderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: theme.spacing.xs,
  },
  folderName: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.medium,
  },
  requestRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.radius.sm,
  },
  requestRowSelected: { backgroundColor: theme.colors.surfaceAlt },
  requestMain: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm, flex: 1 },
  method: {
    color: theme.colors.primary,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.bold,
    width: 48,
  },
  requestName: { color: theme.colors.text, flex: 1 },
  rowActions: { flexDirection: "row", gap: theme.spacing.sm },
  addRow: { flexDirection: "row", gap: theme.spacing.md, paddingVertical: theme.spacing.xs },
  addText: { color: theme.colors.primary, fontSize: theme.font.size.sm },
  rename: { color: theme.colors.primary, fontSize: theme.font.size.sm },
  remove: { color: theme.colors.danger, fontSize: theme.font.size.sm },
  empty: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
});
