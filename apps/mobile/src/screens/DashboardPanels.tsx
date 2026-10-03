// The Dashboard's three panels (System, Sessions, Projects), shared by the
// phone stack and the wide grid (2026-09-28 spec §3–4). With `wide` false a
// panel renders exactly the markup the phone Dashboard always had; with
// `wide` true it sits in a desktop-style panel card (hairline border,
// `radius.card`, a titled header) inside `DashboardGrid`. The data and the
// navigation stay in `app/(tabs)/dashboard.tsx`; these only draw.
import type { ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { MetricTile } from "@/components/MetricTile";
import { ProjectRow } from "@/components/ProjectRow";
import { SessionRow } from "@/components/SessionRow";
import { type DashboardColumns, type DashboardPanel, dashboardGrid } from "@/lib/dashboard-grid";
import type { DashboardView } from "@/lib/dashboard-store";
import { formatPercent, formatSessionElapsed } from "@/lib/format";
import type { Language } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { theme } from "@/lib/theme";
import { textDirection } from "@/lib/voice-screen";

type Metrics = DashboardView["metrics"];
type Sessions = DashboardView["sessions"];
type Projects = DashboardView["projects"];

/** The desktop's `.panel` + `.ph` header, used only on the wide layout. */
function Panel({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
        {trailing}
      </View>
      <View style={styles.panelBody}>{children}</View>
    </View>
  );
}

export function SystemPanel({
  language,
  metrics,
  wide,
}: {
  language: Language;
  metrics: Metrics;
  wide: boolean;
}) {
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
  const tiles = (
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
  );
  if (!wide) return tiles;
  return <Panel title={t(language, "dashboard.system")}>{tiles}</Panel>;
}

export function SessionsPanel({
  language,
  sessions,
  now,
  wide,
  onOpenSession,
  onAllSessions,
  onHistory,
}: {
  language: Language;
  sessions: Sessions;
  now: number;
  wide: boolean;
  onOpenSession: (id: string) => void;
  onAllSessions: () => void;
  /** Wide only: the phone header's History button, which the top bar replaces. */
  onHistory: () => void;
}) {
  const count = <Text style={styles.count}>{sessions.length}</Text>;
  const allSessions = (
    <TouchableOpacity onPress={onAllSessions}>
      <Text style={styles.link}>{t(language, "dashboard.allSessions")}</Text>
    </TouchableOpacity>
  );
  const list =
    sessions.length === 0 ? (
      <Text style={styles.empty}>{t(language, "dashboard.noSessions")}</Text>
    ) : (
      sessions.map((session) => (
        <SessionRow
          key={session.id}
          title={session.summary}
          subtitle={[
            session.project,
            session.origin === "external" ? t(language, "sessions.external") : null,
          ]
            .filter((part): part is string => part !== null && part !== "")
            .join(" · ")}
          time={formatSessionElapsed(now - session.startedAt)}
          variant={
            session.state === "waiting"
              ? "waiting"
              : session.state === "starting" || session.state === "running"
                ? "active"
                : "done"
          }
          onPress={session.origin === "external" ? undefined : () => onOpenSession(session.id)}
        />
      ))
    );
  if (wide) {
    return (
      <Panel
        title={t(language, "dashboard.sessions")}
        trailing={
          <>
            {count}
            <View style={styles.spacer} />
            <TouchableOpacity onPress={onHistory} accessibilityRole="button">
              <Text style={styles.link}>{t(language, "dashboard.history")}</Text>
            </TouchableOpacity>
            {allSessions}
          </>
        }
      >
        {list}
      </Panel>
    );
  }
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{t(language, "dashboard.sessions").toUpperCase()}</Text>
        {count}
        <View style={styles.spacer} />
        {allSessions}
      </View>
      {list}
    </View>
  );
}

export type ProjectActions = {
  openTerminal: (projectName: string) => void;
  openWorkspace: () => void;
  openDocker: (projectName: string) => void;
  openVoice: () => void;
  openSidecars: (projectName: string) => void;
};

export function ProjectsPanel({
  language,
  projects,
  wide,
  terminalDisabled,
  terminalBusy,
  terminalError,
  actions,
}: {
  language: Language;
  projects: Projects;
  wide: boolean;
  terminalDisabled: boolean;
  terminalBusy: boolean;
  terminalError?: string;
  actions: ProjectActions;
}) {
  const list =
    projects.length === 0 ? (
      <Text style={styles.empty}>{t(language, "dashboard.noProjects")}</Text>
    ) : (
      projects.map((project, index) =>
        index === 0 ? (
          <View key={project.name} style={styles.projectCard}>
            <Text style={styles.projectName}>{project.name}</Text>
            {project.path && <Text style={styles.path}>{project.path}</Text>}
            <View style={styles.actions}>
              {[
                {
                  label: t(language, "workspace.terminal"),
                  icon: ">_",
                  onPress: () => actions.openTerminal(project.name),
                  disabled: terminalDisabled,
                  busy: terminalBusy,
                },
                {
                  label: t(language, "workspace.title"),
                  icon: "⊞",
                  onPress: actions.openWorkspace,
                  disabled: false,
                  busy: false,
                },
                {
                  label: t(language, "docker.title"),
                  icon: "□",
                  onPress: () => actions.openDocker(project.name),
                  disabled: false,
                  busy: false,
                },
                {
                  label: t(language, "voice.title"),
                  icon: "♩",
                  onPress: actions.openVoice,
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
            onPress={() => actions.openSidecars(project.name)}
          />
        ),
      )
    );
  if (wide) {
    return (
      <Panel
        title={t(language, "dashboard.projects")}
        trailing={<Text style={styles.count}>{projects.length}</Text>}
      >
        {list}
      </Panel>
    );
  }
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t(language, "dashboard.projects").toUpperCase()}</Text>
      {list}
    </View>
  );
}

/**
 * The wide Dashboard: a row of columns (see `dashboardGrid`) centred inside
 * the desktop's 1180 measure. `direction` mirrors the row in Arabic, so the
 * System column sits on the right there.
 */
export function DashboardGrid({
  language,
  columns,
  renderPanel,
}: {
  language: Language;
  columns: DashboardColumns;
  renderPanel: (panel: DashboardPanel) => ReactNode;
}) {
  return (
    <View style={[styles.grid, { direction: textDirection(language) }]}>
      {dashboardGrid(columns).map((column) => (
        <View key={column.join("+")} style={styles.column}>
          {column.map((panel) => (
            <View key={panel}>{renderPanel(panel)}</View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 16,
    width: "100%",
    maxWidth: 1180,
    alignSelf: "center",
  },
  column: { flex: 1, minWidth: 0, gap: 16 },
  panel: {
    borderWidth: 1,
    borderColor: theme.colors.hairline,
    borderRadius: theme.radius.card,
    backgroundColor: theme.colors.surfaceDim,
    overflow: "hidden",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.hairline,
  },
  panelBody: { padding: 12, gap: 10 },
  spacer: { flex: 1 },
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
