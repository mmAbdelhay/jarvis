import type {
  Session,
  SessionChanges,
  SessionState,
  SystemMetrics,
  Turn,
} from "@jarvis/core";
import type { RendererApi, VoiceNotice } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { applyStaticChrome, openChanges, wireCommitBar, wireDiffModes } from "./changes.js";
import { showView } from "./views.js";
import { initWorkspace, renderWorkspace, reportWorkspaceBounds } from "./workspace.js";
import { initSettings, openSettings } from "./settings.js";
import { detectLanguage, formatBytes, formatDiskUsage, formatEndedAt, formatUptime } from "./format.js";
import { renderProviders, wireProvidersPanel } from "./providers.js";
import {
  appendSessionOutput,
  openSession,
  openSessionId,
  releaseVoice,
  renderEmptyState,
  renderVoiceTarget,
  updateSessionHeader,
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
let latestChanges = new Map<string, SessionChanges>();

window.jarvis.onMetrics((metrics) => renderMetrics(metrics));
window.jarvis.onSessions((sessions) => {
  const previous = latestSessions;
  latestSessions = sessions;
  renderSessions(latestSessions);
  updateSessionHeader(latestSessions);
  autoOpenNewSession(previous, sessions);
});
window.jarvis.onTurn((turn) => renderTurn(turn));
window.jarvis.onListening((listening) => renderListening(listening));
window.jarvis.onNotice((notice) => renderNotice(notice));
window.jarvis.onChangeCounts((changes) => {
  latestChanges = new Map(changes.map((entry) => [entry.sessionId, entry]));
  renderSessions(latestSessions);
});
window.jarvis.onProviders((statuses) => renderProviders(statuses, Date.now()));
window.jarvis.onSessionOutput((output) => appendSessionOutput(output));

startClock();
applyStaticChrome();
wireComposer();
wireMicButton();
wireHistoryPanel();
wireNav();
wireDiffModes();
wireCommitBar();
wireProvidersPanel();
wireSessionView();
renderEmptyState();

// The whole point of starting a session is to watch it work, so a newly
// started one opens its transcript without being asked — the behaviour the
// dashboard was missing ("when i start a session it's not opening it so i
// can see it"). Only genuinely new ids qualify: a state change or a git
// count landing on an existing session must never yank the view away from
// whatever the user is reading. Sessions live in memory for one app run, so
// the first update after launch is empty and nothing auto-opens at startup.
function autoOpenNewSession(previous: Session[], next: Session[]): void {
  const known = new Set(previous.map((session) => session.id));
  const started = next.filter((session) => !known.has(session.id));
  if (started.length === 0) return;
  // Newest first, so starting several at once lands on the last one.
  const newest = [...started].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (newest === undefined) return;
  void openSession(newest);
}

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
  } catch {
    // Settings' own markup is absent in this harness; nothing to wire.
  }

  window.jarvis.onWorkspace((state) => renderWorkspace(state));
  // No catch here would be an unhandled rejection in the renderer on any
  // failure downstream of the IPC call — including, as app.test.ts's
  // minimal harness proved, a DOM that has not laid down the workspace
  // route's markup.
  void window.jarvis
    .getProjects()
    .then((projects) => initWorkspace(projects))
    .catch(() => undefined);
}

function renderMetrics(metrics: SystemMetrics): void {
  $("cpu-value").textContent = `${metrics.cpuPercent}%`;
  $("cpu-bar").style.width = `${metrics.cpuPercent}%`;
  $("mem-value").textContent =
    `${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`;
  $("mem-bar").style.width =
    metrics.memoryTotalBytes > 0
      ? `${(metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100}%`
      : "0%";
  const disk = formatDiskUsage(metrics.diskUsedBytes, metrics.diskTotalBytes);
  $("disk-value").textContent = disk.used;
  $("disk-total").textContent = disk.total;
  $("uptime-value").textContent = formatUptime(metrics.uptimeSeconds);
  $("net-down").textContent = `↓ ${metrics.networkDownMbps.toFixed(1)}`;
  $("net-up").textContent = `↑ ${metrics.networkUpMbps.toFixed(1)}`;

  // Always-visible header summary, alongside network speed — the
  // Dashboard's own System panel still has the full byte-level detail.
  $("header-cpu").textContent = `${Math.round(metrics.cpuPercent)}%`;
  $("header-mem").textContent =
    metrics.memoryTotalBytes > 0
      ? `${Math.round((metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100)}%`
      : "--%";
  $("header-disk").textContent =
    metrics.diskTotalBytes > 0
      ? `${Math.round((metrics.diskUsedBytes / metrics.diskTotalBytes) * 100)}%`
      : "--%";
}

function renderSessions(sessions: Session[]): void {
  $("session-count").textContent = `${sessions.length} live`;
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sessions-empty";
    empty.textContent = "No active sessions.";
    $("sessions").replaceChildren(empty);
    return;
  }
  $("sessions").replaceChildren(...sessions.map(renderSession));
}

function renderSession(session: Session): HTMLElement {
  return buildSessionRow(session);
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
  const projectLanguage = detectLanguage(session.project);
  project.dir = projectLanguage === "ar" ? "rtl" : "ltr";
  if (projectLanguage === "ar") project.classList.add("arabic");
  project.textContent = session.project;
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
function buildDiffBadge(session: Session, live: SessionChanges | undefined): HTMLElement | undefined {
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
  if (overlay instanceof HTMLElement) overlay.hidden = true;
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
  const dateEl = document.getElementById("clock-date");
  if (timeEl === null || dateEl === null) return;

  const tick = (): void => {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
    dateEl.textContent = now.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  tick();
  setInterval(tick, 1000);
}
