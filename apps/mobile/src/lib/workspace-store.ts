// M9 Task 7: the Workspace screen's own store — the phone's read-only view
// of the laptop's open tabs, grouped by project, plus the pane inventory of
// whichever Terminal tab the user opened. Every value pulled off the wire
// is parsed defensively, field by field, exactly like dashboard-store.ts —
// `psh`/`res` payloads are `unknown` from the RpcClient's own perspective.
//
// Global constraint 5 / controller ruling (d), amended by task-7-review.md
// Important 2 (fix round 1): a single store-wide generation counter meant a
// `workspace:update` push during an in-flight refresh() dropped its
// projects:list answer and left `loading` stuck, and readPanes()/refresh()
// silently canceled each other's pull. Three per-concern generations fix
// that: `snapshotGeneration` guards only the workspace:snapshot half of
// refresh() (bumped by the push and by refresh() itself — never by
// readPanes()), `panesGeneration` guards a tab's pane inventory (bumped by
// readPanes(), selectProject() and close() — never by the push, and never
// by refresh() itself, which only *captures* it to piggyback a pane
// re-read without able to cancel an explicit readPanes() the other
// direction), and `refreshGeneration` guards only refresh()'s own
// projects:list answer against a stale overlapping refresh() call. `loading`
// is cleared unconditionally when a refresh() call's own Promise.all
// resolves, regardless of any of the three — never left stuck because some
// other half of that same call was superseded.
//
// Controller ruling (a): M11's sidecar route is already merged, so this
// store never renders an "unavailable" placeholder for Editor/Database/
// Cluster — the screen links those straight to the existing
// `/sidecars/[project]` route. Ruling (b): the screen also links to the
// existing `/docker/[project]` route for every project, not only ones with
// an open Docker tab. Neither needs anything from this store beyond the
// project name, so there is no dedicated state for them here.
//
// Controller ruling (c): this store never calls a tab-mutating channel
// (`workspace:open/close/activate/navigate/...`, `terminal:open/split/
// closePane`) — only the three read-only ones below, plus the two
// resolve-only `chat:*` calls a project's Chat action uses. A phone never
// rearranges the laptop's own window.

import type { MobileWorkspaceSnapshot, MobileWorkspaceTab, TerminalPaneInfo } from "@jarvis/wire";
import type { RpcClient, RpcError } from "./rpc-client";

export type WorkspaceProjectView = {
  name: string;
  tabs: MobileWorkspaceTab[];
};

export type WorkspaceView = {
  projects: WorkspaceProjectView[];
  snapshot: MobileWorkspaceSnapshot | undefined;
  selectedProject: string | undefined;
  panes: TerminalPaneInfo[];
  /** Which tab `panes` belongs to — undefined once nothing has been read,
   *  or once a newer readPanes()/selectProject()/close() has superseded it
   *  but not yet been answered. */
  panesTabId: string | undefined;
  stale: boolean;
  loading: boolean;
  error: RpcError | undefined;
  /** Set once, in `open()`, when the paired desktop's `subscribe(
   *  "workspace:update")` answers `{ok:false, error:{kind:"unsupported"}}`
   *  (an older desktop paired with a newer phone) — review r0 Important 1:
   *  reusing `error` for this read "load failed" the moment `refresh()`'s
   *  own `patch.error = undefined` landed, since a normal `projects:list`/
   *  `workspace:snapshot` answer has nothing to do with live-update
   *  support. A dedicated flag `refresh()` never touches stays true for
   *  the life of this open session — the desktop's capability set can't
   *  change mid-connection. */
  liveUpdatesUnsupported: boolean;
};

export type WorkspaceStore = {
  get(): WorkspaceView;
  subscribe(fn: (view: WorkspaceView) => void): () => void;
  open(): void;
  selectProject(project: string): void;
  refresh(): void;
  readPanes(tabId: string): void;
  close(): void;
};

const TAB_KINDS = new Set([
  "web",
  "editor",
  "database",
  "terminal",
  "api",
  "cluster",
  "docker",
  "chat",
]);

function parseTab(value: unknown): MobileWorkspaceTab | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string") return undefined;
  if (typeof obj.project !== "string") return undefined;
  if (typeof obj.url !== "string") return undefined;
  if (typeof obj.kind !== "string" || !TAB_KINDS.has(obj.kind)) return undefined;
  if (typeof obj.title !== "string") return undefined;
  if (typeof obj.loading !== "boolean") return undefined;
  if (typeof obj.canGoBack !== "boolean") return undefined;
  if (typeof obj.canGoForward !== "boolean") return undefined;
  if (typeof obj.hasPlayingVideo !== "boolean") return undefined;
  if (typeof obj.pageFullscreen !== "boolean") return undefined;
  if (typeof obj.suspended !== "boolean") return undefined;
  const tab: MobileWorkspaceTab = {
    id: obj.id,
    project: obj.project,
    url: obj.url,
    kind: obj.kind as MobileWorkspaceTab["kind"],
    title: obj.title,
    loading: obj.loading,
    canGoBack: obj.canGoBack,
    canGoForward: obj.canGoForward,
    error: typeof obj.error === "string" ? obj.error : undefined,
    hasPlayingVideo: obj.hasPlayingVideo,
    pageFullscreen: obj.pageFullscreen,
    suspended: obj.suspended,
  };
  if (typeof obj.detail === "string") tab.detail = obj.detail;
  return tab;
}

export function parseWorkspaceSnapshot(value: unknown): MobileWorkspaceSnapshot | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.tabs)) return undefined;
  const tabs: MobileWorkspaceTab[] = [];
  for (const item of obj.tabs) {
    const tab = parseTab(item);
    if (tab === undefined) return undefined; // one malformed tab: treat the whole frame as unparseable
    tabs.push(tab);
  }
  const activeTabId = typeof obj.activeTabId === "string" ? obj.activeTabId : undefined;
  return { tabs, activeTabId };
}

export function parseTerminalPanes(value: unknown): TerminalPaneInfo[] {
  if (!Array.isArray(value)) return [];
  const panes: TerminalPaneInfo[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.paneKey !== "string") continue;
    if (typeof obj.exited !== "boolean") continue;
    panes.push({ paneKey: obj.paneKey, exited: obj.exited });
  }
  return panes;
}

/**
 * Resolves an opaque `paneKey` route param against a tab's current pane
 * inventory (`terminal:panes`'s own answer) — the check that stands
 * between a deep link/stale route and ever subscribing to a pane's
 * terminal bytes (rule 6, controller ruling (g): "never trust route
 * params — validate the pane key against the pane inventory before
 * subscribing"). Undefined for a pane the inventory doesn't, or no longer,
 * contain — the caller must not attach in that case.
 */
export function resolvePane(
  panes: readonly TerminalPaneInfo[],
  paneKey: string,
): TerminalPaneInfo | undefined {
  return panes.find((pane) => pane.paneKey === paneKey);
}

function parseProjectNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      names.push(item);
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

function computeProjects(
  names: readonly string[],
  snapshot: MobileWorkspaceSnapshot | undefined,
): WorkspaceProjectView[] {
  const tabs = snapshot?.tabs ?? [];
  const seen = new Set<string>();
  const projects: WorkspaceProjectView[] = [];
  const push = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    projects.push({ name, tabs: tabs.filter((tab) => tab.project === name) });
  };
  for (const name of names) push(name);
  // A project with an open tab but no entry in projects:list (a stale or
  // renamed config) still gets a row — its tabs are real laptop state even
  // if the config that named it has moved on.
  for (const tab of tabs) push(tab.project);
  return projects;
}

/** True for anything outside printable ASCII (0x21-0x7e): any C0 control
 *  character (including tab/newline/CR), the space character, DEL, *and*
 *  — review r0 Important 2 — every code point at or above 0x7f, which the
 *  original `code === 0x7f` check let straight through. That gap accepted
 *  non-ASCII whitespace (U+FEFF zero-width no-break space/BOM, U+200B
 *  zero-width space, U+00AD soft hyphen — none of them render as a visible
 *  gap, all of them change what the string actually is once a URL parser
 *  gets it) and any IDN host — accepted by Node's `URL`/whatwg-url under
 *  Vitest, but device-dependent behavior React Native's own URL
 *  implementation is never guaranteed to match. A `charCodeAt` scan, not a
 *  regex literal containing raw control characters (which the linter —
 *  rightly — treats as suspicious). Applied to the *whole* input string
 *  (ruling 12), not just the authority: a URL parser normally strips these
 *  silently, which is exactly the problem a naive check could miss. */
function hasControlOrSpace(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f) return true;
  }
  return false;
}

function isNumericLabel(label: string): boolean {
  return /^[0-9]+$/.test(label);
}

function isHexLabel(label: string): boolean {
  return /^0x[0-9a-f]+$/i.test(label);
}

const DNS_LABEL = /^[a-z0-9-]+$/i;

/**
 * Ruling 12 (M12 Task 8, M9 T7 deferred): `hostname` must have DNS shape —
 * two or more labels of `[a-z0-9-]`, no empty label — must not equal
 * `localhost` or end in `.localhost`, and no label may be purely numeric
 * (`127`, `0`, decimal-encoded IPv4 like `2130706433`) or hex-shaped
 * (`0x7f`, octal-looking `0177` is still numeric). This alone refuses every
 * dotted-decimal/decimal/octal/hex IPv4 spelling — a deny-list against
 * every such spelling could never be proven complete (M7 T8 round 2's
 * lesson); a positive DNS-name shape can be. IPv6 literals (`hostname`
 * containing `:`) are refused by `DNS_LABEL` alone, since `:` is never in
 * that character class.
 */
function isDnsShapedHostname(host: string): boolean {
  if (host === "") return false;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return false;
  const labels = lower.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0) return false;
    if (!DNS_LABEL.test(label)) return false;
    if (isNumericLabel(label) || isHexLabel(label)) return false;
  }
  return true;
}

/**
 * Ruling 12: `safeExternalUrl` is an allow-list over a hand-checked
 * hostname, not a deny-list against loopback/link-local spellings — M9 T7
 * deferred: decimal/hex/octal IPv4, IPv4-mapped IPv6, `[::]`, `0.0.0.0`,
 * `*.localhost` and non-ASCII whitespace all slipped a deny-list, and
 * React Native's `URL` does not normalise IPv4 spellings, so the check
 * cannot rely on it to canonicalise a host before comparing it. The value
 * must be printable ASCII with no whitespace; parse with `URL`; only
 * `http:`/`https:`; no userinfo (`user:pass@host`/`user@host`) in the
 * authority; `[` anywhere in the raw string (an IPv6 literal) is refused
 * outright; and `hostname` must have DNS shape (`isDnsShapedHostname`).
 * Every caller must only ever open the result from an explicit user tap
 * (rule 6/global constraint 7) — never from a server push or a WebView
 * navigation.
 */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "" || hasControlOrSpace(value)) return undefined;
  if (value.includes("[") || value.includes("@")) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (!isDnsShapedHostname(parsed.hostname)) return undefined;
  return value;
}

/** The `*:open`-shaped domain result `chat:open` hands back — the same
 *  nested `{ok:true,value}|{ok:false,text}` shape sidecars-store.ts parses
 *  for editor/database/cluster. */
function parseOpenOutcome(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value !== "object" || value === null) return { ok: false };
  const obj = value as Record<string, unknown>;
  if (obj.ok === true) return { ok: true, value: obj.value };
  return { ok: false };
}

/** The names of `project`'s configured chats, in config order — empty for
 *  a project with none, or on any RPC failure (there is nothing partial to
 *  show, so a failure and "no chats configured" render the same way: no
 *  Chat action). Never touches a laptop view. */
export async function listChatNames(
  client: Pick<RpcClient, "call">,
  project: string,
): Promise<string[]> {
  const result = await client.call("chat:names", [project], { whenNotOpen: "reject" });
  if (!result.ok) return [];
  if (!Array.isArray(result.value)) return [];
  return result.value.filter((item): item is string => typeof item === "string");
}

/** Resolves `name` within `project` to the URL its driver opens, validated
 *  through `safeExternalUrl` — never the laptop's own tab. undefined on
 *  any failure (offline, a remote refusal, an unparseable reply, or a URL
 *  that fails validation): there is no laptop fallback to fall back to. */
export async function resolveChatUrl(
  client: Pick<RpcClient, "call">,
  project: string,
  name: string,
): Promise<string | undefined> {
  const result = await client.call("chat:open", [project, name], { whenNotOpen: "reject" });
  if (!result.ok) return undefined;
  const outcome = parseOpenOutcome(result.value);
  if (!outcome.ok) return undefined;
  return safeExternalUrl(outcome.value);
}

export function createWorkspaceStore(deps: { client: RpcClient }): WorkspaceStore {
  const listeners = new Set<(view: WorkspaceView) => void>();
  let view: WorkspaceView = {
    projects: [],
    snapshot: undefined,
    selectedProject: undefined,
    panes: [],
    panesTabId: undefined,
    stale: deps.client.state() !== "open",
    loading: false,
    error: undefined,
    liveUpdatesUnsupported: false,
  };

  let opened = false;
  let projectNames: string[] = [];
  let snapshot: MobileWorkspaceSnapshot | undefined;
  // Three per-concern generations (fix round 1, Important 2 — see the file
  // header comment for the full rationale).
  let snapshotGeneration = 0;
  let panesGeneration = 0;
  let refreshGeneration = 0;
  let unsubscribeUpdate: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;

  function bumpSnapshot(): number {
    snapshotGeneration += 1;
    return snapshotGeneration;
  }

  function bumpPanes(): number {
    panesGeneration += 1;
    return panesGeneration;
  }

  function setView(patch: Partial<WorkspaceView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) listener(view);
  }

  function recomputeProjects(): void {
    setView({ projects: computeProjects(projectNames, snapshot), snapshot });
  }

  function applyUpdate(next: MobileWorkspaceSnapshot): void {
    snapshot = next;
    recomputeProjects();
  }

  async function refresh(): Promise<void> {
    refreshGeneration += 1;
    const myRefresh = refreshGeneration;
    const mySnapshot = bumpSnapshot();
    // Piggybacks a re-read of the tab currently shown, if any (task-7-
    // review.md Important 1: "refresh() re-reads the current panesTabId
    // panes so reconnect and pull-to-refresh refresh the inventory") —
    // captured, not bumped, so an explicit readPanes() already in flight
    // for this same tab is never canceled by this call (Important 2:
    // "readPanes and refresh no longer cancel each other").
    const myPanes = panesGeneration;
    const panesTabId = view.panesTabId;
    setView({ loading: true });

    const [projectsResult, snapshotResult, panesResult] = await Promise.all([
      deps.client.call("projects:list", []),
      deps.client.call("workspace:snapshot", []),
      panesTabId === undefined
        ? Promise.resolve(undefined)
        : deps.client.call("terminal:panes", [panesTabId]),
    ]);

    const patch: Partial<WorkspaceView> = {};
    // Fix round 2 (deferred minor): guarded by refreshGeneration alone, not
    // left unconditional — an older overlapping refresh() call landing
    // while a newer one is still in flight must not flip the spinner off
    // early. A workspace:update push never bumps refreshGeneration, so
    // round 1's own case (push supersedes only the snapshot half; loading
    // must still clear) is untouched by this guard.
    if (refreshGeneration === myRefresh) {
      patch.loading = false;
    }

    // Guarded by refreshGeneration only: a workspace:update push never
    // bumps this, so the push superseding the snapshot half below never
    // costs this call its own projects:list answer.
    if (refreshGeneration === myRefresh) {
      if (projectsResult.ok) {
        projectNames = parseProjectNames(projectsResult.value);
        patch.error = undefined;
      } else {
        patch.error = projectsResult.error;
      }
    }

    // Guarded by snapshotGeneration: a workspace:update push that landed
    // while this call was in flight already applied a fresher snapshot —
    // this stale answer must not clobber it.
    if (snapshotGeneration === mySnapshot) {
      if (snapshotResult.ok) {
        const parsed = parseWorkspaceSnapshot(snapshotResult.value);
        if (parsed !== undefined) snapshot = parsed;
      } else {
        patch.error = patch.error ?? snapshotResult.error;
      }
    }

    // Fix round 2 (re-review Important): panesGeneration alone isn't
    // enough — a later readPanes() for a *different* tab, itself still in
    // flight when this refresh() started, bumps panesGeneration only once
    // (before this call ever captured myPanes), so panesGeneration can
    // still equal myPanes by the time this call's own answer lands, even
    // though the pane inventory shown has since moved on to that other
    // tab. Requiring `view.panesTabId === panesTabId` too catches that:
    // the other readPanes() call's own answer already updated
    // `panesTabId` to the new tab before this one lands, so the equality
    // fails and this stale, piggybacked answer for the old tab is
    // dropped rather than silently undoing the newer tap. Also guarded by
    // refreshGeneration, so a stale overlapping refresh() call's own
    // piggyback never lands after a newer refresh() already applied its
    // own. A failure here is left as-is — no partial replacement — since
    // this is a background re-read, not the user's own explicit
    // readPanes().
    if (
      panesResult !== undefined &&
      refreshGeneration === myRefresh &&
      panesGeneration === myPanes &&
      view.panesTabId === panesTabId &&
      panesResult.ok
    ) {
      patch.panes = parseTerminalPanes(panesResult.value);
      patch.panesTabId = panesTabId;
    }

    patch.projects = computeProjects(projectNames, snapshot);
    patch.snapshot = snapshot;
    setView(patch);
  }

  async function readPanesInternal(tabId: string): Promise<void> {
    const myPanes = bumpPanes();
    const result = await deps.client.call("terminal:panes", [tabId]);
    if (panesGeneration !== myPanes) return; // superseded by a newer readPanes()/selectProject()/close()
    if (!result.ok) {
      setView({ error: result.error });
      return;
    }
    setView({ panes: parseTerminalPanes(result.value), panesTabId: tabId, error: undefined });
  }

  function open(): void {
    if (opened) return;
    opened = true;
    unsubscribeUpdate = deps.client.onPush("workspace:update", (payload) => {
      const parsed = parseWorkspaceSnapshot(payload);
      if (parsed === undefined) return; // malformed frame: keep the last good snapshot
      // Supersedes only the snapshot half of any in-flight refresh() — never
      // panesGeneration, so an in-flight readPanes()/refresh() pane answer
      // survives a push that lands ahead of it (Important 2).
      bumpSnapshot();
      applyUpdate(parsed);
    });
    unsubscribeState = deps.client.onState((state) => {
      setView({ stale: state !== "open" });
      if (state === "open") {
        // A refused subscribe never creates an RpcClient entry, so only
        // that case needs a reconnect retry. A live entry is re-sent by the
        // client's welcome path; calling subscribe here would increment its
        // reference count and make close() leak it.
        if (view.liveUpdatesUnsupported) {
          const resubscribed = deps.client.subscribe("workspace:update");
          setView({ liveUpdatesUnsupported: !resubscribed.ok });
        }
        void refresh();
      }
    });
    // Rule 6 / review r0 Important 1: a `{ok:false, error:{kind:
    // "unsupported"}}` answer (an older desktop paired with a newer phone,
    // before `RpcClient` even reaches the server) used to be silently
    // ignored here. Setting `error` for this was wrong — `refresh()`
    // clears `error` unconditionally on its own success, so the notice
    // vanished the instant the ordinary projects:list/workspace:snapshot
    // pull landed, milliseconds later. `liveUpdatesUnsupported` is a
    // dedicated flag `refresh()` never touches.
    const subscribed = deps.client.subscribe("workspace:update");
    if (!subscribed.ok) setView({ liveUpdatesUnsupported: true });
    setView({ stale: deps.client.state() !== "open" });
    void refresh();
  }

  function selectProject(project: string): void {
    bumpPanes(); // a project switch discards any pane fetch still in flight for the old one
    setView({ selectedProject: project, panes: [], panesTabId: undefined });
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    bumpSnapshot();
    bumpPanes();
    refreshGeneration += 1;
    deps.client.unsubscribe("workspace:update");
    unsubscribeUpdate?.();
    unsubscribeState?.();
    unsubscribeUpdate = undefined;
    unsubscribeState = undefined;
    // Rule 6: closing while a refresh() is still in flight used to leave
    // `loading` stuck true forever — the bumped generations make that
    // in-flight call's own answer a no-op (it can never touch `loading`
    // again), and nothing else was ever going to clear it.
    setView({ loading: false });
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    selectProject,
    refresh: () => void refresh(),
    readPanes: (tabId) => void readPanesInternal(tabId),
    close,
  };
}
