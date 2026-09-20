// The Dashboard's own store (Task 6, ruling 15): projects, live metrics and
// running sessions — exactly the three things ruling 15 says the phone
// shows. Subscribes on `focus()` and drops on `blur()` (ruling 7), and every
// value pulled off the wire is parsed defensively field by field (never
// spread into a typed value) — `psh`/`res` payloads are `unknown` from the
// RpcClient's own perspective, the same discipline rpc-client.ts applies to
// server frames.

import type { Session, SystemMetrics } from "@jarvis/core";
import type { RpcClient, RpcError } from "./rpc-client";
import { parseSession } from "./session-parse";
import { openTerminal, type TerminalOpenOutcome } from "./terminal-open";

// Structural, not the server's actual `projects:list` shape today (which is
// name-only — see task-6-report.md): defined this way because the brief's
// Dashboard row shows a name and a path, and a richer object payload is
// forward-compatible. A plain string item still parses, with no path.
export type ProjectSummary = { name: string; path?: string };

// `startedAt` added (fix round, 2026-09-19 redesign): `Main.dc.html`'s
// session rows end in a mono elapsed time (`12m`) — `parseSession` already
// requires and parses `startedAt` on every wire `Session`, so this is a
// same-discipline pass-through of a field already validated, not a new
// wire dependency.
export type SessionSummary = Pick<
  Session,
  "id" | "project" | "state" | "summary" | "startedAt" | "origin"
>;

export type DashboardView = {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  metrics?: SystemMetrics;
  loading: boolean;
  error?: RpcError;
};

export type DashboardStore = {
  get(): DashboardView;
  subscribe(listener: (view: DashboardView) => void): () => void;
  focus(): void;
  blur(): void;
  refresh(): Promise<void>;
  // The Terminal tile on a project card: opens a new terminal tab on the
  // laptop in `project` and hands back its tab id for navigation, or the
  // text to show inline on failure. Never touches `view` — the screen owns
  // its own busy/error state for this one-off action, the same split
  // workspace.tsx's own "New terminal" button uses (terminal-open.ts).
  openTerminal(project: string): Promise<TerminalOpenOutcome>;
};

function parseProjects(value: unknown): ProjectSummary[] {
  if (!Array.isArray(value)) return [];
  const projects: ProjectSummary[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      projects.push({ name: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== "string") continue;
    const project: ProjectSummary = { name: obj.name };
    if (typeof obj.path === "string") project.path = obj.path;
    projects.push(project);
  }
  return projects;
}

// M12 Task 8: session-parse.ts's shared `parseSession` is now the one
// field-by-field `Session` parser (history-store.ts, sessions-store.ts
// parse the same way) — this derives the Dashboard's narrower
// `SessionSummary` from its result rather than re-checking the same
// fields independently.
function parseSessions(value: unknown): SessionSummary[] {
  if (!Array.isArray(value)) return [];
  const sessions: SessionSummary[] = [];
  for (const item of value) {
    const session = parseSession(item);
    if (session === undefined) continue;
    sessions.push({
      id: session.id,
      project: session.project,
      state: session.state,
      summary: session.summary,
      startedAt: session.startedAt,
      ...(session.origin === undefined ? {} : { origin: session.origin }),
    });
  }
  return sessions;
}

const REQUIRED_METRIC_KEYS = [
  "cpuPercent",
  "memoryUsedBytes",
  "memoryTotalBytes",
  "diskUsedBytes",
  "diskTotalBytes",
  "networkDownMbps",
  "networkUpMbps",
  "uptimeSeconds",
] as const;

function parseMetrics(value: unknown): SystemMetrics | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of REQUIRED_METRIC_KEYS) {
    if (typeof obj[key] !== "number") return undefined;
  }
  const metrics: SystemMetrics = {
    cpuPercent: obj.cpuPercent as number,
    memoryUsedBytes: obj.memoryUsedBytes as number,
    memoryTotalBytes: obj.memoryTotalBytes as number,
    diskUsedBytes: obj.diskUsedBytes as number,
    diskTotalBytes: obj.diskTotalBytes as number,
    networkDownMbps: obj.networkDownMbps as number,
    networkUpMbps: obj.networkUpMbps as number,
    uptimeSeconds: obj.uptimeSeconds as number,
  };
  if (typeof obj.cpuTemperatureC === "number") {
    metrics.cpuTemperatureC = obj.cpuTemperatureC;
  }
  return metrics;
}

export function createDashboardStore(deps: { client: RpcClient }): DashboardStore {
  const listeners = new Set<(view: DashboardView) => void>();
  let view: DashboardView = { projects: [], sessions: [], loading: false };
  let focused = false;
  let unsubscribeMetricsPush: (() => void) | undefined;
  let unsubscribeSessionsPush: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  // Minor 2 (fix round 1): focusing before the client reaches `open` queues
  // one `projects:list` from `focus()` and a second from the `open`
  // transition; their responses can land out of order. Only the response to
  // the *most recently started* refresh is allowed to land — an older one
  // arriving late is dropped rather than clobbering newer data.
  let refreshGeneration = 0;
  // Fix round 1 (Important 3): bumped by the sessions:update push handler
  // only (rule 5's "same stale-answer rule" as sessions-store's rule 4) —
  // a sessions:list answer whose refresh started before the most recent
  // push must not overwrite the sessions rows the push already set.
  let sessionsVersion = 0;

  function setView(patch: Partial<DashboardView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) {
      listener(view);
    }
  }

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration;
    const startSessionsVersion = sessionsVersion;
    setView({ loading: true });
    // M6 gap (ruling 10): `sessions:update` is a `latest` push that fires
    // only on change, so without this call the Dashboard shows "No
    // sessions" until something changes. Pulled alongside projects:list on
    // every focus/reconnect/manual refresh, under the same generation
    // guard: a stale answer to either call must never overwrite what a
    // later refresh() already set.
    const [projectsResult, sessionsResult] = await Promise.all([
      deps.client.call("projects:list", []),
      deps.client.call("sessions:list", []),
    ]);
    if (generation !== refreshGeneration) return; // superseded by a later refresh()
    const patch: Partial<DashboardView> = { loading: false, error: undefined };
    if (projectsResult.ok) {
      patch.projects = parseProjects(projectsResult.value);
    } else {
      patch.error = projectsResult.error;
    }
    if (sessionsResult.ok) {
      // Fix round 1 (Important 3): a sessions:update push that landed while
      // this call was in flight already replaced the sessions rows — this
      // stale answer must not clobber them.
      if (sessionsVersion === startSessionsVersion) {
        patch.sessions = parseSessions(sessionsResult.value);
      }
    } else {
      patch.error = patch.error ?? sessionsResult.error;
    }
    setView(patch);
  }

  function focus(): void {
    if (focused) return;
    focused = true;

    unsubscribeMetricsPush = deps.client.onPush("metrics:update", (payload) => {
      const metrics = parseMetrics(payload);
      if (metrics !== undefined) {
        setView({ metrics });
      }
    });
    unsubscribeSessionsPush = deps.client.onPush("sessions:update", (payload) => {
      sessionsVersion += 1;
      setView({ sessions: parseSessions(payload) });
    });

    deps.client.subscribe("metrics:update");
    deps.client.subscribe("sessions:update");

    // Ruling: subscriptions are re-sent by the client itself on every new
    // `welcome`; this store only needs to re-fetch the one non-pushed value,
    // the project list, when the connection comes back.
    unsubscribeState = deps.client.onState((state) => {
      if (state === "open") {
        void refresh();
      }
    });

    void refresh();
  }

  function blur(): void {
    if (!focused) return;
    focused = false;

    deps.client.unsubscribe("metrics:update");
    deps.client.unsubscribe("sessions:update");
    unsubscribeMetricsPush?.();
    unsubscribeSessionsPush?.();
    unsubscribeState?.();
    unsubscribeMetricsPush = undefined;
    unsubscribeSessionsPush = undefined;
    unsubscribeState = undefined;
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focus,
    blur,
    refresh,
    openTerminal: (project: string) => openTerminal(deps.client, project),
  };
}
