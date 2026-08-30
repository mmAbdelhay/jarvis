import type { Session, SessionState, SystemMetrics, Turn } from "@jarvis/core";
import type { RendererApi } from "../src/ipc.js";
import { detectLanguage, formatBytes, formatUptime } from "./format.js";

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

startClock();
wireComposer();

function renderMetrics(metrics: SystemMetrics): void {
  $("cpu-value").textContent = `${metrics.cpuPercent}%`;
  $("cpu-bar").style.width = `${metrics.cpuPercent}%`;
  $("mem-value").textContent =
    `${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`;
  $("mem-bar").style.width =
    metrics.memoryTotalBytes > 0
      ? `${(metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100}%`
      : "0%";
  $("disk-value").textContent = formatBytes(metrics.diskUsedBytes);
  $("disk-total").textContent = `/ ${formatBytes(metrics.diskTotalBytes)}`;
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
  const row = document.createElement("div");
  row.className = `session session--${session.state}`;

  const head = document.createElement("div");
  head.className = "session__head";

  const dot = document.createElement("span");
  dot.className = "dot";
  head.append(dot);

  const project = document.createElement("span");
  project.className = "session__project";
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
  summary.dir = detectLanguage(summaryText) === "ar" ? "rtl" : "ltr";
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

function renderTurn(turn: Turn): void {
  const bubble = document.createElement("div");
  bubble.className = `turn turn--${turn.role}`;

  const text = document.createElement("div");
  text.className = "turn__text";
  if (turn.language === "ar") {
    text.dir = "rtl";
    text.classList.add("turn__text--arabic");
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
