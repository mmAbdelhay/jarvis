import type { ChangesView, GitViewResult } from "../src/ipc.js";
import { detectLanguage, formatAgo } from "./format.js";

// The Changes view's own module. It owns the whole right-hand route: the
// header (this task), the file list (Task 13), the diff panes (Task 14) and
// the commit bar (Task 15). No innerHTML anywhere in this file — diff and
// path text come from a repository and is untrusted, which makes this the
// app's sharpest XSS surface.

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

/** Sets text and direction together; every path, branch or message rendered
 *  by this module must go through it so an Arabic value is never laid out
 *  left-to-right. */
function setText(element: HTMLElement, text: string): void {
  const language = detectLanguage(text);
  element.dir = language === "ar" ? "rtl" : "ltr";
  element.classList.toggle("arabic", language === "ar");
  element.textContent = text;
}

let current: ChangesView | undefined;

/** Exposed for Tasks 13-15, which need the currently-open view's data
 *  (its file list, its repo path) without re-fetching it. */
export function currentView(): ChangesView | undefined {
  return current;
}

export function showView(name: "dashboard" | "changes"): void {
  const dashboard = document.querySelector(".main:not(.main--changes)");
  if (dashboard instanceof HTMLElement) dashboard.hidden = name !== "dashboard";
  $("view-changes").hidden = name !== "changes";
  $("nav-dashboard").classList.toggle("nav-btn--on", name === "dashboard");
  $("nav-changes").classList.toggle("nav-btn--on", name === "changes");
}

function showError(result: { text: string; language: "ar" | "en" }): void {
  const banner = $("changes-error");
  banner.hidden = false;
  banner.dir = result.language === "ar" ? "rtl" : "ltr";
  banner.classList.toggle("arabic", result.language === "ar");
  banner.textContent = result.text;
}

function clearError(): void {
  const banner = $("changes-error");
  banner.hidden = true;
  banner.textContent = "";
}

function renderHeader(view: ChangesView): void {
  setText($("changes-project"), view.session.project);
  setText($("changes-path"), view.session.projectPath);
  setText($("changes-branch"), view.changes.branch);
  $("changes-add").textContent = `+${view.changes.insertions}`;
  $("changes-del").textContent = `−${view.changes.deletions}`;
  // One template, one interpolation each: nothing here is assembled from
  // ordered fragments, so it survives an RTL agent id unchanged.
  $("changes-by").textContent =
    `written by ${view.session.agentId} · ${formatAgo(view.session.lastActivityAt, Date.now())}`;
}

export async function openChanges(sessionId: string, path?: string): Promise<void> {
  showView("changes");
  const result: GitViewResult<ChangesView> = await window.jarvis.gitChanges(sessionId);

  if (!result.ok) {
    current = undefined;
    showError(result);
    return;
  }

  clearError();
  current = result.value;
  renderHeader(result.value);
  // Task 13 renders the file list here; Task 14 selects `path` and renders
  // its diff. Until then `path` is accepted and ignored so the signature
  // does not change under Task 8's callers.
  void path;
}
