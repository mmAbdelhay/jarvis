import type { GitFileChange } from "@jarvis/core";
import type { ChangesView, GitViewResult } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
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

// Ruling P22: gitChanges() always reads the repository's *current* working
// tree — it has no per-session snapshot to read instead (Task 16 adds one).
// A History row still opens this view (Task 12's affordance is kept), but
// for a session that has already ended the file list below is not
// necessarily that session's own work, so this says so plainly rather than
// silently repeating the lie ruling P21 removed from the session badge.
function renderStaleNotice(view: ChangesView): void {
  const banner = $("changes-stale-notice");
  if (view.session.endedAt === undefined) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  setText(banner, MESSAGES.changesShowCurrentState(view.session.agentId, PRIMARY_LANGUAGE));
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
  renderStaleNotice(view);
}

// Matches the artboard's TESTS group. A path segment (or a filename stem)
// that is literally "test", "tests", "spec" or "specs" — bounded by a path
// separator, a dot, an underscore or a hyphen (or the start/end of the
// string) on both sides. A plain substring match would also sweep in
// "contest.php"; this boundary rule is what the brief's own fixture
// ("tests/RetryPolicyTest.php" — a *directory* named tests/, not a bare
// "…Test.php" suffix) actually exercises, so that is the rule implemented:
// a real "tests"/"specs" path segment, not any filename ending in "Test".
const TEST_PATH = /(^|[/._-])(tests?|specs?)([/._-]|$)/i;

const STATUS_COLOUR: Record<GitFileChange["status"], string> = {
  M: "status-m",
  A: "status-a",
  D: "status-d",
  R: "status-r",
  C: "status-r",
  U: "status-d",
  "?": "status-q",
};

let selected: string | undefined;

export function selectedPath(): string | undefined {
  return selected;
}

// Filled in by Task 14.
async function renderDiff(_view: ChangesView): Promise<void> {}

function countEl(className: string, text: string): HTMLElement {
  const element = document.createElement("span");
  element.className = `${className} mono`;
  // Counters are digits with a sign: they stay LTR even inside an RTL row.
  element.dir = "ltr";
  element.textContent = text;
  return element;
}

function fileRow(view: ChangesView, file: GitFileChange): HTMLElement {
  const row = document.createElement("div");
  row.className = file.path === selected ? "file-row file-row--on" : "file-row";

  const stage = document.createElement("button");
  stage.type = "button";
  stage.className = file.staged ? "file-stage file-stage--on" : "file-stage";
  stage.setAttribute("aria-label", file.staged ? "Unstage file" : "Stage file");
  stage.addEventListener("click", (event) => {
    // Without this the row's own click handler would also fire and the
    // selection would jump every time someone staged a file.
    event.stopPropagation();
    void window.jarvis
      .gitSetStaged(view.session.id, file.path, !file.staged)
      .then((result) => {
        if (!result.ok) {
          showError(result);
          return;
        }
        // Re-fetching and re-rendering from a fresh gitChanges() read
        // (rather than mutating `file.staged` locally) is what keeps a
        // rapid double-click from corrupting the displayed state: each
        // click's resolution independently redraws the whole panel from
        // whatever the repository's current state actually is, so the
        // last response to land always wins over a stale one, instead of
        // two racing in-place mutations disagreeing with each other.
        return openChanges(view.session.id, selected);
      });
  });

  const status = document.createElement("span");
  status.className = `file-status mono ${STATUS_COLOUR[file.status]}`;
  status.textContent = file.status;

  const name = document.createElement("span");
  name.className = "file-name";
  setText(name, file.path);

  row.append(stage, status, name);
  if (file.insertions > 0) row.append(countEl("diff-add", `+${file.insertions}`));
  if (file.deletions > 0) row.append(countEl("diff-del", `−${file.deletions}`));

  row.addEventListener("click", () => {
    selected = file.path;
    renderFiles(view);
    void renderDiff(view);
  });

  return row;
}

function renderFiles(view: ChangesView): void {
  const list = $("changes-file-list");
  $("changes-count").textContent = `${view.changes.files.length}`;

  const main = view.changes.files.filter((file) => !TEST_PATH.test(file.path));
  const tests = view.changes.files.filter((file) => TEST_PATH.test(file.path));

  const nodes: HTMLElement[] = main.map((file) => fileRow(view, file));

  if (tests.length > 0) {
    const spacer = document.createElement("div");
    spacer.className = "file-gap";
    const label = document.createElement("div");
    label.className = "file-group";
    label.textContent = "TESTS";
    nodes.push(spacer, label, ...tests.map((file) => fileRow(view, file)));
  }

  list.replaceChildren(...nodes);
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

  const files = result.value.changes.files;
  const requested = files.find((file) => file.path === path);
  selected = requested?.path ?? files[0]?.path;
  renderFiles(result.value);
  await renderDiff(result.value);
}
