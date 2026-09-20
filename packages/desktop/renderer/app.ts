import { initSetup, openSetupIfNeeded } from "./setup.js";
import { hostPlatform, keyLabel, setVoiceHotkeys } from "./keys.js";
import type {
  ProviderStatus,
  Session,
  SessionChanges,
  SessionState,
  SystemMetrics,
  Turn,
} from "@jarvis/core";
import type { RendererApi, VoiceNotice } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { applyStaticChrome, openChanges, wireCommitBar, wireDiffModes } from "./changes.js";
import { showView, syncHostedView } from "./views.js";
import {
  initWorkspace,
  NEW_TAB_URL,
  refreshWorkspaceProjects,
  renderWorkspace,
  reportWorkspaceBounds,
  setBrowserSnapshot,
} from "./workspace.js";
import { initSettings, openSettings, savePrayerSettings } from "./settings.js";
import {
  checkPrayerNotifications,
  initPrayerSettings,
  renderPrayer,
  setPrayerSnapshot,
} from "./prayer.js";
import { initRemoteStatus } from "./remote-status.js";
import {
  detectLanguage,
  formatAgo,
  formatBytes,
  formatDiskUsage,
  formatEndedAt,
  formatUptime,
  projectLabel,
} from "./format.js";
import { renderProviders, wireProvidersPanel } from "./providers.js";
import { sessionToAutoOpen } from "./session-auto-open.js";
import { threadPaths } from "./link-layout.js";
import {
  appendSessionOutput,
  claimVoice,
  openSession,
  openSessionId,
  reassertSessionSize,
  releaseVoice,
  renderEmptyState,
  renderSessionTable,
  renderVoiceTarget,
  setKnownAgents,
  updateSessionHeader,
  wireSessionsRefresh,
  wireSessionView,
} from "./session-view.js";

declare global {
  interface Window {
    jarvis: RendererApi;
  }
}

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

// The two inputs arrive on independent channels: sessions on "sessions:update"
// and counts on "git:counts". Both are kept so whichever lands second can
// re-render with the other's latest value, instead of the row losing its
// counts every time a session's state changes.
let latestSessions: Session[] = [];
// The first `sessions:update` after launch already carries whatever the
// process scan and transcript backfill found — rows the user did not just
// start. sessionToAutoOpen() needs to know it is looking at that first push
// so it never treats "everything in it" as newly started.
let hadFirstSessionsUpdate = false;
let latestChanges = new Map<string, SessionChanges>();
/** The configured projects, for the Dashboard's centre when nothing is
 *  running. Filled once at startup, from the same call that wires the
 *  Workspace's project selector. */
let knownProjects: string[] = [];
/** The registry's agent ids, for the core stage's orbiting chips — the same
 *  list session-view.ts's setKnownAgents receives, kept here too since that
 *  module exposes no getter. */
let knownAgents: string[] = [];
/** The latest provider read, for the orbiting chips' dot colour — "if known"
 *  per the task, else --text-dim. */
let latestProviders: readonly ProviderStatus[] = [];
/** The projects grid's live substring filter, lowercased once here rather
 *  than on every project on every render. */
let projectFilter = "";

/** Every sub-element of one project's node that a re-render needs to touch,
 *  kept across renders so renderProjectGrid() updates text/classes in place
 *  instead of rebuilding the grid — a sessions:update tick is frequent
 *  enough that recreating every card node on each one would be real,
 *  avoidable layout work. */
type ProjectNode = {
  el: HTMLElement;
  count: HTMLElement;
  status: HTMLElement;
};
const projectNodes = new Map<string, ProjectNode>();

const SVG_NS = "http://www.w3.org/2000/svg";

/** One inline-stroke glyph in a node action icon (design/DashboardBrain.dc.html's
 *  `.actions` svgs) — a bare tag name plus its own attributes, built via
 *  createElementNS rather than innerHTML (no innerHTML anywhere in this
 *  file, the same discipline block-view.ts/changes.ts/file-tree.ts keep). */
type IconShape = { tag: "polyline" | "line" | "circle" | "rect" | "path" } & Record<string, string>;

/** A project node's four icon-only shortcuts, in board order. Each button
 *  carries no visible text — round 4's fix for text overflowing the card —
 *  only an aria-label/title (from MESSAGES) and this stroke icon. */
const NODE_ACTIONS: ReadonlyArray<{
  label: (language: "ar" | "en") => string;
  open: (project: string) => unknown;
  icon: readonly IconShape[];
}> = [
  {
    label: (language) => MESSAGES.dashboardActionTerminal(language),
    open: (project) => window.jarvis.openTerminal(project),
    icon: [
      { tag: "polyline", points: "4 17 10 11 4 5" },
      { tag: "line", x1: "12", y1: "19", x2: "20", y2: "19" },
    ],
  },
  {
    label: (language) => MESSAGES.dashboardActionEditor(language),
    open: (project) => window.jarvis.openEditor(project),
    icon: [
      { tag: "polyline", points: "16 18 22 12 16 6" },
      { tag: "polyline", points: "8 6 2 12 8 18" },
    ],
  },
  {
    label: (language) => MESSAGES.dashboardActionBrowser(language),
    open: (project) => window.jarvis.openTab(project, NEW_TAB_URL),
    icon: [
      { tag: "circle", cx: "12", cy: "12", r: "10" },
      { tag: "line", x1: "2", y1: "12", x2: "22", y2: "12" },
    ],
  },
  {
    label: (language) => MESSAGES.dashboardActionDocker(language),
    open: (project) => window.jarvis.openDockerTab(project),
    icon: [
      { tag: "rect", x: "2", y: "7", width: "20", height: "14", rx: "2" },
      { tag: "path", d: "M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" },
    ],
  },
];

/** Builds one 12x12 inline stroke icon (design/DashboardBrain.dc.html's node
 *  action svgs) from a shape list. `currentColor` so the icon follows
 *  .node__action's own colour, including its hover state — the same idiom
 *  the composer mic icon already uses. */
function buildActionIcon(shapes: readonly IconShape[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const { tag, ...attrs } of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    svg.append(el);
  }
  return svg;
}

/**
 * What the agent is doing, for the Dashboard's presence indicator.
 *
 * Three of the four states are reported by the main process; "thinking" is
 * inferred here, because it is the gap between a question leaving and an
 * answer arriving and nothing else observes both ends of it.
 */
type Presence = "idle" | "listening" | "thinking" | "speaking";

/** The presence hints, spelled for the platform this is running on.
 *
 *  Built from keyLabel rather than written out, because a hint that names a
 *  chord which does nothing is worse than no hint — and ⌥Space is not what
 *  the hotkey is called anywhere but macOS. */
function presenceText(
  platform: NodeJS.Platform,
): Record<Presence, { state: string; hint: string }> {
  const start = keyLabel("voiceStart", platform);
  const stop = keyLabel("voiceStop", platform);
  return {
    idle: { state: "Idle", hint: `${start} to talk` },
    listening: { state: "Listening…", hint: `${stop} to stop` },
    thinking: { state: "Thinking…", hint: "working on it" },
    speaking: { state: "Speaking…", hint: `${start} to interrupt` },
  };
}

let listening = false;
let speaking = false;
let thinking = false;

/** Speaking outranks listening outranks thinking: it is the most specific
 *  thing happening, and two of them can be true at once — the microphone
 *  opens again while the last reply is still being spoken. */
function renderPresence(): void {
  const state: Presence = speaking
    ? "speaking"
    : listening
      ? "listening"
      : thinking
        ? "thinking"
        : "idle";
  const element = document.getElementById("presence");
  if (element === null) return;

  // `.brain-core` is the core stage's visual skin (styles.css) — appended
  // rather than folded into a template so a state change never has to
  // remember to repeat it.
  element.className = `presence presence--${state} brain-core`;
  const text = presenceText(hostPlatform())[state];
  const stateElement = document.getElementById("presence-state");
  const hintElement = document.getElementById("presence-hint");
  if (stateElement !== null) stateElement.textContent = text.state;
  if (hintElement !== null) hintElement.textContent = text.hint;
}

export function setPresenceListening(value: boolean): void {
  listening = value;
  renderPresence();
}

export function setPresenceSpeaking(value: boolean): void {
  speaking = value;
  // An answer being spoken is an answer that has arrived.
  if (value) thinking = false;
  renderPresence();
}

/** Set when a question is sent, cleared when the assistant answers. */
export function setPresenceThinking(value: boolean): void {
  thinking = value;
  renderPresence();
}

window.jarvis.onMetrics((metrics) => renderMetrics(metrics));
window.jarvis.onSessions((sessions) => {
  const previous = latestSessions;
  latestSessions = sessions;
  renderSessions(latestSessions);
  renderRunningPill(latestSessions);
  updateSessionHeader(latestSessions);
  // The whole point of starting a session is to watch it work, so a newly
  // started one opens its transcript without being asked — the behaviour the
  // dashboard was missing ("when i start a session it's not opening it so i
  // can see it"). sessionToAutoOpen() is the pure decision: never on the
  // first update after launch (that push already carries rows the user
  // didn't just start), never for a discovered ("external") row, and
  // otherwise only a genuinely new Jarvis-origin id — a state change or a
  // git count landing on an existing session must never yank the view away
  // from whatever the user is reading.
  const toOpen = sessionToAutoOpen(previous, sessions, !hadFirstSessionsUpdate);
  hadFirstSessionsUpdate = true;
  if (toOpen !== undefined) void openSession(toOpen);
});
window.jarvis.onTurn((turn) => {
  renderTurn(turn);
  // An assistant turn is the answer arriving, which is the end of thinking
  // whether or not it is about to be spoken.
  if (turn.role === "assistant") setPresenceThinking(false);
});
window.jarvis.onListening((listening) => {
  renderListening(listening);
  setPresenceListening(listening);
});
window.jarvis.onSpeaking((speaking) => setPresenceSpeaking(speaking));
// Draw the resting state once at startup: nothing has happened yet, and an
// indicator that says nothing until the first event is worse than none.
renderPresence();
window.jarvis.onNotice((notice) => renderNotice(notice));
window.jarvis.onChangeCounts((changes) => {
  latestChanges = new Map(changes.map((entry) => [entry.sessionId, entry]));
  renderSessions(latestSessions);
});
window.jarvis.onProviders((statuses) => {
  latestProviders = statuses;
  renderProviders(statuses, Date.now());
  // A provider's health can change without the registry's agent list
  // changing at all — the orbiting chip's dot colour must still catch up.
  renderAgentOrbits();
});
window.jarvis.onSessionOutput((output) => appendSessionOutput(output));

startClock();
labelShortcuts();

// Which hotkeys are really live. Sent only when they are not the default
// pair — on Windows, where another app held Alt+Space — and every hint is
// redrawn from the answer rather than left naming a key nothing listens to.
window.jarvis.onVoiceHotkeys?.((hotkeys) => {
  setVoiceHotkeys(hotkeys);
  labelShortcuts();
  renderPresence();
});

// The first-run prerequisites screen. Opens on a first run, and on any launch
// where the required agent CLI is missing — an app with no agent has nothing
// to offer, and finding that out one failed session at a time is the
// experience this replaces. See renderer/setup.ts.
initSetup(window.jarvis);
void openSetupIfNeeded(window.jarvis, window.jarvis.firstRun).catch(() => undefined);
applyStaticChrome();
wireComposer();
wireMicButton();
wireHistoryPanel();
wireNav();
wireDiffModes();
wireCommitBar();
wireProvidersPanel();
wireSessionView();
// No afterRefresh: the Dashboard SESSIONS card already redraws itself from
// the "sessions:update" push the scan broadcasts (onSessions below).
wireSessionsRefresh($("dashboard-sessions-refresh"));
wireCoreStage();
renderEmptyState();

function wireNav(): void {
  // Leaving the Session view hands speech back to the brain: while a
  // session's terminal is open, ⌥Space types into that agent, and once it
  // is not, speaking is addressed to Jarvis again.
  document.getElementById("nav-dashboard")?.addEventListener("click", () => {
    showView("dashboard");
    releaseVoice();
  });
  document.getElementById("nav-changes")?.addEventListener("click", () => {
    releaseVoice();
    // With no session chosen yet, the most recently active one is the one
    // the user just spoke about.
    const latest = [...latestSessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (latest === undefined) return;
    void openChanges(latest.id);
  });
  // The pill is a shortcut to the thing it is reporting on: the same place
  // the Session nav button goes, which is the table rather than any one
  // session's terminal.
  //
  // reassertSessionSize() is chained onto renderSessionTable()'s own
  // promise, not called alongside it: the table (and the "terminal no
  // longer on screen" flip that goes with it) only actually appears once
  // its `getHistory` await settles. Calling reassertSessionSize()
  // straight away — before that — would still see whatever terminal was
  // open a moment ago and send its about-to-be-stale size, describing a
  // terminal that is about to be hidden.
  document.getElementById("running-pill")?.addEventListener("click", () => {
    void renderSessionTable().then(() => reassertSessionSize());
    claimVoice();
  });
  document.getElementById("nav-workspace")?.addEventListener("click", () => {
    releaseVoice();
    showView("workspace");
    // The page slot has no measurable size until its route is on screen,
    // so the bounds are reported after showView, not before.
    reportWorkspaceBounds();
  });
  document.getElementById("nav-settings")?.addEventListener("click", () => {
    releaseVoice();
    showView("settings");
    void openSettings();
  });
  try {
    // A minimal test harness (app.test.ts) is allowed to lay down only the
    // routes it actually exercises — initSettings throwing on the Settings
    // route's absent markup must not take wireNav() down before it finishes
    // wiring every route after this line, the same reason
    // getProjects().then(initWorkspace) below is guarded with its own catch.
    initSettings();
    initPrayerSettings(savePrayerSettings);
    void window.jarvis
      .getSettings()
      .then((settings) => {
        setPrayerSnapshot(settings.prayer);
        renderPrayer();
        setBrowserSnapshot(settings.browser);
        setKnownAgents(Object.keys(settings.registry.agents));
        setKnownAgentIds(Object.keys(settings.registry.agents));
      })
      .catch(() => undefined);
    window.addEventListener("jarvis:settings-saved", () => {
      // The header reads the *saved* prayer settings, never the draft — a
      // toggled-but-unsaved switch must not preview in the chip. Same rule
      // for the new-tab home page and the Sessions agent filter's registry
      // half: both read the saved snapshot, not whatever Settings has open.
      void window.jarvis
        .getSettings()
        .then((settings) => {
          setPrayerSnapshot(settings.prayer);
          renderPrayer();
          setBrowserSnapshot(settings.browser);
          setKnownAgents(Object.keys(settings.registry.agents));
          setKnownAgentIds(Object.keys(settings.registry.agents));
        })
        .catch(() => undefined);
      void window.jarvis
        .getProjects()
        .then((projects) => {
          knownProjects = projects;
          refreshWorkspaceProjects(projects);
          renderSessions(latestSessions);
        })
        .catch(() => undefined);
    });
  } catch {
    // Settings' own markup is absent in this harness; nothing to wire.
  }
  try {
    // Same guard as initSettings above: a minimal test harness may lay down
    // none of #remote-pill/#remote-confirm, and a throw here must not take
    // the rest of wireNav() down with it.
    initRemoteStatus(window.jarvis);
  } catch {
    // The topbar indicator's own markup is absent in this harness.
  }

  window.jarvis.onWorkspace((state) => renderWorkspace(state));
  // No catch here would be an unhandled rejection in the renderer on any
  // failure downstream of the IPC call — including, as app.test.ts's
  // minimal harness proved, a DOM that has not laid down the workspace
  // route's markup.
  void window.jarvis
    .getProjects()
    .then((projects) => {
      knownProjects = projects;
      initWorkspace(projects);
      // The centre may already have rendered its empty state before this
      // resolved; with the names in hand it has something to say.
      renderSessions(latestSessions);
    })
    .catch(() => undefined);
}

function renderMetrics(metrics: SystemMetrics): void {
  $("cpu-value").textContent = `${metrics.cpuPercent}%`;
  $("cpu-bar").style.width = `${metrics.cpuPercent}%`;
  renderTemperature(metrics.cpuTemperatureC);

  const memPercent =
    metrics.memoryTotalBytes > 0
      ? Math.round((metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100)
      : 0;
  $("mem-value").textContent = `${memPercent}%`;
  $("mem-detail").textContent =
    `${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`;
  $("mem-bar").style.width = `${memPercent}%`;

  // A disk at 98% used to be stated in exactly the same colour as a disk at
  // 12%, which makes the number decorative: nobody reads a strip of
  // identical grey percentages. The thresholds are what turn it back into
  // information — board 0's SYSTEM card, red at 95%, amber at 85%.
  const disk = formatDiskUsage(metrics.diskUsedBytes, metrics.diskTotalBytes);
  const diskPercent =
    metrics.diskTotalBytes > 0
      ? Math.round((metrics.diskUsedBytes / metrics.diskTotalBytes) * 100)
      : 0;
  $("disk-value").textContent = `${diskPercent}%`;
  $("disk-total").textContent = `${disk.used} ${disk.total}`;
  const diskWarn = diskPercent >= 85 && diskPercent < 95;
  const diskCrit = diskPercent >= 95;
  $("disk-value").classList.toggle("warn", diskWarn);
  $("disk-value").classList.toggle("crit", diskCrit);
  $("disk-bar").style.width = `${diskPercent}%`;
  $("disk-bar").classList.toggle("fill--warn", diskWarn);
  $("disk-bar").classList.toggle("fill--crit", diskCrit);

  $("uptime-value").textContent = formatUptime(metrics.uptimeSeconds);

  $("net-down").textContent = `↓${metrics.networkDownMbps.toFixed(1)}`;
  $("net-up").textContent = `↑${metrics.networkUpMbps.toFixed(1)}`;

  // The topbar itself carries no numbers any more (board 0 removed
  // CPU/RAM/DISK/network from the ambient strip — the SYSTEM card above is
  // the only place they render) — but a machine in real trouble still needs
  // a signal from every route, so a small dot takes their place, on only
  // while something is genuinely critical and named in its own tooltip.
  const dangerDot = document.getElementById("topbar-danger-dot");
  if (dangerDot !== null) {
    const cpuCrit = metrics.cpuPercent >= 95;
    dangerDot.hidden = !(cpuCrit || diskCrit);
    if (!dangerDot.hidden) {
      dangerDot.title = MESSAGES.topbarDangerTitle(cpuCrit, diskCrit, PRIMARY_LANGUAGE);
    }
  }
}

/** Sessions live in the Dashboard's centre now. They were also listed in a
 *  narrow card in the left rail, which meant rendering the same rows twice
 *  into two different widths; the card is gone. */
/** The states a session is still doing something in. "waiting" is one of
 *  them: a session waiting on input is live and wants an answer, which is
 *  precisely when knowing it is there is worth something. */
const LIVE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  "starting",
  "running",
  "waiting",
]);

/** How many orbs are drawn before they stop being countable at a glance.
 *  Past this the count beside them is the honest way to say how many. */
const MAX_ORBS = 3;

/**
 * The topbar's running-sessions indicator.
 *
 * The dashboard already lists what is running, but the topbar is the one
 * strip that is on screen from every view — so a session started in the
 * Workspace, or one that finished while Settings was open, was invisible
 * until you went looking. This is the ambient version of that fact, next to
 * the voice pill because it belongs to the same family: things the app
 * knows about itself.
 *
 * Always on screen, dimmed at zero. It used to hide when nothing was
 * running, which made "nothing is running" indistinguishable from "there is
 * no indicator" — the user went looking for it and could not find it. A
 * quiet "0 running" answers the question without competing for attention.
 */
function renderRunningPill(sessions: Session[]): void {
  const live = sessions.filter((session) => LIVE_STATES.has(session.state));
  const pill = $("running-pill");

  pill.classList.toggle("pill--idle", live.length === 0);
  $("running-count").textContent = `${live.length} running`;

  // One orb per session so two read as two without parsing a number, each
  // breathing on its own offset — in step they would look like one wide
  // pulse and lose exactly the distinction they exist to draw.
  const orbs = $("running-orbs");
  orbs.replaceChildren(
    ...live.slice(0, MAX_ORBS).map((_, index) => {
      const orb = document.createElement("span");
      orb.className = "running-orb";
      orb.style.animationDelay = `${index * 0.45}s`;
      return orb;
    }),
  );

  // The whole list, not just the three with orbs: the tooltip is where
  // someone goes for the detail the pill is too small to carry.
  // projectLabel, not core's sessionLabel: a renderer module may import
  // types from a workspace package but never a value — see format.ts.
  pill.title =
    live.length === 0
      ? "No sessions running"
      : live.map((session) => `${projectLabel(session)} · ${session.agentId}`).join("\n");
}

/**
 * The Dashboard's SESSIONS card and, since the two are always in sync (both
 * read latestSessions/latestChanges), the projects grid below it.
 *
 * Sessions and projects used to be one region that swapped between them —
 * a Running list the moment anything was live, a Projects list the rest of
 * the time — which hid whichever one you were not currently looking at.
 * Board 0's second pass (design/DashboardBrain.dc.html) keeps both on screen
 * always: this renders the SESSIONS card's rows, then hands off to
 * renderProjectGrid() for the grid.
 */
function renderSessions(sessions: Session[]): void {
  const body = $("centre-body");
  const live = sessions.filter(
    (session) => LIVE_STATES.has(session.state) && session.state !== "waiting",
  );
  const waiting = sessions.filter((session) => session.state === "waiting");
  const summary = document.getElementById("sessions-summary");
  if (summary !== null) {
    summary.textContent = MESSAGES.dashboardRunningWaiting(
      live.length,
      waiting.length,
      PRIMARY_LANGUAGE,
    );
  }

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sessions-empty";
    empty.textContent = MESSAGES.dashboardNoSessions(PRIMARY_LANGUAGE);
    body.replaceChildren(empty);
  } else {
    body.replaceChildren(...sessions.map(buildSessionRow));
  }

  renderProjectGrid();
}

/** A project's live/waiting/idle status, computed fresh each render from the
 *  same sessions:update stream the SESSIONS card uses — never a second
 *  per-project read from main (no new IPC for this redesign). Running
 *  outranks waiting outranks idle, both for this and for the grid's sort. */
function projectStatus(project: string): "live" | "waiting" | "idle" {
  const sessions = latestSessions.filter((session) => session.project === project);
  if (sessions.some((session) => LIVE_STATES.has(session.state) && session.state !== "waiting")) {
    return "live";
  }
  if (sessions.some((session) => session.state === "waiting")) return "waiting";
  return "idle";
}

const STATUS_RANK: Record<"live" | "waiting" | "idle", number> = { live: 0, waiting: 1, idle: 2 };

/**
 * The projects grid (design/DashboardBrain.dc.html's .node-grid): every
 * configured project, always on screen, sorted running → waiting → idle then
 * name, filtered by the core stage's own substring filter. Reconciles
 * against `projectNodes` rather than rebuilding — see that map's own
 * comment for why.
 */
function renderProjectGrid(): void {
  const grid = document.getElementById("project-grid");
  if (grid === null) return;

  // Drop cached nodes for projects Settings no longer configures, so this
  // map cannot grow without bound across a long session of edits.
  for (const project of [...projectNodes.keys()]) {
    if (!knownProjects.includes(project)) projectNodes.delete(project);
  }

  const running = knownProjects.filter((project) => projectStatus(project) === "live").length;
  const waiting = knownProjects.filter((project) => projectStatus(project) === "waiting").length;
  const countEl = document.getElementById("project-count");
  if (countEl !== null) {
    countEl.textContent = knownProjects.length === 0 ? "" : `${knownProjects.length}`;
  }
  const summaryEl = document.getElementById("project-summary");
  if (summaryEl !== null) {
    summaryEl.textContent = MESSAGES.dashboardRunningWaiting(running, waiting, PRIMARY_LANGUAGE);
  }

  if (knownProjects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "node-grid__empty";
    empty.textContent = MESSAGES.dashboardNoProjects(PRIMARY_LANGUAGE);
    grid.replaceChildren(empty);
    return;
  }

  const needle = projectFilter.trim().toLowerCase();
  const sorted = knownProjects
    .filter((project) => needle === "" || project.toLowerCase().includes(needle))
    .sort((a, b) => {
      const rank = STATUS_RANK[projectStatus(a)] - STATUS_RANK[projectStatus(b)];
      return rank !== 0 ? rank : a.localeCompare(b);
    });

  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "node-grid__empty";
    empty.textContent = MESSAGES.dashboardNoMatches(PRIMARY_LANGUAGE);
    grid.replaceChildren(empty);
    return;
  }

  // replaceChildren is handed the SAME elements getOrBuildNode already put
  // in `projectNodes`, reordered into this render's sort — never a freshly
  // created node for a project it has seen before.
  grid.replaceChildren(...sorted.map((project) => getOrBuildNode(project)));
  layoutLinks();
}

/**
 * Draws the glowing threads from the core's trunk to the first-row project
 * cards (link-layout.ts): re-measured on a frame after every grid render,
 * and on resize/scroll (wireCoreStage), because the endpoints are DOM
 * positions. A thread picks up the .live class when its card is live, so
 * a running project's thread pulses brighter.
 */
function layoutLinks(): void {
  const svg = document.getElementById("dash-links");
  const view = document.getElementById("view-dashboard");
  const grid = document.getElementById("project-grid");
  const orbEl = document.querySelector<HTMLElement>(".core-stage__orb");
  if (svg === null || view === null || grid === null || orbEl === null) return;
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    const origin = view.getBoundingClientRect();
    const orbRect = orbEl.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const cards = [...grid.querySelectorAll<HTMLElement>(".node")];
    const rects = cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        top: rect.top - origin.top,
        left: rect.left - origin.left,
        width: rect.width,
        height: rect.height,
      };
    });
    const orb = {
      centre: {
        x: orbRect.left + orbRect.width / 2 - origin.left,
        y: orbRect.top + orbRect.height / 2 - origin.top,
      },
      radius: orbRect.width / 2,
    };
    const paths = threadPaths(orb, rects, gridRect.top - origin.top);
    svg.setAttribute("viewBox", `0 0 ${Math.round(origin.width)} ${Math.round(origin.height)}`);
    svg.replaceChildren(
      ...paths.flatMap((d, index) => {
        const live = cards[index]?.classList.contains("live") === true;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("class", "dash-links__thread");
        if (live) path.classList.add("dash-links__thread--live");
        // One glow pulse travelling down each thread (CSS offset-path), the
        // moving light the user asked for; staggered so the fan shimmers
        // rather than pulsing in lockstep.
        const pulse = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        pulse.setAttribute("r", live ? "3" : "2.2");
        pulse.setAttribute("class", "dash-links__pulse");
        if (live) pulse.classList.add("dash-links__pulse--live");
        pulse.style.offsetPath = `path("${d}")`;
        pulse.style.animationDelay = `${(index % 6) * 0.55}s`;
        return [path, pulse];
      }),
    );
  });
}

/** A project's node: its name, status dot, per-project count badge, one
 *  status line, and the four places you would go next (board 0's PROJECTS
 *  card: Terminal / Editor / Browser / Docker). Built once per project and
 *  cached in `projectNodes`; every later call only updates the three
 *  sub-elements that actually change (updateNode). */
function getOrBuildNode(project: string): HTMLElement {
  let node = projectNodes.get(project);
  if (node === undefined) {
    node = buildNode(project);
    projectNodes.set(project, node);
  }
  updateNode(node, project);
  return node.el;
}

function buildNode(project: string): ProjectNode {
  const el = document.createElement("div");
  el.className = "node";

  const head = document.createElement("div");
  head.className = "node__head";

  const dot = document.createElement("span");
  dot.className = "node__dot";
  head.append(dot);

  const name = document.createElement("span");
  name.className = "node__name";
  const language = detectLanguage(project);
  name.dir = language === "ar" ? "rtl" : "ltr";
  if (language === "ar") name.classList.add("arabic");
  name.textContent = project;
  head.append(name);

  const count = document.createElement("span");
  count.className = "node__count mono";
  head.append(count);
  el.append(head);

  const status = document.createElement("div");
  status.className = "node__status mono";
  el.append(status);

  const actions = document.createElement("div");
  actions.className = "node__actions";
  for (const action of NODE_ACTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "node__action";
    const label = action.label(PRIMARY_LANGUAGE);
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(buildActionIcon(action.icon));
    button.addEventListener("click", () => {
      void action.open(project);
      showView("workspace");
    });
    actions.append(button);
  }
  el.append(actions);

  return { el, count, status };
}

function updateNode(node: ProjectNode, project: string): void {
  const status = projectStatus(project);
  node.el.className = `node ${status}`;

  const projectSessions = latestSessions.filter((session) => session.project === project);
  const running = projectSessions.filter(
    (session) => LIVE_STATES.has(session.state) && session.state !== "waiting",
  );
  const waiting = projectSessions.filter((session) => session.state === "waiting");

  if (status === "idle") {
    node.count.hidden = true;
    node.count.textContent = "";
    const changes = [...latestChanges.values()].find((entry) => entry.project === project);
    node.status.textContent =
      changes !== undefined && changes.files > 0
        ? `${MESSAGES.dashboardIdle(PRIMARY_LANGUAGE)} · ${MESSAGES.dashboardIdleDirty(changes.files, PRIMARY_LANGUAGE)}`
        : MESSAGES.dashboardIdle(PRIMARY_LANGUAGE);
    return;
  }

  node.count.hidden = false;
  node.count.textContent =
    status === "live"
      ? MESSAGES.dashboardNodeRunning(running.length, PRIMARY_LANGUAGE)
      : MESSAGES.dashboardNodeWaiting(PRIMARY_LANGUAGE);

  // The most recently active of whichever pool this node's status came
  // from — the one line has room for one session's story.
  const pool = status === "live" ? running : waiting;
  const session = [...pool].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  node.status.textContent =
    session === undefined
      ? ""
      : [
          session.agentId,
          session.summary === "" ? summaryFallback(session.state) : session.summary,
          formatAgo(session.startedAt, Date.now(), PRIMARY_LANGUAGE),
        ].join(" · ");
}

/** Sets the registry's agent ids and redraws the core stage's orbiting
 *  chips in one call — the one seam both getSettings().then() call sites in
 *  wireNav() go through, and the one app.test.ts exercises directly rather
 *  than mounting the whole Settings route just to reach the registry read
 *  that normally feeds it. */
export function setKnownAgentIds(agents: string[]): void {
  knownAgents = agents;
  renderAgentOrbits();
}

/** One orbit-track per configured agent, evenly spaced around the core by a
 *  negative animation-delay (styles.css's .orbit-track/.satellite) rather
 *  than by distinct geometry — every track shares the same inset, so what
 *  separates two agents on screen is only how far into the 24s cycle each
 *  one starts. Re-run whenever the registry or a provider read changes. */
function renderAgentOrbits(): void {
  const container = document.getElementById("agent-orbits");
  if (container === null) return;

  const total = knownAgents.length;
  container.replaceChildren(
    ...knownAgents.map((agentId, index) => {
      // A negative delay pre-offsets the animation's start position without
      // making it wait — index 0 always stays at 0s so a single agent's chip
      // starts exactly where the artboard's own does.
      const delay = index === 0 ? "0s" : `${(-24 * index) / total}s`;

      const track = document.createElement("div");
      track.className = "orbit-track";
      track.style.animationDelay = delay;

      const satellite = document.createElement("div");
      satellite.className = "satellite";
      satellite.style.animationDelay = delay;

      const dot = document.createElement("span");
      dot.className = "satellite__dot";
      dot.style.background = agentDotColor(agentId);
      satellite.append(dot);

      const label = document.createElement("span");
      label.textContent = agentId;
      satellite.append(label);

      track.append(satellite);
      return track;
    }),
  );
}

/** The orbiting chip's dot colour: the matching provider's health when one
 *  has been read, else --text-dim — never a colour this module invents. */
function agentDotColor(agentId: string): string {
  const status = latestProviders.find((provider) => provider.id === agentId);
  if (status === undefined) return "var(--text-dim)";
  switch (status.health.state) {
    case "ok":
      return "var(--good)";
    case "degraded":
      return "var(--warn)";
    case "outage":
      return "var(--bad)";
    default:
      return "var(--text-dim)";
  }
}

/** The core stage's own static strings (MESSAGES, so ar/en never fall back
 *  to whatever index.html happened to hardcode) and its two live controls:
 *  the filter, and the SESSIONS card's link to the full Session view. */
function wireCoreStage(): void {
  // The threads' endpoints are DOM positions, so any reflow re-measures
  // them: window size, the grid's own scroll, or its content changing.
  window.addEventListener("resize", layoutLinks);
  const gridEl = document.getElementById("project-grid");
  gridEl?.addEventListener("scroll", layoutLinks, { passive: true });
  if (gridEl !== null && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => layoutLinks()).observe(gridEl);
  }
  const label = document.getElementById("project-label");
  if (label !== null) label.textContent = MESSAGES.dashboardProjectsLabel(PRIMARY_LANGUAGE);
  const filterLabel = document.getElementById("project-filter-label");
  if (filterLabel !== null)
    filterLabel.textContent = MESSAGES.dashboardFilterLabel(PRIMARY_LANGUAGE);
  const filterInput = document.getElementById("project-filter");
  if (filterInput instanceof HTMLInputElement) {
    filterInput.placeholder = MESSAGES.dashboardFilterPlaceholder(PRIMARY_LANGUAGE);
    filterInput.addEventListener("input", () => {
      projectFilter = filterInput.value;
      renderProjectGrid();
    });
  }
  const allSessions = document.getElementById("all-sessions-link");
  if (allSessions !== null) {
    allSessions.textContent = MESSAGES.dashboardAllSessions(PRIMARY_LANGUAGE);
    // The Session route's own nav button already does exactly this; reusing
    // its click rather than duplicating showView()/releaseVoice() keeps
    // there being exactly one place that logic lives.
    allSessions.addEventListener("click", () => {
      document.getElementById("nav-session")?.click();
    });
  }
}

// Shared by the live Sessions panel and the History panel so a past
// session's row matches an active one's visual language exactly — same
// palette, type scale, and dot/state/summary/meta structure — rather than
// inventing separate markup for history rows.
function buildSessionRow(session: Session): HTMLElement {
  const row = document.createElement("div");
  row.className = `session session--${session.state}`;

  const head = document.createElement("div");
  head.className = "session__head";

  const dot = document.createElement("span");
  dot.className = "dot";
  head.append(dot);

  const project = document.createElement("span");
  project.className = "session__project";
  const label = projectLabel(session);
  const projectLanguage = detectLanguage(label);
  project.dir = projectLanguage === "ar" ? "rtl" : "ltr";
  if (projectLanguage === "ar") project.classList.add("arabic");
  project.textContent = label;
  head.append(project);

  const spacer = document.createElement("div");
  spacer.style.flexGrow = "1";
  head.append(spacer);

  const diffBadge = buildDiffBadge(session, latestChanges.get(session.id));
  if (diffBadge !== undefined) {
    // The row itself opens the transcript, so the badge keeps the Changes
    // view reachable. stopPropagation, or the row's own handler would fire
    // straight afterwards and replace the diff with the transcript.
    diffBadge.addEventListener("click", (event) => {
      event.stopPropagation();
      closeHistoryOverlay();
      void openChanges(session.id);
    });
    diffBadge.classList.add("session__diff--clickable");
    head.append(diffBadge);
  }

  const state = document.createElement("span");
  state.className = "session__state mono";
  state.textContent = session.state;
  head.append(state);

  const summaryText = session.summary === "" ? summaryFallback(session.state) : session.summary;
  const summary = document.createElement("div");
  summary.className = "session__summary";
  const summaryLanguage = detectLanguage(summaryText);
  summary.dir = summaryLanguage === "ar" ? "rtl" : "ltr";
  if (summaryLanguage === "ar") summary.classList.add("arabic");
  summary.textContent = summaryText;

  const meta = document.createElement("div");
  meta.className = "session__meta mono";
  meta.textContent = [session.agentId, session.model].filter(Boolean).join(" · ");

  row.append(head, summary, meta);
  // A row click opens the session's own transcript — what the user came to
  // the row for is "what is this agent doing". Its diff badge is the route
  // to the Changes view instead (see buildDiffBadge), so both destinations
  // stay one click away.
  //
  // This row is shared with the History panel (buildHistoryRow below), whose
  // full-screen `.history-overlay` sits on top of everything else — without
  // closing it first, the view underneath renders behind the scrim and the
  // click appears to do nothing (I1). Closing it here is a no-op for the
  // live Sessions panel, where the overlay is already hidden.
  row.addEventListener("click", () => {
    closeHistoryOverlay();
    void openSession(session);
  });
  return row;
}

// A live session's badge comes only from the live tracker stream, and only
// when there is something to show. A past session's badge comes only from
// its own *recorded* counts (SessionStore.updateGit, frozen at end by
// ruling P28's ChangeTracker fix) — never the live tracker, whose entry for
// a finished session's repoPath could by now belong to whatever different
// session (or the user's own edits) is currently touching that same
// project (ruling P21). `branch === ""` is the honest "never recorded
// anything for this session" signal: SessionStore's upsert() never writes
// the git columns at all, so a session that ended before any refresh cycle
// (or before Task 16 existed) is left at that column's schema default,
// which no real git read ever produces. That case renders no badge — kept
// visibly different from a genuine "recorded zero changes" session, which
// still renders "+0 −0" rather than being silently indistinguishable from
// "we have no idea" (the exact conflation ruling P21 exists to avoid).
function buildDiffBadge(
  session: Session,
  live: SessionChanges | undefined,
): HTMLElement | undefined {
  if (session.endedAt === undefined) {
    if (live === undefined || (live.insertions === 0 && live.deletions === 0)) return undefined;
    return diffPill(live.insertions, live.deletions);
  }
  if (session.branch === undefined || session.branch === "") return undefined;
  return diffPill(session.insertions ?? 0, session.deletions ?? 0);
}

function diffPill(insertions: number, deletions: number): HTMLElement {
  const diff = document.createElement("div");
  diff.className = "session__diff mono";
  // dir is pinned LTR: this is a numeric counter with +/− signs, and an
  // RTL ancestor would otherwise reorder the sign and the digits.
  diff.dir = "ltr";
  // One space, matching design/Main.dc.html lines 96 and 107 verbatim
  // (a single bordered pill carrying both numbers, not two spans).
  diff.textContent = `+${insertions} −${deletions}`;
  return diff;
}

function summaryFallback(state: SessionState): string {
  switch (state) {
    case "starting":
      return "Starting…";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting for your answer";
    case "done":
      return "Done";
    case "dead":
      return "Stopped";
  }
}

// Alt+Space starts a recording and Alt+Shift+Space stops it — there is no
// hold-to-talk gesture (Electron's globalShortcut has no key-release
// event), so the idle copy names both shortcuts rather than describing a
// "hold" gesture that doesn't exist.
const VOICE_IDLE: VoiceNotice = { text: "⌥Space to start · ⌥⇧Space to stop", language: "en" };
const VOICE_LISTENING: VoiceNotice = { text: "Listening…", language: "en" };
const NOTICE_DURATION_MS = 2500;

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let isListening = false;

function renderListening(listening: boolean): void {
  isListening = listening;
  renderVoiceTarget(openSessionId() !== undefined, listening);
  clearNotice();
  setVoiceState(listening ? VOICE_LISTENING : VOICE_IDLE);
  const micButton = document.getElementById("mic-button");
  micButton?.classList.toggle("voice-btn--active", listening);
}

// M-b: the mic button drives the exact same start/stop path as the global
// Alt+Space / Alt+Shift+Space hotkey (via the main process's startVoice /
// stopVoice), so voice input has one implementation regardless of which
// control triggers it.
function wireMicButton(): void {
  const micButton = document.getElementById("mic-button");
  micButton?.addEventListener("click", () => {
    if (isListening) void window.jarvis.stopVoice();
    else void window.jarvis.startVoice();
  });
}

// Sessions only (not the conversation transcript, not agent stdout) — see
// task 17's scope. History is pulled once, on open, not kept live: there is
// no sessions:update-style push channel for it, so reopening the panel is
// what refreshes it.
function wireHistoryPanel(): void {
  const button = document.getElementById("history-button");
  const closeButton = document.getElementById("history-close");
  const overlay = document.getElementById("history-overlay");
  if (!(overlay instanceof HTMLElement)) return;

  const open = (): void => {
    overlay.hidden = false;
    // Hosted pages are native WebContentsViews painted above the renderer;
    // no CSS stacking value can put this DOM overlay in front of one.
    syncHostedView();
    window.jarvis
      .getHistory()
      .then(renderHistoryList)
      .catch((error: unknown) => {
        console.error(`Failed to load session history: ${errorMessage(error)}`);
        renderHistoryList([]);
      });
  };
  button?.addEventListener("click", open);
  closeButton?.addEventListener("click", closeHistoryOverlay);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeHistoryOverlay();
  });
}

// Shared with buildSessionRow's row click handler (I1): a History row opens
// the Changes view behind this same full-screen overlay unless it is closed
// first. A no-op when the overlay doesn't exist yet (app.test.ts's minimal
// DOM harness) or is already hidden.
function closeHistoryOverlay(): void {
  const overlay = document.getElementById("history-overlay");
  if (!(overlay instanceof HTMLElement) || overlay.hidden) return;
  overlay.hidden = true;
  syncHostedView();
}

function renderHistoryList(sessions: Session[]): void {
  $("history-count").textContent = MESSAGES.sessionsCount(sessions.length, PRIMARY_LANGUAGE);
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sessions-empty";
    empty.textContent = "No past sessions yet.";
    $("history-list").replaceChildren(empty);
    return;
  }
  // Most recently active first: what the sqlite store's history() already
  // returns, so no re-sort is needed here.
  $("history-list").replaceChildren(...sessions.map(buildHistoryRow));
}

function buildHistoryRow(session: Session): HTMLElement {
  const row = buildSessionRow(session);
  if (session.endedAt === undefined) return row;

  const ended = document.createElement("div");
  ended.className = "session__meta mono";
  const endedBadge = document.createElement("span");
  endedBadge.className = "session__ended";
  endedBadge.textContent = endedLabel(session);
  ended.append(endedBadge, formatEndedAt(session.endedAt));
  row.append(ended);
  return row;
}

// Distinguishes the three ways a session's row ended, matching how
// SessionManager records them: a real process exit (code 0 -> "done") vs.
// a non-zero exit (exitCode set, "dead") vs. a manual kill() (no
// process-reported exitCode at all, "dead").
function endedLabel(session: Session): string {
  if (session.state === "done") return "Exited cleanly";
  if (session.exitCode === undefined) return "Stopped";
  return `Exited (code ${session.exitCode})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A transient status distinct from the idle/listening state — e.g. "heard
// nothing" — shown briefly and then reverted, never turned into a turn.
function renderNotice(notice: VoiceNotice): void {
  clearNotice();
  setVoiceState(notice);
  noticeTimer = setTimeout(() => {
    noticeTimer = undefined;
    setVoiceState(VOICE_IDLE);
  }, NOTICE_DURATION_MS);
}

function clearNotice(): void {
  if (noticeTimer === undefined) return;
  clearTimeout(noticeTimer);
  noticeTimer = undefined;
}

function setVoiceState(notice: VoiceNotice): void {
  const el = $("voice-state");
  el.textContent = notice.text;
  el.dir = notice.language === "ar" ? "rtl" : "ltr";
  el.classList.toggle("arabic", notice.language === "ar");
}

function renderTurn(turn: Turn): void {
  const bubble = document.createElement("div");
  bubble.className = `turn turn--${turn.role}`;

  const text = document.createElement("div");
  text.className = "turn__text";
  if (turn.language === "ar") {
    text.dir = "rtl";
    text.classList.add("arabic");
  }
  text.textContent = turn.text;
  bubble.append(text);

  const meta = [turn.agentId, turn.model].filter(Boolean).join(" › ");
  if (meta !== "") {
    const metaLine = document.createElement("div");
    metaLine.className = "turn__meta mono";
    metaLine.textContent = meta;
    bubble.append(metaLine);
  }

  const conversation = $("conversation");
  const empty = conversation.querySelector(".conversation-empty");
  empty?.remove();
  conversation.append(bubble);
  conversation.scrollTop = conversation.scrollHeight;

  // Voice and text are one input path: a turn whose tool call asked to show
  // the changes opens the view here, so "وريني التغييرات" does the same
  // thing as clicking Changes.
  if (turn.view === "changes" && turn.sessionId !== undefined) {
    void openChanges(turn.sessionId, turn.path);
  }
}

function wireComposer(): void {
  const input = document.getElementById("composer");
  const sendButton = document.getElementById("composer-send");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing #composer input");

  const submit = (): void => {
    const text = input.value.trim();
    if (text === "") return;
    input.value = "";
    // The gap between the question leaving and the answer arriving is the
    // one state nothing else observes both ends of.
    setPresenceThinking(true);
    void window.jarvis.send(text, detectLanguage(text));
  };

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    submit();
  });

  sendButton?.addEventListener("click", submit);
}

function startClock(): void {
  const timeEl = document.getElementById("clock-time");
  const clock = timeEl?.closest<HTMLElement>(".clock");
  if (timeEl === null || clock === null || clock === undefined) return;

  const tick = (): void => {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    clock.title = now.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    renderPrayer(now);
    checkPrayerNotifications(now);
  };

  tick();
  setInterval(tick, 1000);
}

/**
 * The chords a user can read, written from the same table that dispatches
 * them.
 *
 * index.html carries the macOS spelling as its literal text so a renderer
 * that fails before this runs still shows something sensible; this replaces
 * it. Two places spelling one shortcut is how a hint ends up advertising a
 * key that does nothing on the machine reading it.
 */
function labelShortcuts(): void {
  const platform = hostPlatform();
  const start = keyLabel("voiceStart", platform);
  const stop = keyLabel("voiceStop", platform);

  const empty = document.getElementById("conversation-empty");
  if (empty !== null) {
    empty.textContent = `No conversation yet — type below, or press ${start} to start talking and ${stop} to stop.`;
  }

  const composer = document.getElementById("composer");
  if (composer !== null) {
    composer.setAttribute("placeholder", `Type, or press ${start} to talk, ${stop} to stop…`);
  }

  const mic = document.getElementById("mic-button");
  if (mic !== null) {
    mic.setAttribute("aria-label", `Start or stop voice input (${start} / ${stop})`);
  }
}

/**
 * The temperature tile, and the note that says why it is empty.
 *
 * Whether the machine will answer at all is not a platform fact, it is a
 * machine fact: a desktop Linux box reads it from /sys/class/thermal with no
 * privileges, Apple Silicon reports nothing without a privileged helper, and
 * a VM usually has no sensor to read. So the note is driven by whether a
 * reading arrived, not by process.platform — the alternative was the note
 * this replaces, which announced an Apple Silicon limitation to every Linux
 * user while the reading sat there unused.
 */
function renderTemperature(celsius: number | undefined): void {
  const value = document.getElementById("temp-value");
  const note = document.getElementById("temp-note");
  if (value === null || note === null) return;

  if (celsius === undefined) {
    // Blank rather than a dash-and-caption pair: on the CPU row's detail
    // slot (board 0's SYSTEM card), a reading that a machine simply cannot
    // give is better said nowhere than said badly. The note carries the
    // reason, folded down until the row is actually asked about it.
    value.textContent = "";
    note.textContent = "No temperature sensor this process can read.";
    note.hidden = false;
    return;
  }

  value.textContent = `${Math.round(celsius)}°`;
  note.textContent = "";
  note.hidden = true;
}
