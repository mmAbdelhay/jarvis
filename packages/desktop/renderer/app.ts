import type { Session, SessionState, SystemMetrics, Turn } from "@jarvis/core";
import type { RendererApi, VoiceNotice } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { detectLanguage, formatBytes, formatDiskUsage, formatEndedAt, formatUptime } from "./format.js";

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

window.jarvis.onMetrics((metrics) => renderMetrics(metrics));
window.jarvis.onSessions((sessions) => renderSessions(sessions));
window.jarvis.onTurn((turn) => renderTurn(turn));
window.jarvis.onListening((listening) => renderListening(listening));
window.jarvis.onNotice((notice) => renderNotice(notice));

startClock();
wireComposer();
wireMicButton();
wireHistoryPanel();

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
  return row;
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
  const close = (): void => {
    overlay.hidden = true;
  };

  button?.addEventListener("click", open);
  closeButton?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
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
