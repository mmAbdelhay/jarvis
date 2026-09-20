// The per-project Docker store (M9 Task 6): the whitelisted actions
// (packages/desktop/src/remote-policy.ts's `docker:*` entries) over one
// project's configured containers, built from `docker:view`
// (packages/desktop/src/ipc.ts's `DockerHandlers.view` /
// `createDockerHandlers`'s `build`). `docker:shell` and `docker:open` stay
// desktop-only by policy (global-constraints.md carryover 9), so this store
// exposes no action for either — the screen shows static "laptop only"
// copy instead of a control that would only ever be refused.
//
// The `DockerView`/`DockerRow`/`ContainerFacts` shapes below mirror
// packages/desktop/src/ipc.ts and packages/platform/src/docker.ts
// structurally — this file never imports either package
// (global-constraints.md rule 4: mobile imports only @jarvis/wire at
// runtime and @jarvis/core type-only). Every field is parsed defensively,
// field by field, never spread from the wire payload.
//
// Same shape as changes-store.ts's `ChangesState`/`refresh()`: one shared
// `refreshGeneration` counter guards a stale `docker:view` answer from
// overwriting a newer refresh's or a newer `open()`'s rows, and every call
// uses `whenNotOpen: "reject"` (global-constraints.md rule 5) — never
// queued across a reconnect.

import type { RpcClient, RpcResult } from "./rpc-client";
import { parseGitViewResult } from "./workspace-results";

export type ContainerState = "running" | "exited" | "created" | "paused" | "restarting" | "dead";

export type ContainerFacts = {
  name: string;
  id: string;
  image: string;
  state: ContainerState;
  status: string;
  ports: string[];
  composeProject?: string;
  composeWorkingDir?: string;
  composeService?: string;
};

export type DockerRow = {
  name: string;
  container: string;
  facts?: ContainerFacts;
};

export type DockerView = {
  rows: DockerRow[];
  composeProject?: string;
  composeWorkingDir?: string;
};

export type DockerActionKind = "start" | "stop" | "restart" | "composeUp" | "composeDown";

export type DockerState = {
  project?: string;
  phase: "idle" | "loading" | "ready" | "failed";
  stale: boolean;
  busy: boolean;
  view?: DockerView;
  notice?: string;
  uncertain: boolean;
};

export type DockerStore = {
  get(): DockerState;
  subscribe(fn: (state: DockerState) => void): () => void;
  open(project: string): void;
  refresh(): void;
  action(kind: DockerActionKind, container?: string): Promise<void>;
  close(): void;
};

/** Shown when a `docker:view`/action's `RpcResult` failed without server
 *  text to show verbatim — the same `i18n.ts` `MessageKey`-as-notice
 *  convention as sidecars-store.ts's `GENERIC_LOAD_ERROR`. */
export const DOCKER_LOAD_FAILED = "docker.loadFailed";

/** Shown when `action()` is called while a previous one is still in flight
 *  (fix round 1, Minor 7): the Alert the user just confirmed must not look
 *  like it did nothing — this notice, rather than a silent drop, says so. */
export const DOCKER_ACTION_BUSY = "docker.busy";

const ACTION_CHANNEL: Record<DockerActionKind, string> = {
  start: "docker:start",
  stop: "docker:stop",
  restart: "docker:restart",
  composeUp: "docker:composeUp",
  composeDown: "docker:composeDown",
};

const CONTAINER_STATES = new Set<ContainerState>([
  "running",
  "exited",
  "created",
  "paused",
  "restarting",
  "dead",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseContainerFacts(value: unknown): ContainerFacts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (!isString(obj.name) || !isString(obj.id) || !isString(obj.image)) return undefined;
  if (!isString(obj.state) || !CONTAINER_STATES.has(obj.state as ContainerState)) return undefined;
  if (!isString(obj.status)) return undefined;
  if (!Array.isArray(obj.ports) || !obj.ports.every(isString)) return undefined;
  const facts: ContainerFacts = {
    name: obj.name,
    id: obj.id,
    image: obj.image,
    state: obj.state as ContainerState,
    status: obj.status,
    ports: obj.ports as string[],
  };
  if (isString(obj.composeProject)) facts.composeProject = obj.composeProject;
  if (isString(obj.composeWorkingDir)) facts.composeWorkingDir = obj.composeWorkingDir;
  if (isString(obj.composeService)) facts.composeService = obj.composeService;
  return facts;
}

function parseDockerRow(value: unknown): DockerRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (!isString(obj.name) || !isString(obj.container)) return undefined;
  if (obj.facts === undefined) return { name: obj.name, container: obj.container };
  const facts = parseContainerFacts(obj.facts);
  if (facts === undefined) return undefined;
  return { name: obj.name, container: obj.container, facts };
}

export function parseDockerView(value: unknown): DockerView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.rows)) return undefined;
  const rows: DockerRow[] = [];
  for (const item of obj.rows) {
    const row = parseDockerRow(item);
    if (row === undefined) return undefined;
    rows.push(row);
  }
  const view: DockerView = { rows };
  if (isString(obj.composeProject)) view.composeProject = obj.composeProject;
  if (isString(obj.composeWorkingDir)) view.composeWorkingDir = obj.composeWorkingDir;
  return view;
}

function noticeFromResult(result: RpcResult): string | undefined {
  if (result.ok) return undefined;
  if (result.error.kind === "remote") return result.error.text;
  if (result.error.kind === "offline" || result.error.kind === "timeout") return undefined;
  return DOCKER_LOAD_FAILED;
}

export function createDockerStore(deps: { client: RpcClient }): DockerStore {
  const { client } = deps;
  const listeners = new Set<(state: DockerState) => void>();
  let state: DockerState = { phase: "idle", stale: false, busy: false, uncertain: false };
  let visible = false;
  let refreshInFlight = false;
  let pendingRefresh = false;
  let refreshGeneration = 0;
  let unsubscribeState: (() => void) | undefined;

  function setState(patch: Partial<DockerState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  }

  function refresh(): void {
    if (!visible || state.project === undefined) return;
    if (refreshInFlight) {
      pendingRefresh = true;
      setState({ stale: true });
      return;
    }
    void refreshNow();
  }

  async function refreshNow(): Promise<void> {
    const project = state.project;
    if (project === undefined) return;
    const generation = ++refreshGeneration;
    refreshInFlight = true;
    setState({ phase: state.phase === "idle" ? "loading" : state.phase, stale: false });
    const result = await client.call("docker:view", [project], { whenNotOpen: "reject" });
    if (state.project !== project || generation !== refreshGeneration) return;
    refreshInFlight = false;

    if (!result.ok) {
      setState({ phase: "failed", stale: true, notice: noticeFromResult(result) });
    } else {
      const parsed = parseGitViewResult(result.value, parseDockerView);
      if (parsed.ok) {
        setState({ phase: "ready", stale: false, view: parsed.value, notice: undefined });
      } else {
        setState({ phase: "failed", stale: true, notice: parsed.text });
      }
    }

    if (pendingRefresh) {
      pendingRefresh = false;
      refresh();
    }
  }

  function subscribeVisible(): void {
    unsubscribeState = client.onState((clientState) => {
      if (clientState === "open") refresh();
    });
  }

  function unsubscribeVisible(): void {
    unsubscribeState?.();
    unsubscribeState = undefined;
  }

  async function action(kind: DockerActionKind, container?: string): Promise<void> {
    const project = state.project;
    if (project === undefined) return;
    if (state.busy) {
      // Fix round 1, Minor 7: the confirming Alert already fired — silently
      // dropping a second tap while the first is still in flight would look
      // like the app ignored the user's confirmation.
      setState({ notice: DOCKER_ACTION_BUSY });
      return;
    }
    if (kind === "start" || kind === "stop" || kind === "restart") {
      // Client-side mirror of the desktop's own `isDeclaredContainer`
      // membership check (packages/desktop/src/ipc.ts): a container this
      // project's own `docker:view` answer never named is refused here,
      // before a doomed round trip.
      if (container === undefined) return;
      const known = (state.view?.rows ?? []).some((row) => row.container === container);
      if (!known) return;
    } else if (state.view?.composeProject === undefined) {
      // No single compose project, or none of the rows share one — compose
      // up/down has no unambiguous target (mirrors the desktop's own
      // `dockerNoComposeProject` refusal, client-side, before dispatch).
      return;
    }
    if (client.state() !== "open") {
      setState({ stale: true });
      return;
    }
    setState({ busy: true, uncertain: false, notice: undefined });
    const args = kind === "composeUp" || kind === "composeDown" ? [project] : [project, container];
    const result = await client.call(ACTION_CHANNEL[kind], args, { whenNotOpen: "reject" });
    const uncertain =
      !result.ok && (result.error.kind === "timeout" || result.error.kind === "offline");
    if (!result.ok) {
      setState({ busy: false, stale: true, uncertain, notice: noticeFromResult(result) });
    } else {
      // Fix round 1, Important 1 (task-6-review.md): docker:start/stop/
      // restart/composeUp/composeDown answer with a nested
      // `GitViewResult<void>` (packages/desktop/src/ipc.ts's `act`/
      // `compose`) inside the wire-level `res` — a daemon/desktop refusal
      // (unknown container, no compose project, the daemon's own error
      // text) is still `result.ok === true` at the transport level, so it
      // must be unwrapped here or it renders as silent success.
      const parsed = parseGitViewResult(result.value, (): true => true);
      if (parsed.ok) {
        setState({ busy: false, uncertain: false });
      } else {
        setState({ busy: false, stale: true, uncertain: false, notice: parsed.text });
      }
    }
    refresh();
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    open(project) {
      if (visible) unsubscribeVisible();
      visible = true;
      refreshInFlight = false;
      pendingRefresh = false;
      setState({
        project,
        phase: "loading",
        stale: false,
        busy: false,
        view: undefined,
        notice: undefined,
        uncertain: false,
      });
      subscribeVisible();
      refresh();
    },
    refresh,
    action,
    close() {
      if (visible) unsubscribeVisible();
      visible = false;
      refreshGeneration += 1;
      setState({
        project: undefined,
        phase: "idle",
        stale: false,
        busy: false,
        view: undefined,
        notice: undefined,
        uncertain: false,
      });
    },
  };
}
