// The per-project sidecars screen (task-6-brief.md, rule 4): Editor,
// Database and Cluster rows, or the LAN-only hint when the pairing has no
// `name` (ruling 12). All decision logic lives in sidecars-store.ts; this
// file is layout only — it reads the pairing record once on mount (the
// same `loadPairing` read every other screen uses), builds the store from
// it, and re-runs `load()` on focus.
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { STRINGS, t } from "@/lib/i18n";
import type { Language, MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadPairing } from "@/lib/pairing-record";
import { useRpcClient } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import type { SidecarRow, SidecarsStore, SidecarsView } from "@/lib/sidecars-store";
import { createSidecarsStore } from "@/lib/sidecars-store";
import { theme } from "@/lib/theme";

type StoreRecord = { name?: string; port: number };

/** `error` is either the server's own verbatim text or one of this app's
 * own MessageKeys (sidecars-store.ts's GENERIC_LOAD_ERROR convention) —
 * resolved through `t()` only when it names a real key. */
function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(STRINGS, value);
}

function rowLabel(language: Language, row: SidecarRow): string {
  if (row.kind === "database") return t(language, "sidecars.database");
  if (row.kind === "editor" && row.label === "") return t(language, "sidecars.noRoots");
  return row.label;
}

export default function SidecarsScreen() {
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const { project } = useLocalSearchParams<{ project: string }>();
  // expo-router decodes dynamic segments before handing them back here
  // (getStateFromPath's safelyDecodeURIComponent) — decoding again turns
  // "a%20b" into "a b" and throws a URIError in render for a project named
  // e.g. "100%" (task-6 review, fix round 1, Important 2). Use as-is.
  const projectName = typeof project === "string" ? project : "";

  const [record, setRecord] = useState<StoreRecord | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pairing = await loadPairing(expoSecureStore);
      if (cancelled) return;
      setRecord({ name: pairing?.record.name, port: pairing?.record.port ?? 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const store: SidecarsStore | undefined = useMemo(() => {
    if (record === undefined) return undefined;
    return createSidecarsStore({ client, record, project: projectName });
  }, [client, record, projectName]);

  const [view, setView] = useState<SidecarsView>(() => store?.view() ?? { mode: "loading" });

  useEffect(() => {
    if (store === undefined) return;
    setView(store.view());
    return store.subscribe(() => setView(store.view()));
  }, [store]);

  useFocusEffect(
    useCallback(() => {
      void store?.load();
    }, [store]),
  );

  async function handleOpen(row: SidecarRow): Promise<void> {
    const opened = await store?.open(row);
    if (opened === undefined) return;
    // M8 (final review): the row's `kind`/`label`, not a resolved title
    // string — `sidecar-view.tsx` re-resolves the header text itself via
    // `t()`/its own `rowLabel`, so a route param (which a deep link can
    // also set) never reaches the header verbatim.
    router.push({
      pathname: "/sidecar-view",
      params: { url: opened.url, kind: row.kind, label: row.label },
    });
  }

  if (view.mode === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  if (view.mode === "lanOnly") {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {(["editor", "database", "cluster"] as const).map((kind) => (
          <View
            key={kind}
            style={[styles.row, styles.rowDisabled]}
            accessibilityState={{ disabled: true }}
          >
            <Text style={styles.rowLabel}>{t(language, `sidecars.${kind}`)}</Text>
          </View>
        ))}
        <Text style={styles.hint}>{t(language, "sidecars.lanOnly")}</Text>
      </ScrollView>
    );
  }

  const editorRows = view.rows.filter((row) => row.kind === "editor");
  const databaseRow = view.rows.find((row) => row.kind === "database");
  const clusterRows = view.rows.filter((row) => row.kind === "cluster");
  const errorText =
    view.error === undefined
      ? undefined
      : isMessageKey(view.error)
        ? t(language, view.error)
        : view.error;

  // Captured as a plain value (not read as `view.opening` inside the
  // nested `renderRow` closure below) because TS's narrowing of `view` to
  // the "ready" branch doesn't carry into a nested function declaration.
  //
  // Disables every row while *any* open() is in flight (task-6 review, fix
  // round 1, Minor 8) — not just the tapped one: a second row tapped
  // during the first's request would start a second open(), and whichever
  // finishes last would clear the other's `opening` marker.
  const rowOpening = view.opening;
  const anyOpening = rowOpening !== undefined;

  function renderRow(row: SidecarRow) {
    const opening = rowOpening === row;
    return (
      <Pressable
        key={`${row.kind}:${row.label}`}
        style={styles.row}
        onPress={() => void handleOpen(row)}
        disabled={anyOpening}
        accessibilityState={{ disabled: anyOpening }}
      >
        <Text style={styles.rowLabel}>{rowLabel(language, row)}</Text>
        {opening && <Text style={styles.opening}>{t(language, "sidecars.opening")}</Text>}
      </Pressable>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>{t(language, "sidecars.editor")}</Text>
      {editorRows.map(renderRow)}

      <Text style={styles.sectionTitle}>{t(language, "sidecars.database")}</Text>
      {databaseRow !== undefined && renderRow(databaseRow)}

      <Text style={styles.sectionTitle}>{t(language, "sidecars.cluster")}</Text>
      {clusterRows.length === 0 ? (
        <Text style={styles.empty}>{t(language, "sidecars.noClusters")}</Text>
      ) : (
        clusterRows.map(renderRow)
      )}

      {errorText !== undefined && (
        <Pressable onPress={() => store?.dismissError()}>
          <Text style={styles.error}>{errorText}</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.background,
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.font.size.lg,
    fontWeight: theme.font.weight.bold,
    marginTop: theme.spacing.md,
  },
  row: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowLabel: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
    fontWeight: theme.font.weight.medium,
  },
  opening: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  empty: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
    marginTop: theme.spacing.md,
  },
  error: {
    color: theme.colors.danger,
    fontSize: theme.font.size.sm,
    marginTop: theme.spacing.md,
  },
});
