// The per-project API screen (M9 Task 5): collection -> folder -> request
// drill-down, the request editor (method/URL/query/headers/auth/body,
// environment/variables), send/save/cURL, response, history/cookies/
// settings reads, CRUD and Postman import. All decision logic lives in
// api-store.ts/file-upload-controller.ts/file-picker.ts; this file is
// layout, native picker wiring and the two-step (upload -> confirm)
// import flow that api-store.ts deliberately doesn't own (remote:
// uploadFile/readJsonUpload are not `api:*` channels).
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { CollectionTree } from "@/components/api/CollectionTree";
import { KeyValueRows } from "@/components/api/KeyValueRows";
import { ResponseView } from "@/components/api/ResponseView";
import { SecretField } from "@/components/api/SecretField";
import type { ApiAction, ApiCollection, ApiVariable, ApiView } from "@/lib/api-store";
import {
  API_ACTION_BUSY,
  API_CAPABILITY_MISSING,
  API_LOAD_FAILED,
  createApiStore,
} from "@/lib/api-store";
import {
  rowsField,
  rowsFromArray,
  rowsToPlain,
  splitParams,
  stampQueryType,
} from "@/lib/api-screen";
import type { FileUploadResult } from "@/lib/file-upload-controller";
import { createFileUploadController } from "@/lib/file-upload-controller";
import { nativeFilePicker } from "@/lib/file-picker";
import { formatBytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { nativeRecordingFiles } from "@/lib/native-recording-files";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";
import { MALFORMED_REPLY_NOTICE, parseGitViewResult } from "@/lib/workspace-results";

const NOTICE_KEYS: Readonly<Record<string, string>> = {
  [API_LOAD_FAILED]: "api.loadFailed",
  [API_ACTION_BUSY]: "api.busy",
  [API_CAPABILITY_MISSING]: "api.capabilityMissing",
  [MALFORMED_REPLY_NOTICE]: "api.loadFailed",
};

function noticeText(notice: string, language: Language): string {
  const key = NOTICE_KEYS[notice];
  // biome-ignore lint/suspicious/noExplicitAny: MessageKey is a large literal union; the NOTICE_KEYS table above is the only source of these strings.
  return key ? t(language, key as any) : notice;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const BODY_MODES = ["none", "json", "text", "graphql", "formUrlEncoded", "multipartForm"] as const;
const AUTH_MODES = ["none", "inherit", "bearer", "basic", "apikey"] as const;

function httpField(draft: Record<string, unknown> | undefined): {
  method: string;
  url: string;
  auth: string;
  body: string;
} {
  const http = isRecord(draft?.http) ? (draft?.http as Record<string, unknown>) : {};
  return {
    method: typeof http.method === "string" ? http.method : "get",
    url: typeof http.url === "string" ? http.url : "",
    auth: typeof http.auth === "string" ? http.auth : "none",
    body: typeof http.body === "string" ? http.body : "none",
  };
}

function bodyBlock(draft: Record<string, unknown> | undefined): Record<string, unknown> {
  return isRecord(draft?.body) ? (draft?.body as Record<string, unknown>) : {};
}

function authBlock(draft: Record<string, unknown> | undefined): Record<string, unknown> {
  return isRecord(draft?.auth) ? (draft?.auth as Record<string, unknown>) : {};
}

function requestName(draft: Record<string, unknown> | undefined): string {
  const meta = isRecord(draft?.meta) ? (draft?.meta as Record<string, unknown>) : {};
  return typeof meta.name === "string" ? meta.name : "";
}

/** A rough, client-side estimate only — the real conversion (and its own
 *  cap) happens server-side (postmanToRequests / MAX_IMPORT_REQUESTS).
 *  Shown to the user before the Import tap so they know roughly what
 *  they're about to write; a malformed/unexpected shape just counts 0
 *  rather than throwing. */
function countPostmanRequests(collection: unknown): number {
  function walk(node: unknown): number {
    if (!isRecord(node)) return 0;
    const items = Array.isArray(node.item) ? node.item : [];
    let count = 0;
    for (const item of items) {
      if (!isRecord(item)) continue;
      count += item.request !== undefined ? 1 : walk(item);
    }
    return count;
  }
  return walk(collection);
}

export default function ApiScreen() {
  const language = useLanguage();
  const client = useRpcClient();
  const { project } = useLocalSearchParams<{ project: string }>();
  const projectName = typeof project === "string" ? project : "";

  const store = useMemo(() => createApiStore({ client }), [client]);
  const uploadController = useMemo(
    () =>
      createFileUploadController({ client, files: nativeRecordingFiles, picker: nativeFilePicker }),
    [client],
  );

  const [view, setView] = useState<ApiView>(store.get());
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<"editor" | "history" | "cookies" | "settings">("editor");
  const [addingIn, setAddingIn] = useState<
    { parentPath: string; kind: "request" | "folder" } | undefined
  >(undefined);
  const [addName, setAddName] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [importing, setImporting] = useState<
    { name: string; collection: unknown; count: number } | undefined
  >(undefined);
  // Fix round 1 (I6/I10): shared across both upload triggers (Import and
  // multipart Attach) — the controller only ever runs one at a time
  // (`{ kind: "busy" }` refuses a second), so one shared "uploading" flag
  // and progress line covers either.
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ sent: number; total: number } | undefined>(
    undefined,
  );
  // Fix round 1 (I5): rename (collection/folder/request).
  const [renaming, setRenaming] = useState<{ path: string; isFolder: boolean } | undefined>(
    undefined,
  );
  const [renameName, setRenameName] = useState("");
  // Fix round 1 (I5): the ad-hoc variables editor masks a variable by name
  // if the last environment the user picked marked it secret — ApiView.
  // variables is a plain Record<string,string> (no secret flag of its
  // own), so this is remembered purely for the editor's own masking, never
  // sent anywhere.
  const [secretVariableNames, setSecretVariableNames] = useState<Set<string>>(new Set());
  const [selectedEnvironmentName, setSelectedEnvironmentName] = useState<string | undefined>(
    undefined,
  );
  const [environmentSaveName, setEnvironmentSaveName] = useState("");

  useFocusEffect(
    useCallback(() => {
      const unsubscribe = store.subscribe(setView);
      store.open(projectName);
      setView(store.get());
      return () => {
        unsubscribe();
        store.close();
        // Fix round 1 (I2): cancel(), not dispose() — a blur must stop any
        // pick/upload in flight, but `uploadController` is memoized by
        // `client` and stays alive across this screen's own focus/blur
        // cycles; dispose()-ing it here would permanently break Import/
        // Attach after the very first blur. dispose() is reserved for the
        // component's real unmount, below.
        uploadController.cancel();
      };
    }, [store, uploadController, projectName]),
  );

  // True unmount only (not a mere blur) — useFocusEffect's own cleanup
  // above already handles every blur.
  useEffect(() => {
    return () => {
      uploadController.dispose();
    };
  }, [uploadController]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    // Fix round 1 (I3): refresh() re-reads collections (and the selected
    // tree) without resetting the draft/selection the way open() again
    // would.
    store.refresh();
    setTimeout(() => setRefreshing(false), 250);
  }, [store]);

  function invoke(action: ApiAction): void {
    void store.invoke(action);
  }

  function selectCollection(collection: ApiCollection): void {
    store.readTree(collection.path);
  }

  function confirmDelete(path: string, isFolder: boolean, name: string): void {
    Alert.alert(t(language, "api.confirmDelete", { name }), undefined, [
      { text: t(language, "common.cancel"), style: "cancel" },
      {
        text: t(language, "common.ok"),
        style: "destructive",
        onPress: () => invoke({ kind: "delete", path }),
      },
    ]);
    void isFolder;
  }

  function startAdd(parentPath: string, kind: "request" | "folder"): void {
    setAddingIn({ parentPath, kind });
    setAddName("");
  }

  function confirmAdd(): void {
    if (addingIn === undefined || addName.trim() === "") return;
    if (addingIn.kind === "folder") {
      invoke({ kind: "createFolder", parentPath: addingIn.parentPath, name: addName.trim() });
    } else {
      invoke({
        kind: "createRequest",
        folderPath: addingIn.parentPath,
        name: addName.trim(),
        seq: 0,
      });
    }
    setAddingIn(undefined);
    setAddName("");
  }

  function createCollection(): void {
    if (newCollectionName.trim() === "") return;
    invoke({ kind: "createCollection", name: newCollectionName.trim() });
    setNewCollectionName("");
  }

  // Fix round 1 (I5): a whole collection is just another `delete` target —
  // the same api:delete channel createApiCollection's counterpart uses —
  // confirmed the same way as a folder/request delete.
  function confirmDeleteCollection(collection: ApiCollection): void {
    Alert.alert(t(language, "api.confirmDelete", { name: collection.name }), undefined, [
      { text: t(language, "common.cancel"), style: "cancel" },
      {
        text: t(language, "common.ok"),
        style: "destructive",
        onPress: () => invoke({ kind: "delete", path: collection.path }),
      },
    ]);
  }

  function startRename(path: string, isFolder: boolean, currentName: string): void {
    setRenaming({ path, isFolder });
    setRenameName(currentName);
  }

  function confirmRename(): void {
    if (renaming === undefined || renameName.trim() === "") return;
    invoke({
      kind: "rename",
      path: renaming.path,
      name: renameName.trim(),
      isFolder: renaming.isFolder,
    });
    setRenaming(undefined);
    setRenameName("");
  }

  // Fix round 1 (I5): picking an environment loads its variables as the
  // draft's ad-hoc `variables` (send/curl/save all read from there) and
  // remembers which names were marked secret, purely so the editor below
  // masks the same ones.
  function selectEnvironment(name: string, variables: ApiVariable[]): void {
    setSelectedEnvironmentName(name);
    const next: Record<string, string> = {};
    const secret = new Set<string>();
    for (const variable of variables) {
      if (!variable.enabled) continue;
      next[variable.name] = variable.value;
      if (variable.secret) secret.add(variable.name);
    }
    store.setVariables(next);
    setSecretVariableNames(secret);
  }

  function selectAdHocEnvironment(): void {
    setSelectedEnvironmentName(undefined);
  }

  function saveEnvironment(): void {
    const collectionPath = view.selectedCollectionPath;
    if (collectionPath === undefined || environmentSaveName.trim() === "") return;
    const variables: ApiVariable[] = Object.entries(view.variables).map(([name, value]) => ({
      name,
      value,
      enabled: true,
      secret: secretVariableNames.has(name),
    }));
    invoke({
      kind: "saveEnvironment",
      collectionPath,
      name: environmentSaveName.trim(),
      variables,
    });
  }

  function setDraftPatch(patch: Record<string, unknown>): void {
    store.setDraft({ ...(view.draft ?? {}), ...patch });
  }

  function setHttpPatch(patch: Record<string, unknown>): void {
    setDraftPatch({ http: { ...httpField(view.draft), ...patch } });
  }

  function setBodyPatch(patch: Record<string, unknown>): void {
    setDraftPatch({ body: { ...bodyBlock(view.draft), ...patch } });
  }

  function setAuthPatch(patch: Record<string, unknown>): void {
    setDraftPatch({ auth: { ...authBlock(view.draft), ...patch } });
  }

  // Fix round 1 (I6/I10): the one place either upload trigger goes
  // through — shows a shared progress line while it runs and always
  // clears it, however the attempt ends.
  async function runUpload(): Promise<FileUploadResult> {
    setUploadBusy(true);
    setUploadProgress(undefined);
    const result = await uploadController.pickAndUpload((sent, total) =>
      setUploadProgress({ sent, total }),
    );
    setUploadBusy(false);
    setUploadProgress(undefined);
    return result;
  }

  // Fix round 1 (I6): every non-"ok" FileUploadResult gets its own message
  // — "cancelled" alone stays silent (the user's own no-op), never an
  // Alert.
  function showUploadFailure(result: FileUploadResult): void {
    switch (result.kind) {
      case "ok":
      case "cancelled":
        return;
      case "overLimit":
        Alert.alert(t(language, "api.upload.overLimit"));
        return;
      case "busy":
        Alert.alert(t(language, "api.upload.busy"));
        return;
      case "offline":
        Alert.alert(t(language, "api.upload.offline"));
        return;
      case "refused":
        // Server-originated text, shown verbatim (global-constraints.md
        // rule 7) — never routed through the i18n table.
        Alert.alert(result.text);
        return;
      case "failed":
        Alert.alert(t(language, "api.upload.failed"));
    }
  }

  async function pickImportFile(): Promise<void> {
    const result = await runUpload();
    if (result.kind !== "ok") {
      showUploadFailure(result);
      return;
    }
    const uploaded = result.file;
    const jsonResult = await client.call("remote:readJsonUpload", [uploaded.fileId], {
      whenNotOpen: "reject",
    });
    if (!jsonResult.ok) {
      Alert.alert(t(language, "api.import.failed"));
      return;
    }
    // Fix round 1 (I7): parsed with the same GitViewResult convention
    // every other server reply on this screen uses — a real refusal shows
    // the laptop's own text verbatim; only a reply that fails to parse at
    // all falls back to this screen's own translated message.
    const parsed = parseGitViewResult(jsonResult.value, (v) => (v === undefined ? undefined : v));
    if (!parsed.ok) {
      Alert.alert(
        parsed.text === MALFORMED_REPLY_NOTICE ? t(language, "api.import.failed") : parsed.text,
      );
      return;
    }
    const collection = parsed.value;
    setImporting({
      name: uploaded.name.replace(/\.json$/i, ""),
      collection,
      count: countPostmanRequests(collection),
    });
  }

  function confirmImport(): void {
    if (importing === undefined) return;
    invoke({ kind: "importPostman", name: importing.name, collection: importing.collection });
    setImporting(undefined);
  }

  const http = httpField(view.draft);
  const body = bodyBlock(view.draft);
  const auth = authBlock(view.draft);
  const { path: pathParams, query: queryParams } = splitParams(view.draft);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={theme.colors.primary}
        />
      }
    >
      <Stack.Screen options={{ title: projectName || t(language, "api.title") }} />

      {view.phase === "loading" && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      )}
      {view.notice !== undefined && (
        <Text selectable style={styles.error}>
          {noticeText(view.notice, language)}
        </Text>
      )}
      {view.uncertain && <Text style={styles.warning}>{t(language, "api.uncertain")}</Text>}
      {view.stale && <Text style={styles.warning}>{t(language, "common.stale")}</Text>}

      <Text style={styles.sectionTitle}>{t(language, "api.collections.title")}</Text>
      {view.collections.length === 0 && view.phase === "ready" && (
        <Text style={styles.empty}>{t(language, "api.noCollections")}</Text>
      )}
      <ScrollView horizontal contentContainerStyle={styles.chipRow}>
        {view.collections.map((collection) => (
          <TouchableOpacity
            key={collection.path}
            style={[
              styles.chip,
              collection.path === view.selectedCollectionPath ? styles.chipActive : undefined,
            ]}
            onPress={() => selectCollection(collection)}
            accessibilityRole="button"
          >
            <Text style={styles.chipText}>{collection.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <View style={styles.addRow}>
        <TextInput
          style={styles.smallInput}
          value={newCollectionName}
          onChangeText={setNewCollectionName}
          placeholder={t(language, "api.newCollection.placeholder")}
          placeholderTextColor={theme.colors.textMuted}
        />
        <TouchableOpacity
          style={styles.smallButton}
          onPress={createCollection}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>{t(language, "api.newCollection")}</Text>
        </TouchableOpacity>
      </View>

      {view.selectedCollectionPath !== undefined && (
        <>
          <TouchableOpacity
            style={styles.smallButton}
            onPress={() => {
              const collection = view.collections.find(
                (c) => c.path === view.selectedCollectionPath,
              );
              if (collection !== undefined) confirmDeleteCollection(collection);
            }}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t(language, "api.collection.delete")}</Text>
          </TouchableOpacity>
          <CollectionTree
            tree={view.tree}
            loading={view.treeLoading}
            selectedRequestPath={view.selectedRequestPath}
            onSelectRequest={(path) => store.readRequest(path)}
            onAddRequest={(folderPath) => startAdd(folderPath, "request")}
            onAddFolder={(parentPath) => startAdd(parentPath, "folder")}
            onDeleteEntry={(path, isFolder) => confirmDelete(path, isFolder, path)}
            onRenameEntry={(path, isFolder, currentName) =>
              startRename(path, isFolder, currentName)
            }
            language={language}
          />
        </>
      )}

      {renaming !== undefined && (
        <View style={styles.addRow}>
          <TextInput
            style={styles.smallInput}
            value={renameName}
            onChangeText={setRenameName}
            placeholder={t(language, "api.kv.name")}
            placeholderTextColor={theme.colors.textMuted}
            autoFocus
          />
          <TouchableOpacity
            style={styles.smallButton}
            onPress={confirmRename}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t(language, "common.ok")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.smallButton} onPress={() => setRenaming(undefined)}>
            <Text style={styles.buttonText}>{t(language, "common.cancel")}</Text>
          </TouchableOpacity>
        </View>
      )}

      {addingIn !== undefined && (
        <View style={styles.addRow}>
          <TextInput
            style={styles.smallInput}
            value={addName}
            onChangeText={setAddName}
            placeholder={t(language, "api.kv.name")}
            placeholderTextColor={theme.colors.textMuted}
            autoFocus
          />
          <TouchableOpacity
            style={styles.smallButton}
            onPress={confirmAdd}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t(language, "common.ok")}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.smallButton} onPress={() => setAddingIn(undefined)}>
            <Text style={styles.buttonText}>{t(language, "common.cancel")}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.tabRow}>
        {(["editor", "history", "cookies", "settings"] as const).map((tabKey) => (
          <TouchableOpacity
            key={tabKey}
            style={[styles.tabButton, tab === tabKey ? styles.tabButtonActive : undefined]}
            onPress={() => setTab(tabKey)}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t(language, `api.tabs.${tabKey}`)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === "editor" && (
        <View style={styles.section}>
          {view.selectedRequestPath === undefined ? (
            <Text style={styles.empty}>{t(language, "api.request.noneSelected")}</Text>
          ) : (
            <>
              <Text style={styles.label}>
                {requestName(view.draft) || view.selectedRequestPath}
              </Text>
              {view.dirty && <Text style={styles.warning}>{t(language, "api.request.dirty")}</Text>}

              <Text style={styles.label}>{t(language, "api.request.method")}</Text>
              <ScrollView horizontal contentContainerStyle={styles.chipRow}>
                {HTTP_METHODS.map((method) => (
                  <TouchableOpacity
                    key={method}
                    style={[styles.chip, http.method === method ? styles.chipActive : undefined]}
                    onPress={() => setHttpPatch({ method })}
                    accessibilityRole="button"
                  >
                    <Text style={styles.chipText}>{method.toUpperCase()}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={styles.label}>{t(language, "api.request.url")}</Text>
              <TextInput
                style={[styles.input, { writingDirection: "ltr" }]}
                value={http.url}
                onChangeText={(url) => setHttpPatch({ url })}
                placeholder="https://…"
                placeholderTextColor={theme.colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />

              {pathParams.length > 0 && (
                <>
                  <Text style={styles.label}>{t(language, "api.request.pathParams")}</Text>
                  <View style={styles.list}>
                    {pathParams.map((row, index) => (
                      <View key={row.name || index} style={styles.pathRow}>
                        <Text style={styles.pathName}>{row.name}</Text>
                        <TextInput
                          style={styles.input}
                          value={row.value}
                          onChangeText={(value) => {
                            const next = pathParams.map((p, i) =>
                              i === index ? { ...p, value } : p,
                            );
                            setDraftPatch({
                              params: rowsToPlain([...next, ...stampQueryType(queryParams)]),
                            });
                          }}
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                      </View>
                    ))}
                  </View>
                </>
              )}

              <Text style={styles.label}>{t(language, "api.request.query")}</Text>
              <KeyValueRows
                rows={queryParams}
                onChange={(rows) =>
                  setDraftPatch({ params: rowsToPlain([...pathParams, ...stampQueryType(rows)]) })
                }
                language={language}
                addLabel={t(language, "api.kv.add")}
              />

              <Text style={styles.label}>{t(language, "api.request.headers")}</Text>
              <KeyValueRows
                rows={rowsField(view.draft, "headers")}
                onChange={(rows) => setDraftPatch({ headers: rowsToPlain(rows) })}
                language={language}
                addLabel={t(language, "api.kv.add")}
              />

              <Text style={styles.label}>{t(language, "api.request.auth")}</Text>
              <ScrollView horizontal contentContainerStyle={styles.chipRow}>
                {AUTH_MODES.map((mode) => (
                  <TouchableOpacity
                    key={mode}
                    style={[styles.chip, http.auth === mode ? styles.chipActive : undefined]}
                    onPress={() => setHttpPatch({ auth: mode })}
                    accessibilityRole="button"
                  >
                    <Text style={styles.chipText}>{t(language, `api.auth.${mode}`)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              {http.auth === "bearer" && (
                <SecretField
                  value={
                    typeof (isRecord(auth.bearer) ? auth.bearer.token : undefined) === "string"
                      ? ((auth.bearer as Record<string, unknown>).token as string)
                      : ""
                  }
                  onChangeText={(token) => setAuthPatch({ bearer: { token } })}
                  secret
                  language={language}
                  placeholder={t(language, "api.auth.token")}
                />
              )}
              {http.auth === "basic" && (
                <View style={styles.list}>
                  <TextInput
                    style={styles.input}
                    value={
                      typeof (isRecord(auth.basic) ? auth.basic.username : undefined) === "string"
                        ? ((auth.basic as Record<string, unknown>).username as string)
                        : ""
                    }
                    onChangeText={(username) =>
                      setAuthPatch({
                        basic: { ...(isRecord(auth.basic) ? auth.basic : {}), username },
                      })
                    }
                    placeholder={t(language, "api.auth.username")}
                    placeholderTextColor={theme.colors.textMuted}
                    autoCapitalize="none"
                  />
                  <SecretField
                    value={
                      typeof (isRecord(auth.basic) ? auth.basic.password : undefined) === "string"
                        ? ((auth.basic as Record<string, unknown>).password as string)
                        : ""
                    }
                    onChangeText={(password) =>
                      setAuthPatch({
                        basic: { ...(isRecord(auth.basic) ? auth.basic : {}), password },
                      })
                    }
                    secret
                    language={language}
                    placeholder={t(language, "api.auth.password")}
                  />
                </View>
              )}
              {http.auth === "apikey" && (
                <View style={styles.list}>
                  <TextInput
                    style={styles.input}
                    value={
                      typeof (isRecord(auth.apikey) ? auth.apikey.key : undefined) === "string"
                        ? ((auth.apikey as Record<string, unknown>).key as string)
                        : ""
                    }
                    onChangeText={(key) =>
                      setAuthPatch({
                        apikey: { ...(isRecord(auth.apikey) ? auth.apikey : {}), key },
                      })
                    }
                    placeholder={t(language, "api.auth.apikeyKey")}
                    placeholderTextColor={theme.colors.textMuted}
                    autoCapitalize="none"
                  />
                  <SecretField
                    value={
                      typeof (isRecord(auth.apikey) ? auth.apikey.value : undefined) === "string"
                        ? ((auth.apikey as Record<string, unknown>).value as string)
                        : ""
                    }
                    onChangeText={(value) =>
                      setAuthPatch({
                        apikey: { ...(isRecord(auth.apikey) ? auth.apikey : {}), value },
                      })
                    }
                    secret
                    language={language}
                    placeholder={t(language, "api.auth.apikeyValue")}
                  />
                </View>
              )}
              {http.auth === "oauth2" && (
                <Text style={styles.warning}>
                  {t(language, "api.warning.oauthSettingsLaptopOnly")}
                </Text>
              )}

              <Text style={styles.label}>{t(language, "api.request.body")}</Text>
              <ScrollView horizontal contentContainerStyle={styles.chipRow}>
                {BODY_MODES.map((mode) => (
                  <TouchableOpacity
                    key={mode}
                    style={[styles.chip, http.body === mode ? styles.chipActive : undefined]}
                    onPress={() => setHttpPatch({ body: mode })}
                    accessibilityRole="button"
                  >
                    <Text style={styles.chipText}>
                      {mode === "json"
                        ? "JSON"
                        : mode === "graphql"
                          ? "GraphQL"
                          : t(language, `api.body.${mode}`)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              {(http.body === "json" || http.body === "text") && (
                <TextInput
                  style={[styles.input, styles.multiline, { writingDirection: "ltr" }]}
                  value={typeof body[http.body] === "string" ? (body[http.body] as string) : ""}
                  onChangeText={(text) => setBodyPatch({ [http.body]: text })}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              )}
              {http.body === "graphql" && (
                <TextInput
                  style={[styles.input, styles.multiline, { writingDirection: "ltr" }]}
                  value={
                    isRecord(body.graphql) && typeof body.graphql.query === "string"
                      ? (body.graphql.query as string)
                      : ""
                  }
                  onChangeText={(query) =>
                    setBodyPatch({
                      graphql: { ...(isRecord(body.graphql) ? body.graphql : {}), query },
                    })
                  }
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              )}
              {http.body === "formUrlEncoded" && (
                <KeyValueRows
                  rows={rowsFromArray(body.formUrlEncoded)}
                  onChange={(rows) => setBodyPatch({ formUrlEncoded: rowsToPlain(rows) })}
                  language={language}
                  addLabel={t(language, "api.kv.add")}
                />
              )}
              {http.body === "multipartForm" && (
                <View style={styles.list}>
                  <TouchableOpacity
                    style={styles.smallButton}
                    disabled={uploadBusy}
                    onPress={async () => {
                      const result = await runUpload();
                      if (result.kind !== "ok") {
                        showUploadFailure(result);
                        return;
                      }
                      const existing = Array.isArray(body.multipartForm) ? body.multipartForm : [];
                      setBodyPatch({
                        multipartForm: [
                          ...existing,
                          {
                            name: result.file.name,
                            type: "file",
                            value: [{ uploadId: result.file.fileId }],
                          },
                        ],
                      });
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.buttonText}>{t(language, "api.multipart.attach")}</Text>
                  </TouchableOpacity>
                  {/* Fix round 1 (I9): a multipart part's `name` (the form
                   *  field name the server reads, not the file's own name)
                   *  and its optional `contentType` are editable — attach
                   *  no longer freezes the field at whatever the picked
                   *  file happened to be called. */}
                  {Array.isArray(body.multipartForm) &&
                    body.multipartForm.map((field, index) => {
                      if (!isRecord(field)) return null;
                      const multipartRows = body.multipartForm as unknown[];
                      function updateField(patch: Record<string, unknown>): void {
                        const next = multipartRows.map((row, i) =>
                          i === index && isRecord(row) ? { ...row, ...patch } : row,
                        );
                        setBodyPatch({ multipartForm: next });
                      }
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: append-only local list, no stable id.
                        <View key={index} style={styles.pathRow}>
                          <TextInput
                            style={[styles.input, styles.nameInputFlex]}
                            value={typeof field.name === "string" ? field.name : ""}
                            onChangeText={(name) => updateField({ name })}
                            placeholder={t(language, "api.multipart.fieldName")}
                            placeholderTextColor={theme.colors.textMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                          />
                          {field.type === "file" && (
                            <TextInput
                              style={[styles.input, styles.nameInputFlex]}
                              value={typeof field.contentType === "string" ? field.contentType : ""}
                              onChangeText={(contentType) => updateField({ contentType })}
                              placeholder={t(language, "api.multipart.fieldContentType")}
                              placeholderTextColor={theme.colors.textMuted}
                              autoCapitalize="none"
                              autoCorrect={false}
                            />
                          )}
                          <TouchableOpacity
                            onPress={() =>
                              setBodyPatch({
                                multipartForm: multipartRows.filter((_, i) => i !== index),
                              })
                            }
                          >
                            <Text style={styles.remove}>{t(language, "api.kv.remove")}</Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                </View>
              )}

              <Text style={styles.warning}>{t(language, "api.warning.hooksSend")}</Text>
              <Text style={styles.warning}>{t(language, "api.warning.hooksSave")}</Text>
              <Text style={styles.warning}>{t(language, "api.warning.attachmentsTemporary")}</Text>

              <Text style={styles.label}>{t(language, "api.environment.title")}</Text>
              <ScrollView horizontal contentContainerStyle={styles.chipRow}>
                <TouchableOpacity
                  style={[
                    styles.chip,
                    selectedEnvironmentName === undefined ? styles.chipActive : undefined,
                  ]}
                  onPress={selectAdHocEnvironment}
                  accessibilityRole="button"
                >
                  <Text style={styles.chipText}>{t(language, "api.environment.none")}</Text>
                </TouchableOpacity>
                {(view.tree?.environments ?? []).map((environment) => (
                  <TouchableOpacity
                    key={environment.path}
                    style={[
                      styles.chip,
                      selectedEnvironmentName === environment.name ? styles.chipActive : undefined,
                    ]}
                    onPress={() => selectEnvironment(environment.name, environment.variables)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.chipText}>{environment.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={styles.label}>{t(language, "api.request.variables")}</Text>
              <KeyValueRows
                rows={Object.entries(view.variables).map(([name, value]) => ({
                  name,
                  value,
                  enabled: true,
                  secret: secretVariableNames.has(name),
                }))}
                onChange={(rows) => {
                  const next: Record<string, string> = {};
                  const secret = new Set<string>();
                  for (const row of rows) {
                    if (row.name === "") continue;
                    next[row.name] = row.value;
                    if (row.secret === true) secret.add(row.name);
                  }
                  store.setVariables(next);
                  setSecretVariableNames(secret);
                }}
                language={language}
                addLabel={t(language, "api.kv.add")}
              />
              <View style={styles.addRow}>
                <TextInput
                  style={styles.smallInput}
                  value={environmentSaveName}
                  onChangeText={setEnvironmentSaveName}
                  placeholder={t(language, "api.environment.namePlaceholder")}
                  placeholderTextColor={theme.colors.textMuted}
                />
                <TouchableOpacity
                  style={styles.smallButton}
                  disabled={view.selectedCollectionPath === undefined}
                  onPress={saveEnvironment}
                  accessibilityRole="button"
                >
                  <Text style={styles.buttonText}>{t(language, "api.environment.save")}</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.button}
                  disabled={view.busy}
                  onPress={() => invoke({ kind: "send" })}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryButtonText}>{t(language, "api.request.send")}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.button}
                  disabled={view.busy || !view.dirty}
                  onPress={() => invoke({ kind: "save" })}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryButtonText}>{t(language, "api.request.save")}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.smallButton}
                  disabled={view.busy}
                  onPress={() => invoke({ kind: "curl" })}
                  accessibilityRole="button"
                >
                  <Text style={styles.buttonText}>cURL</Text>
                </TouchableOpacity>
              </View>
              {view.curlText !== undefined && (
                <Text selectable style={[styles.curlText, { writingDirection: "ltr" }]}>
                  {view.curlText}
                </Text>
              )}

              <Text style={styles.sectionTitle}>{t(language, "api.response.title")}</Text>
              <ResponseView
                response={view.lastResponse?.response}
                assertions={view.lastResponse?.assertions ?? []}
                language={language}
              />
            </>
          )}
        </View>
      )}

      {tab === "history" && (
        <View style={styles.section}>
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.smallButton}
              onPress={() => invoke({ kind: "history" })}
            >
              <Text style={styles.buttonText}>{t(language, "common.retry")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.smallButton}
              onPress={() =>
                Alert.alert(t(language, "api.history.clear"), undefined, [
                  { text: t(language, "common.cancel"), style: "cancel" },
                  {
                    text: t(language, "common.ok"),
                    style: "destructive",
                    onPress: () => invoke({ kind: "clearHistory" }),
                  },
                ])
              }
            >
              <Text style={styles.buttonText}>{t(language, "api.history.clear")}</Text>
            </TouchableOpacity>
          </View>
          {view.history.length === 0 ? (
            <Text style={styles.empty}>{t(language, "api.history.empty")}</Text>
          ) : (
            view.history.map((entry) => (
              <View key={`${entry.at}:${entry.url}`} style={styles.row}>
                <Text style={styles.rowLabel}>
                  {entry.method.toUpperCase()} {entry.status}
                </Text>
                <Text selectable style={[styles.rowMeta, { writingDirection: "ltr" }]}>
                  {entry.url}
                </Text>
              </View>
            ))
          )}
        </View>
      )}

      {tab === "cookies" && (
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.smallButton}
            onPress={() =>
              Alert.alert(t(language, "api.cookies.clear"), undefined, [
                { text: t(language, "common.cancel"), style: "cancel" },
                {
                  text: t(language, "common.ok"),
                  style: "destructive",
                  onPress: () => invoke({ kind: "clearCookies" }),
                },
              ])
            }
          >
            <Text style={styles.buttonText}>{t(language, "api.cookies.clear")}</Text>
          </TouchableOpacity>
          {view.cookies.length === 0 ? (
            <Text style={styles.empty}>{t(language, "api.cookies.empty")}</Text>
          ) : (
            view.cookies.map((cookie) => (
              <View key={`${cookie.domain}:${cookie.path}:${cookie.name}`} style={styles.row}>
                <Text style={styles.rowLabel}>{cookie.name}</Text>
                <Text style={styles.rowMeta}>{cookie.domain}</Text>
                <TouchableOpacity
                  onPress={() =>
                    invoke({
                      kind: "removeCookie",
                      name: cookie.name,
                      domain: cookie.domain,
                      path: cookie.path,
                    })
                  }
                >
                  <Text style={styles.remove}>{t(language, "api.kv.remove")}</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
      )}

      {tab === "settings" && (
        <View style={styles.section}>
          <TouchableOpacity style={styles.smallButton} onPress={() => invoke({ kind: "settings" })}>
            <Text style={styles.buttonText}>{t(language, "api.settings.load")}</Text>
          </TouchableOpacity>
          {view.settings !== undefined && (
            <View style={styles.list}>
              <Text style={styles.rowMeta}>
                {t(language, "api.settings.proxy", { value: view.settings.proxyUrl || "—" })}
              </Text>
              <Text style={styles.rowMeta}>
                {t(language, "api.settings.verifyCertificate", {
                  value: view.settings.verifyCertificate ? "✓" : "✕",
                })}
              </Text>
              <Text style={styles.rowMeta}>Timeout: {view.settings.timeoutMs} ms</Text>
            </View>
          )}
          <Text style={styles.warning}>{t(language, "api.settings.laptopOnly")}</Text>
        </View>
      )}

      {/* Fix round 1 (I10): one shared progress line + Cancel button for
       *  whichever upload (Import or a multipart Attach) is currently
       *  running — wired straight to the controller's own cancel()/
       *  onProgress. */}
      {uploadBusy && (
        <View style={styles.addRow}>
          <Text style={styles.rowMeta}>
            {uploadProgress === undefined
              ? t(language, "api.import.uploading")
              : `${formatBytes(uploadProgress.sent, language)} / ${formatBytes(uploadProgress.total, language)}`}
          </Text>
          <TouchableOpacity
            style={styles.smallButton}
            onPress={() => uploadController.cancel()}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{t(language, "api.upload.cancel")}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t(language, "api.import.title")}</Text>
        <TouchableOpacity
          style={styles.smallButton}
          disabled={uploadBusy}
          onPress={() => void pickImportFile()}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>
            {uploadBusy ? t(language, "api.import.uploading") : t(language, "api.import.pick")}
          </Text>
        </TouchableOpacity>
        {importing !== undefined && (
          <View style={styles.list}>
            <TextInput
              style={styles.input}
              value={importing.name}
              onChangeText={(name) => setImporting({ ...importing, name })}
              placeholder={t(language, "api.import.name")}
              placeholderTextColor={theme.colors.textMuted}
            />
            <Text style={styles.rowMeta}>
              {t(language, "api.import.requestCount", { count: importing.count })}
            </Text>
            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.button}
                onPress={confirmImport}
                accessibilityRole="button"
              >
                <Text style={styles.primaryButtonText}>{t(language, "api.import.confirm")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.smallButton}
                onPress={() => setImporting(undefined)}
                accessibilityRole="button"
              >
                <Text style={styles.buttonText}>{t(language, "common.cancel")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.md },
  center: { alignItems: "center", padding: theme.spacing.lg },
  section: { gap: theme.spacing.sm },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
  },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.medium,
  },
  list: { gap: theme.spacing.sm },
  chipRow: { gap: theme.spacing.sm },
  chip: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  chipActive: { backgroundColor: theme.colors.primary },
  chipText: { color: theme.colors.text, fontSize: theme.font.size.sm },
  addRow: { flexDirection: "row", gap: theme.spacing.sm, alignItems: "center" },
  smallInput: {
    flex: 1,
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    borderColor: theme.colors.border,
    borderWidth: 1,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  input: {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    borderColor: theme.colors.border,
    borderWidth: 1,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  pathRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing.sm },
  pathName: {
    width: 96,
    color: theme.colors.textMuted,
    fontFamily: "monospace",
    fontSize: theme.font.size.sm,
  },
  nameInputFlex: { flex: 1 },
  tabRow: { flexDirection: "row", gap: theme.spacing.sm, flexWrap: "wrap" },
  tabButton: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  tabButtonActive: { backgroundColor: theme.colors.primary },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  button: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    alignItems: "center",
  },
  primaryButtonText: { color: theme.colors.primaryText, fontWeight: theme.font.weight.bold },
  smallButton: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    alignItems: "center",
  },
  buttonText: { color: theme.colors.text },
  row: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    gap: 2,
  },
  rowLabel: {
    color: theme.colors.text,
    fontSize: theme.font.size.sm,
    fontWeight: theme.font.weight.medium,
  },
  rowMeta: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  remove: { color: theme.colors.danger, fontSize: theme.font.size.sm },
  curlText: {
    color: theme.colors.text,
    fontFamily: "monospace",
    fontSize: theme.font.size.sm,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
  },
  empty: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  warning: { color: theme.colors.warning, fontSize: theme.font.size.sm },
  error: { color: theme.colors.danger, fontSize: theme.font.size.sm },
});
