// The per-project Docker screen (M9 Task 6): configured containers with
// their current facts, the whitelisted start/stop/restart/compose actions
// (packages/desktop/src/remote-policy.ts), and one device-owned live log
// follower at a time. All decision logic lives in docker-store.ts and
// docker-log-stream.ts; this file is layout plus the two effects those
// stores need from a screen: open/close on focus (sidecars/[project].tsx's
// pattern) and an AppState listener that detaches the log follower on
// background — M5 ruling: a device's follower streams exist only while
// attached, and the phone must detach on blur/background rather than leave
// a laptop-side `docker logs -f` running for nobody.
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { appStateFollowAction } from "@/lib/docker-screen";
import type { DockerActionKind, DockerRow, DockerState } from "@/lib/docker-store";
import { createDockerStore, DOCKER_ACTION_BUSY, DOCKER_LOAD_FAILED } from "@/lib/docker-store";
import type { DockerLogView } from "@/lib/docker-log-stream";
import {
  createDockerLogStream,
  DOCKER_LOG_FOLLOW_FAILED,
  newFollowId,
} from "@/lib/docker-log-stream";
import { formatBytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Language, MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { useRpcClient } from "@/lib/rpc-context";
import { theme } from "@/lib/theme";
import { MALFORMED_REPLY_NOTICE } from "@/lib/workspace-results";

const NOTICE_KEYS: Readonly<Record<string, MessageKey>> = {
  [DOCKER_LOAD_FAILED]: "docker.loadFailed",
  [DOCKER_ACTION_BUSY]: "docker.busy",
  [DOCKER_LOG_FOLLOW_FAILED]: "docker.log.followFailed",
  [MALFORMED_REPLY_NOTICE]: "docker.malformedReply",
};

/** Turns a store notice into displayed text: the sentinel tokens the
 *  stores can produce are translated; anything else is real server text,
 *  shown verbatim (global-constraints.md rule 7). */
function noticeText(notice: string, language: Language): string {
  const key = NOTICE_KEYS[notice];
  return key ? t(language, key) : notice;
}

function stateLabel(row: DockerRow): string {
  return row.facts?.state ?? "";
}

export default function DockerScreen() {
  const language = useLanguage();
  const client = useRpcClient();
  const { project } = useLocalSearchParams<{ project: string }>();
  // expo-router already decodes a dynamic segment before handing it back
  // (sidecars/[project].tsx's own note) — used as-is, never re-decoded.
  const projectName = typeof project === "string" ? project : "";

  const store = useMemo(() => createDockerStore({ client }), [client]);
  // M12 Task 12 minor (checked): `expo-crypto` — which would give
  // `getRandomValues`/`randomUUID` a real CSPRNG — is not in
  // apps/mobile/package.json, and global-constraints.md rules out adding a
  // dependency for this task. `Math.random` stays: `newFollowId`'s own id
  // is a client-chosen tab label the server never trusts as a capability
  // or a credential (docker-followers.ts's own `REMOTE_FOLLOW_TAB_PATTERN`
  // is a shape check, not an unguessability requirement), so a
  // non-cryptographic source is an accepted gap here, not a bug.
  const logStream = useMemo(
    () => createDockerLogStream({ client, randomId: () => newFollowId(Math.random) }),
    [client],
  );

  const [state, setState] = useState<DockerState>(store.get());
  const [logView, setLogView] = useState<DockerLogView>(logStream.get());
  const [following, setFollowing] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);

  // Fix round 1, Minor 4 (task-6-review.md): the AppState listener below is
  // set up once per focus and must always act on the *latest* `following`,
  // not the value captured when the listener was created — a ref, kept in
  // sync here, rather than adding `following` to the focus effect's own
  // deps (which would tear the stores down and re-fetch on every tap).
  const followingRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);

  useFocusEffect(
    useCallback(() => {
      const unState = store.subscribe(setState);
      const unLog = logStream.subscribe(setLogView);
      store.open(projectName);
      setState(store.get());
      setLogView(logStream.get());

      // M5 ruling: never leave a laptop-side follower orphaned — going to
      // the background is an explicit detach, not merely a dropped socket
      // (which docker-log-stream.ts already handles on its own for a mere
      // connection drop). Returning to "active" re-attaches the remembered
      // container; iOS's transient "inactive" leaves the follower alone
      // (docker-screen.ts's `appStateFollowAction`).
      const appStateSub = AppState.addEventListener("change", (next) => {
        const action = appStateFollowAction(next, followingRef.current, logStream.get().phase);
        if (action.kind === "close") {
          logStream.close();
        } else if (action.kind === "reattach") {
          void logStream.follow(projectName, action.container);
        }
      });

      return () => {
        unState();
        unLog();
        appStateSub.remove();
        store.close();
        logStream.close();
        setFollowing(undefined);
      };
    }, [store, logStream, projectName]),
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    store.refresh();
    setTimeout(() => setRefreshing(false), 250);
  }, [store]);

  function follow(container: string): void {
    setFollowing(container);
    void logStream.follow(projectName, container);
  }

  function stopFollowing(): void {
    logStream.close();
    setFollowing(undefined);
  }

  function runAction(kind: DockerActionKind, container?: string): void {
    void store.action(kind, container);
  }

  function confirmStop(row: DockerRow): void {
    Alert.alert(t(language, "docker.confirmStop", { name: row.name }), undefined, [
      { text: t(language, "common.cancel"), style: "cancel" },
      {
        text: t(language, "common.ok"),
        style: "destructive",
        onPress: () => runAction("stop", row.container),
      },
    ]);
  }

  function confirmRestart(row: DockerRow): void {
    Alert.alert(t(language, "docker.confirmRestart", { name: row.name }), undefined, [
      { text: t(language, "common.cancel"), style: "cancel" },
      {
        text: t(language, "common.ok"),
        style: "destructive",
        onPress: () => runAction("restart", row.container),
      },
    ]);
  }

  function confirmComposeDown(): void {
    Alert.alert(t(language, "docker.confirmComposeDown", { project: projectName }), undefined, [
      { text: t(language, "common.cancel"), style: "cancel" },
      {
        text: t(language, "common.ok"),
        style: "destructive",
        onPress: () => runAction("composeDown"),
      },
    ]);
  }

  const rows = state.view?.rows ?? [];
  const composeAvailable = state.view?.composeProject !== undefined;

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
      <Stack.Screen options={{ title: projectName || t(language, "docker.title") }} />

      {state.phase === "loading" && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      )}

      {state.notice !== undefined && (
        <Text selectable style={styles.error}>
          {noticeText(state.notice, language)}
        </Text>
      )}
      {state.uncertain && <Text style={styles.warning}>{t(language, "docker.uncertain")}</Text>}

      {state.phase === "ready" && rows.length === 0 && (
        <Text style={styles.empty}>{t(language, "docker.noContainers")}</Text>
      )}

      <View style={styles.list}>
        {rows.map((row) => (
          <View key={row.container} style={styles.row}>
            <View style={styles.rowHeader}>
              <Text style={styles.rowName}>{row.name}</Text>
              <Text style={styles.rowMeta}>
                {row.facts
                  ? `${stateLabel(row)} · ${row.facts.status}`
                  : t(language, "docker.notFound")}
              </Text>
            </View>
            <View style={styles.actions}>
              <TouchableOpacity
                disabled={state.busy}
                style={styles.smallButton}
                onPress={() => runAction("start", row.container)}
              >
                <Text style={styles.buttonText}>{t(language, "docker.start")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={state.busy}
                style={styles.smallButton}
                onPress={() => confirmStop(row)}
              >
                <Text style={styles.buttonText}>{t(language, "docker.stop")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={state.busy}
                style={styles.smallButton}
                onPress={() => confirmRestart(row)}
              >
                <Text style={styles.buttonText}>{t(language, "docker.restart")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.smallButton}
                onPress={() => follow(row.container)}
                accessibilityRole="button"
              >
                <Text style={styles.buttonText}>{t(language, "docker.follow")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>

      {composeAvailable && (
        <View style={styles.actions}>
          <TouchableOpacity
            disabled={state.busy}
            style={styles.smallButton}
            onPress={() => runAction("composeUp")}
          >
            <Text style={styles.buttonText}>{t(language, "docker.composeUp")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            disabled={state.busy}
            style={styles.smallButton}
            onPress={confirmComposeDown}
          >
            <Text style={styles.buttonText}>{t(language, "docker.composeDown")}</Text>
          </TouchableOpacity>
        </View>
      )}

      <Text style={styles.hint}>{t(language, "docker.shellLaptopOnly")}</Text>

      {following !== undefined && (
        <View style={styles.logBlock}>
          <Text style={styles.hint}>{t(language, "docker.log.liveOnly")}</Text>
          {logView.phase === "waiting" && (
            <Text style={styles.warning}>{t(language, "docker.log.waiting")}</Text>
          )}
          {logView.phase === "failed" && logView.notice !== undefined && (
            <Text selectable style={styles.error}>
              {noticeText(logView.notice, language)}
            </Text>
          )}
          {logView.droppedBytes > 0 && (
            <Text style={styles.hint}>
              {t(language, "docker.log.trimmed", {
                amount: formatBytes(logView.droppedBytes, language),
              })}
            </Text>
          )}
          <ScrollView style={styles.logBox} nestedScrollEnabled>
            <Text selectable style={[styles.logText, { writingDirection: "ltr" }]}>
              {logView.text}
            </Text>
          </ScrollView>
          <TouchableOpacity style={styles.smallButton} onPress={stopFollowing}>
            <Text style={styles.buttonText}>{t(language, "docker.log.stop")}</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 34, gap: 10 },
  center: { alignItems: "center", padding: theme.spacing.lg },
  list: { gap: theme.spacing.sm },
  row: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  rowHeader: { gap: theme.spacing.xs },
  rowName: {
    color: theme.colors.text,
    fontSize: theme.font.size.md,
    fontFamily: theme.font.bold,
  },
  rowMeta: { color: theme.colors.textDim, fontFamily: theme.font.mono, fontSize: 11 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  smallButton: {
    backgroundColor: theme.colors.surfaceAlt,
    minHeight: 40,
    borderRadius: theme.radius.small,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: { color: theme.colors.text },
  empty: { color: theme.colors.textMuted },
  warning: { color: theme.colors.warning },
  error: { color: theme.colors.danger },
  hint: { color: theme.colors.textMuted, fontSize: theme.font.size.sm },
  logBlock: {
    gap: theme.spacing.sm,
    borderColor: theme.colors.hairline,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
  },
  logBox: {
    maxHeight: 320,
    backgroundColor: theme.colors.terminalGround,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
  },
  logText: {
    color: theme.colors.textSecondary,
    fontFamily: theme.font.mono,
    fontSize: 11,
    lineHeight: 16,
  },
});
