import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MetricTile } from "@/components/MetricTile";
import { ProjectRow } from "@/components/ProjectRow";
import { SessionRow } from "@/components/SessionRow";
import type { ConnectionView } from "@/lib/connection-store";
import { connectionPillModel } from "@/lib/connection-pill";
import type { DashboardView } from "@/lib/dashboard-store";
import { createDashboardStore } from "@/lib/dashboard-store";
import { formatPercent, formatSessionElapsed } from "@/lib/format";
import { STRINGS, t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import { useLanguage } from "@/lib/language-context";
import { loadPairing } from "@/lib/pairing-record";
import { armNativeExpiryWarning } from "@/lib/native-provisioning";
import { useConnectionStore, useRpcClient } from "@/lib/rpc-context";
import { expoSecureStore } from "@/lib/secure-store";
import { theme } from "@/lib/theme";

function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(STRINGS, value);
}

export default function DashboardScreen() {
  const language = useLanguage();
  const router = useRouter();
  const client = useRpcClient();
  const connectionStore = useConnectionStore();
  const store = useMemo(() => createDashboardStore({ client }), [client]);
  const [view, setView] = useState<DashboardView>(store.get());
  const [connection, setConnection] = useState<ConnectionView>(connectionStore.get());
  // The paired computer's display name — read from the same
  // `loadPairing(expoSecureStore)` source `settings.tsx` uses (item 3):
  // there is no store dedicated to this, only the Settings screen's own
  // read, so the Dashboard's connection pill reads it directly rather than
  // standing up a second `SettingsStore` just for one field.
  const [laptopName, setLaptopName] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalError, setTerminalError] = useState<string | undefined>(undefined);
  const insets = useSafeAreaInsets();
  useFocusEffect(
    useCallback(() => {
      setView(store.get());
      const unsubscribe = store.subscribe(setView);
      store.focus();
      setConnection(connectionStore.get());
      const unsubscribeConnection = connectionStore.subscribe(setConnection);
      let cancelled = false;
      void loadPairing(expoSecureStore).then((loaded) => {
        if (!cancelled) setLaptopName(loaded?.record.laptopName);
      });
      return () => {
        unsubscribe();
        store.blur();
        unsubscribeConnection();
        cancelled = true;
      };
    }, [store, connectionStore]),
  );
  const refresh = useCallback(() => {
    setRefreshing(true);
    void store.refresh().finally(() => setRefreshing(false));
  }, [store]);
  // Free-signing plan, work item 3: sideloaded builds die 7 days after
  // signing. armNativeExpiryWarning caches after its first call, so this
  // costs one profile read per app run; the banner only appears when the
  // embedded profile says fewer than 2 days remain (never on Android or
  // store builds — no profile, state.warn stays false).
  const [expiryDays, setExpiryDays] = useState<number | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void armNativeExpiryWarning(language).then((state) => {
      if (!cancelled && state.warn) setExpiryDays(state.daysLeft);
    });
    return () => {
      cancelled = true;
    };
  }, [language]);
  const openProjectTerminal = useCallback(
    async (projectName: string) => {
      setTerminalError(undefined);
      setTerminalBusy(true);
      const outcome = await store.openTerminal(projectName);
      setTerminalBusy(false);
      if (outcome.ok) {
        router.push({
          pathname: "/terminal/[paneKey]",
          params: { paneKey: outcome.tabId, tabId: outcome.tabId },
        });
        return;
      }
      setTerminalError(isMessageKey(outcome.text) ? t(language, outcome.text) : outcome.text);
    },
    [store, router, language],
  );
  const metrics = view.metrics;
  const unavailable = t(language, "metric.unavailable");
  const memory =
    metrics && metrics.memoryTotalBytes > 0
      ? (metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100
      : undefined;
  const disk =
    metrics && metrics.diskTotalBytes > 0
      ? (metrics.diskUsedBytes / metrics.diskTotalBytes) * 100
      : undefined;
  const metric = (value?: number) => (value === undefined ? unavailable : formatPercent(value));
  const pill = connectionPillModel(connection);
  const pillColor = theme.colors[pill.tone];
  const now = Date.now();
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={theme.colors.accent}
        />
      }
    >
      {expiryDays !== undefined && (
        <View style={styles.expiryBanner}>
          <Text style={styles.expiryBannerText}>
            {t(language, "expiry.banner", { days: expiryDays })}
          </Text>
        </View>
      )}
      <View style={styles.header}>
        <Text style={styles.brand}>JARVIS</Text>
        <View style={styles.connection}>
          <View style={[styles.liveDot, { backgroundColor: pillColor }]} />
          <Text style={styles.connectionText}>{t(language, pill.key)}</Text>
          {laptopName !== undefined && laptopName.length > 0 && (
            <Text style={styles.connectionName} numberOfLines={1}>
              {laptopName}
            </Text>
          )}
        </View>
        <View style={styles.spacer} />
        <TouchableOpacity
          style={styles.gear}
          onPress={() => router.push("/history")}
          accessibilityRole="button"
          accessibilityLabel={t(language, "dashboard.history")}
        >
          <Text style={styles.gearText}>◷</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.gear}
          onPress={() => router.push("/settings")}
          accessibilityRole="button"
          accessibilityLabel={t(language, "nav.settings")}
        >
          <Text style={styles.gearText}>⚙</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.metrics}>
        <MetricTile
          label={t(language, "metric.cpu")}
          value={metric(metrics?.cpuPercent)}
          percent={metrics?.cpuPercent}
        />
        <MetricTile label={t(language, "metric.memory")} value={metric(memory)} percent={memory} />
        <MetricTile
          label={t(language, "metric.disk")}
          value={metric(disk)}
          percent={disk}
          tone={
            disk !== undefined && disk >= 95
              ? "danger"
              : disk !== undefined && disk >= 85
                ? "warning"
                : "accent"
          }
        />
      </View>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{t(language, "dashboard.sessions").toUpperCase()}</Text>
          <Text style={styles.count}>{view.sessions.length}</Text>
          <View style={styles.spacer} />
          <TouchableOpacity onPress={() => router.push("/sessions")}>
            <Text style={styles.link}>{t(language, "dashboard.allSessions")}</Text>
          </TouchableOpacity>
        </View>
        {view.sessions.length === 0 ? (
          <Text style={styles.empty}>{t(language, "dashboard.noSessions")}</Text>
        ) : (
          view.sessions.map((session) => (
            <SessionRow
              key={session.id}
              summary={session.summary}
              label={session.project}
              state={session.state}
              elapsed={formatSessionElapsed(now - session.startedAt)}
              externalLabel={
                session.origin === "external" ? t(language, "sessions.external") : undefined
              }
              onPress={
                session.origin === "external"
                  ? undefined
                  : () => router.push({ pathname: "/session/[id]", params: { id: session.id } })
              }
            />
          ))
        )}
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t(language, "dashboard.projects").toUpperCase()}</Text>
        {view.projects.length === 0 ? (
          <Text style={styles.empty}>{t(language, "dashboard.noProjects")}</Text>
        ) : (
          view.projects.map((project, index) =>
            index === 0 ? (
              <View key={project.name} style={styles.projectCard}>
                <Text style={styles.projectName}>{project.name}</Text>
                {project.path && <Text style={styles.path}>{project.path}</Text>}
                <View style={styles.actions}>
                  {[
                    {
                      label: t(language, "workspace.terminal"),
                      icon: ">_",
                      onPress: () => void openProjectTerminal(project.name),
                      disabled: connection.state !== "open" || terminalBusy,
                      busy: terminalBusy,
                    },
                    {
                      label: t(language, "workspace.title"),
                      icon: "⊞",
                      onPress: () => router.push("/workspace"),
                      disabled: false,
                      busy: false,
                    },
                    {
                      label: t(language, "docker.title"),
                      icon: "□",
                      onPress: () => router.push(`/docker/${encodeURIComponent(project.name)}`),
                      disabled: false,
                      busy: false,
                    },
                    {
                      label: t(language, "voice.title"),
                      icon: "♩",
                      onPress: () => router.push("/voice"),
                      disabled: false,
                      busy: false,
                    },
                  ].map((action) => (
                    <TouchableOpacity
                      key={action.label}
                      style={[styles.action, action.disabled && styles.actionDisabled]}
                      disabled={action.disabled}
                      onPress={action.onPress}
                      accessibilityRole="button"
                    >
                      <Text style={styles.actionIcon}>{action.busy ? "…" : action.icon}</Text>
                      <Text style={styles.actionLabel}>{action.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {terminalError !== undefined && <Text style={styles.error}>{terminalError}</Text>}
              </View>
            ) : (
              <ProjectRow
                key={project.name}
                project={project}
                onPress={() => router.push(`/sidecars/${encodeURIComponent(project.name)}`)}
              />
            ),
          )
        )}
      </View>
      {view.error?.kind === "remote" && <Text style={styles.error}>{view.error.text}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.ground },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24, gap: 18 },
  expiryBanner: {
    borderWidth: 1,
    borderColor: theme.colors.warning,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  expiryBannerText: {
    color: theme.colors.warning,
    fontFamily: theme.font.semibold,
    fontSize: 13,
    lineHeight: 18,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48 },
  brand: {
    color: theme.colors.text,
    fontFamily: theme.font.bold,
    fontSize: 15,
    letterSpacing: 3.3,
  },
  connection: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    height: 30,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
  },
  liveDot: { width: 7, height: 7, borderRadius: 999, backgroundColor: theme.colors.success },
  connectionText: {
    color: theme.colors.textSecondary,
    fontFamily: theme.font.semibold,
    fontSize: 12,
  },
  connectionName: {
    flexShrink: 1,
    color: theme.colors.textDim,
    fontFamily: theme.font.mono,
    fontSize: 11,
  },
  spacer: { flex: 1 },
  gear: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
  },
  gearText: { color: theme.colors.textSecondary, fontSize: 19 },
  metrics: { flexDirection: "row", gap: 10 },
  section: { gap: 10 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  sectionTitle: {
    color: theme.colors.textMuted,
    fontFamily: theme.font.bold,
    fontSize: 13,
    letterSpacing: 1.3,
  },
  count: { color: theme.colors.accent, fontFamily: theme.font.mono, fontSize: 12 },
  link: { color: theme.colors.accent, fontFamily: theme.font.semibold, fontSize: 13 },
  empty: { color: theme.colors.textDim, fontFamily: theme.font.body, fontSize: 13 },
  projectCard: {
    padding: 14,
    gap: 12,
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: 14,
    backgroundColor: theme.colors.surface,
  },
  projectName: { color: theme.colors.text, fontFamily: theme.font.semibold, fontSize: 15 },
  path: { color: theme.colors.textDim, fontFamily: theme.font.mono, fontSize: 11 },
  actions: { flexDirection: "row", gap: 8 },
  action: {
    flex: 1,
    minHeight: 60,
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceAlt,
  },
  actionDisabled: { opacity: 0.5 },
  actionIcon: { color: theme.colors.textSecondary, fontFamily: theme.font.mono, fontSize: 17 },
  actionLabel: { color: theme.colors.textSecondary, fontFamily: theme.font.semibold, fontSize: 10 },
  error: { color: theme.colors.danger, fontFamily: theme.font.body, fontSize: 12 },
});
