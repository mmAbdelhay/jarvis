import type { GitDiffHunk, GitDiffLine, GitFileChange, GitFileDiff } from "@jarvis/core";
import type { ChangesView, GitViewResult } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { detectLanguage, formatAgo } from "./format.js";
import { toSideBySide } from "./sidebyside.js";
import { showView } from "./views.js";

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
  // I2: routed through messages.ts's writtenBy(), not an inline
  // English-only template literal — this is user-facing chrome in an
  // Arabic-primary app. formatAgo's own output is localised the same way.
  setText(
    $("changes-by"),
    MESSAGES.writtenBy(
      view.session.agentId,
      formatAgo(view.session.lastActivityAt, Date.now(), PRIMARY_LANGUAGE),
      PRIMARY_LANGUAGE,
    ),
  );
  renderStaleNotice(view);
}

// Matches the artboard's TESTS group. Two independent shapes, both bounded
// so a plain substring match never sweeps in "contest.php":
//  1. a path segment (or filename stem) that is literally "test", "tests",
//     "spec" or "specs" — bounded by a path separator, a dot, an underscore
//     or a hyphen (or the start/end of the string) on both sides. Covers
//     "tests/RetryPolicyTest.php"'s *directory*.
//  2. a filename ending in "Test" or "Spec" right before the extension,
//     case-SENSITIVELY (unlike the segment rule above) — covers that same
//     fixture's actual filename, "RetryPolicyTest.php", and
//     "CheckoutTest.php": Task 13's first-draft regex matched neither of
//     the brief's own fixtures, since both are a camelCase suffix, not a
//     bounded segment. Case-sensitive is what keeps "contest.php" out:
//     case-insensitively, "conTEST.php" would match this suffix rule too
//     (it literally contains "test.php"), which is exactly the false
//     positive the segment rule above was already built to avoid.
const TEST_PATH_SEGMENT = /(^|[/._-])(tests?|specs?)([/._-]|$)/i;
const TEST_FILENAME_SUFFIX = /(Test|Spec)\.[^/.]+$/;

function isTestPath(path: string): boolean {
  return TEST_PATH_SEGMENT.test(path) || TEST_FILENAME_SUFFIX.test(path);
}

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

let mode: "side" | "unified" = "side";

// This function's whole reason to exist: `line.text` is a repository's file
// content, which an attacker fully controls. Every node here is built with
// document.createElement and every string lands via textContent — no
// innerHTML, no template-literal markup, anywhere in this module.
function lineRow(line: GitDiffLine | undefined, side: "before" | "after"): HTMLElement {
  const row = document.createElement("div");
  const kindClass =
    line === undefined
      ? "ln--blank"
      : line.kind === "added"
        ? "ln--add"
        : line.kind === "removed"
          ? "ln--del"
          : "ln--ctx";
  row.className = `ln ${kindClass}`;

  const num = document.createElement("div");
  num.className = "num";
  const number = side === "before" ? line?.beforeLine : line?.afterLine;
  num.textContent = number === undefined ? "" : `${number}`;

  const code = document.createElement("div");
  code.className = "code";
  // Code is the one sanctioned dir="ltr" exception in this app (everything
  // else is direction-per-element): a diff pane is fixed-width monospace
  // regardless of what script the line's own content happens to be in.
  code.dir = "ltr";
  code.textContent = line?.text ?? "";

  row.append(num, code);
  return row;
}

function hunkHead(hunk: GitDiffHunk): HTMLElement {
  const head = document.createElement("div");
  head.className = "hunk-head mono";
  head.dir = "ltr";
  head.textContent = hunk.header;
  return head;
}

// I2: BEFORE/AFTER now route through messages.ts like every other piece of
// user-facing chrome in this file — Task 13's "column chrome, not a
// sentence, so it can stay English-only" precedent was exactly the defect
// the Global Constraints name (a second English-only lane). The header gets
// its own `pane-head--${side}` class rather than reusing
// `pane--${side}` (the column class from hunkRow below): sharing the class
// made `.pane--before` match the header too, so `querySelector(".pane--before")`
// found a row even when every hunk row had been removed — a test could pass
// while rendering zero lines. The two are unambiguous now.
function paneHead(side: "before" | "after", label: string): HTMLElement {
  const heading = document.createElement("div");
  heading.className = `pane-head pane-head--${side}`;
  heading.textContent = label;
  return heading;
}

// One hunk's paired lines as a two-column row. The hunk header itself is
// rendered once by the caller, above this row, rather than inside each
// column — nesting it in both `.pane--before` and `.pane--after` would
// render it twice for every hunk, doubling every count a test (or a real
// reader) takes off the pane.
function hunkRow(hunk: GitDiffHunk): HTMLElement {
  const row = document.createElement("div");
  row.className = "diff-cols";

  const before = document.createElement("div");
  before.className = "pane pane--before";
  const after = document.createElement("div");
  after.className = "pane pane--after";

  for (const pair of toSideBySide(hunk.lines)) {
    before.append(lineRow(pair.before, "before"));
    after.append(lineRow(pair.after, "after"));
  }

  row.append(before, after);
  return row;
}

function renderSideBySide(diff: GitFileDiff): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-split";

  const head = document.createElement("div");
  head.className = "diff-cols";
  head.append(
    paneHead("before", MESSAGES.beforeColumnLabel(PRIMARY_LANGUAGE)),
    paneHead("after", MESSAGES.afterColumnLabel(PRIMARY_LANGUAGE)),
  );
  wrapper.append(head);

  for (const hunk of diff.hunks) {
    wrapper.append(hunkHead(hunk), hunkRow(hunk));
  }
  return wrapper;
}

function renderUnified(diff: GitFileDiff): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "diff-unified";
  for (const hunk of diff.hunks) {
    wrapper.append(hunkHead(hunk));
    for (const line of hunk.lines) {
      // A removed line is numbered by where it used to live; everything
      // else (context, added) by where it lives now.
      wrapper.append(lineRow(line, line.kind === "removed" ? "before" : "after"));
    }
  }
  return wrapper;
}

function diffNote(text: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "diff-note";
  setText(note, text);
  return note;
}

async function renderDiff(view: ChangesView): Promise<void> {
  const body = $("diff-body");
  const path = selected;
  if (path === undefined) {
    body.replaceChildren();
    $("diff-filename").textContent = "";
    return;
  }

  setText($("diff-filename"), path);

  // Captured before the await, the same defense the staging toggle above
  // relies on against its own race: two clicks in quick succession (A then
  // B) can have their gitDiff() responses land in either order. Without
  // this check, A's response resolving after B's would overwrite B's
  // already-rendered diff with A's — leaving B highlighted in the file
  // list while A's diff (and A's filename) sit in the pane. Comparing the
  // requested path against `selected` once the await returns means only
  // the response for whichever file is still selected is ever rendered;
  // a stale one is silently dropped.
  const requested = path;
  const result = await window.jarvis.gitDiff(view.session.id, requested);
  if (selected !== requested) return;

  if (!result.ok) {
    // Task 10's handlers never reject — a git failure arrives as a value,
    // so it is rendered here rather than caught. The file list stays as it
    // was: only the diff pane reflects the failure.
    showError(result);
    body.replaceChildren();
    return;
  }

  // A successful diff — of any of the four shapes handled below — means
  // whatever failure banner might still be showing (from a previous file's
  // failed gitDiff() call) no longer describes the file now on screen.
  clearError();

  const diff = result.value;

  // Three distinct states per ruling P8's GitFileDiff.tooLarge, checked in
  // core's own order (packages/core/src/git/messages.ts): tooLarge first,
  // since a file whose diff was never read (too large to have been read at
  // all) must not be reported as binary — it might not be. Only once
  // tooLarge is ruled out does a true `binary` confirmation apply, then a
  // genuinely empty diff.
  if (diff.tooLarge === true) {
    body.replaceChildren(diffNote(MESSAGES.diffTooLarge(PRIMARY_LANGUAGE)));
    return;
  }
  if (diff.binary) {
    body.replaceChildren(diffNote(MESSAGES.diffBinaryFile(PRIMARY_LANGUAGE)));
    return;
  }
  if (diff.hunks.length === 0) {
    body.replaceChildren(diffNote(MESSAGES.diffNoChanges(PRIMARY_LANGUAGE)));
    return;
  }

  body.replaceChildren(mode === "side" ? renderSideBySide(diff) : renderUnified(diff));
}

// I2: the Changes view's static English chrome — index.html has no language
// signal of its own, so this fills in the real (Arabic-primary) text at
// startup rather than shipping the placeholder English markup as the
// permanent UI. Every lookup is optional, same reasoning as wireDiffModes/
// wireCommitBar below: app.test.ts's minimal DOM harness doesn't lay down
// all of this markup, and a missing decorative label there must not throw.
export function applyStaticChrome(): void {
  const navDashboard = document.getElementById("nav-dashboard");
  if (navDashboard !== null) navDashboard.textContent = MESSAGES.navDashboard(PRIMARY_LANGUAGE);
  const navChanges = document.getElementById("nav-changes");
  if (navChanges !== null) navChanges.textContent = MESSAGES.navChanges(PRIMARY_LANGUAGE);
  const navSession = document.getElementById("nav-session");
  if (navSession !== null) navSession.textContent = MESSAGES.navSession(PRIMARY_LANGUAGE);
  const sessionTitle = document.getElementById("session-title");
  if (sessionTitle !== null) sessionTitle.textContent = MESSAGES.navSession(PRIMARY_LANGUAGE);

  const title = document.getElementById("changes-title");
  if (title !== null) title.textContent = MESSAGES.navChanges(PRIMARY_LANGUAGE);
  // The artboard's path/branch separator ("~/projects/acme on
  // feat/checkout-retry") was still a bare English literal in the markup —
  // the one spot I2's audit missed. Routed through the same bilingual table
  // as everything else here rather than left untranslated.
  const pathBranchSep = document.getElementById("changes-path-branch-sep");
  if (pathBranchSep !== null)
    pathBranchSep.textContent = MESSAGES.pathBranchSeparator(PRIMARY_LANGUAGE);
  const filesLabel = document.getElementById("changes-files-label");
  if (filesLabel !== null) filesLabel.textContent = MESSAGES.changedFilesLabel(PRIMARY_LANGUAGE);
  const sideButtonLabel = document.getElementById("diff-mode-side");
  if (sideButtonLabel !== null)
    sideButtonLabel.textContent = MESSAGES.sideBySideLabel(PRIMARY_LANGUAGE);
  const unifiedButtonLabel = document.getElementById("diff-mode-unified");
  if (unifiedButtonLabel !== null)
    unifiedButtonLabel.textContent = MESSAGES.unifiedLabel(PRIMARY_LANGUAGE);
  const message = document.getElementById("commit-message");
  if (message instanceof HTMLInputElement) {
    message.placeholder = MESSAGES.commitMessagePlaceholder(PRIMARY_LANGUAGE);
  }
}

/** Wires the Side-by-side / Unified toggle. Called once from app.ts.
 *  Uses optional lookups (not the throwing `$()`) because app.test.ts's DOM
 *  harness — which predates this task — does not lay down the Changes
 *  view's markup at all; only changes.test.ts's harness does. */
export function wireDiffModes(): void {
  const sideButton = document.getElementById("diff-mode-side");
  const unifiedButton = document.getElementById("diff-mode-unified");
  if (sideButton === null || unifiedButton === null) return;

  const set = (next: "side" | "unified"): void => {
    mode = next;
    sideButton.classList.toggle("diff-mode--on", next === "side");
    unifiedButton.classList.toggle("diff-mode--on", next === "unified");
    const view = current;
    if (view !== undefined) void renderDiff(view);
  };
  sideButton.addEventListener("click", () => set("side"));
  unifiedButton.addEventListener("click", () => set("unified"));
}

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
  stage.setAttribute(
    "aria-label",
    file.staged
      ? MESSAGES.unstageFileLabel(PRIMARY_LANGUAGE)
      : MESSAGES.stageFileLabel(PRIMARY_LANGUAGE),
  );
  stage.addEventListener("click", (event) => {
    // Without this the row's own click handler would also fire and the
    // selection would jump every time someone staged a file.
    event.stopPropagation();
    // Task 15 review: a stage toggle in flight must also block Commit —
    // without this, clicking Commit before this gitSetStaged() resolves
    // (and openChanges() re-renders) could commit a file's stage state the
    // button's label never described. Released on both branches below, the
    // same way `committing` is.
    stagingInFlight += 1;
    refreshCommitBar();
    void window.jarvis
      .gitSetStaged(view.session.id, file.path, !file.staged)
      .then((result) => {
        stagingInFlight -= 1;
        if (!result.ok) {
          showError(result);
          refreshCommitBar();
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
      })
      .catch(() => {
        // Belt-and-braces, same reasoning as the commit guard's own catch:
        // window.jarvis.gitSetStaged is documented to never reject, but if
        // it ever did, the guard must not get stuck disabled forever.
        stagingInFlight -= 1;
        refreshCommitBar();
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

  const main = view.changes.files.filter((file) => !isTestPath(file.path));
  const tests = view.changes.files.filter((file) => isTestPath(file.path));

  const nodes: HTMLElement[] = main.map((file) => fileRow(view, file));

  if (tests.length > 0) {
    const spacer = document.createElement("div");
    spacer.className = "file-gap";
    const label = document.createElement("div");
    label.className = "file-group";
    label.textContent = MESSAGES.testsGroupLabel(PRIMARY_LANGUAGE);
    nodes.push(spacer, label, ...tests.map((file) => fileRow(view, file)));
  }

  list.replaceChildren(...nodes);
  refreshCommitBar();
}

function commitInput(): HTMLInputElement {
  const element = document.getElementById("commit-message");
  if (!(element instanceof HTMLInputElement)) throw new Error("Missing #commit-message");
  return element;
}

function commitButton(): HTMLButtonElement {
  const element = document.getElementById("commit-button");
  if (!(element instanceof HTMLButtonElement)) throw new Error("Missing #commit-button");
  return element;
}

// A commit in flight guards the button against a second click landing
// before the first one's promise resolves — without it, a fast double
// click produces two real commits against the user's repository.
let committing = false;

// A counter, not a boolean: more than one file's stage toggle can be in
// flight at once (rapid clicks across different rows), and the button must
// stay disabled until every one of them has settled, not just the first.
// See the stage button's click handler in fileRow() for why this exists —
// this is the renderer-side half only; per-repo serialization of
// git:setStaged against git:commit in the main process is Task 17's.
let stagingInFlight = 0;

/** Recomputes the button's label and disabled state from the current
 *  view's staged files and the message field. Called after every render
 *  of the file list (staging changes the staged count) and after typing. */
function refreshCommitBar(): void {
  const staged = current?.changes.files.filter((file) => file.staged) ?? [];
  const button = commitButton();
  // I2: routed through messages.ts's commitButtonLabel(), the sharpest case
  // of this file's English-only-lane defect — a counted noun ("N files")
  // needs Arabic's singular/dual/plural agreement, not a number spliced
  // into a fixed English phrase.
  button.textContent = MESSAGES.commitButtonLabel(staged.length, PRIMARY_LANGUAGE);
  button.disabled =
    committing || stagingInFlight > 0 || staged.length === 0 || commitInput().value.trim() === "";
}

/** Wires the commit bar's message field and Commit button. Called once
 *  from app.ts, alongside wireNav()/wireDiffModes().
 *  Uses optional lookups (not the throwing commitInput()/commitButton())
 *  because app.test.ts's DOM harness — like wireDiffModes() above — does
 *  not lay down the Changes view's markup at all. */
export function wireCommitBar(): void {
  const input = document.getElementById("commit-message");
  const button = document.getElementById("commit-button");
  if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) return;

  input.addEventListener("input", () => refreshCommitBar());
  button.addEventListener("click", () => {
    const view = current;
    if (view === undefined || committing || stagingInFlight > 0) return;
    const message = commitInput().value.trim();
    if (message === "") return;

    committing = true;
    refreshCommitBar();

    void window.jarvis
      .gitCommit(view.session.id, message)
      .then((result) => {
        committing = false;
        if (!result.ok) {
          // Task 10's handlers never reject — a commit failure (nothing
          // staged, an empty message, a rejecting pre-commit hook) arrives
          // as a value, rendered here. The message stays in the field:
          // retyping a commit message you already wrote because the
          // commit failed is pure loss.
          showError(result);
          refreshCommitBar();
          return undefined;
        }
        clearError();
        commitInput().value = "";
        // The committed files are gone from the working tree's diff — the
        // file list, counts, staged count and button label all describe
        // state that no longer exists. Re-reading via openChanges() (the
        // same fresh-read-not-local-mutation approach the staging toggle
        // above already uses) redraws every one of them from what the
        // repository now actually contains, rather than guessing which
        // files the commit took.
        return openChanges(view.session.id);
      })
      .catch(() => {
        // Belt-and-braces: Task 10's handlers are documented to never
        // reject, but if window.jarvis.gitCommit ever did throw, the
        // in-flight guard must not get stuck forever.
        committing = false;
        refreshCommitBar();
      });
  });
}

// I3: a failed gitChanges() (e.g. session B's project isn't a repo) must not
// leave session A's file list, diff pane, filename or header on screen under
// the error banner — that reads as B's data, and a click on one of A's still
// -rendered rows would fire gitDiff() against A (its row closure captured
// A's `view`, never re-read from `current`). Clearing the file list removes
// those stale rows/closures entirely, not just the header text.
function clearView(): void {
  setText($("changes-project"), "");
  setText($("changes-path"), "");
  setText($("changes-branch"), "");
  $("changes-add").textContent = "";
  $("changes-del").textContent = "";
  setText($("changes-by"), "");
  const staleNotice = $("changes-stale-notice");
  staleNotice.hidden = true;
  staleNotice.textContent = "";
  $("changes-count").textContent = "";
  $("changes-file-list").replaceChildren();
  $("diff-filename").textContent = "";
  $("diff-body").replaceChildren();
  selected = undefined;
  refreshCommitBar();
}

export async function openChanges(sessionId: string, path?: string): Promise<void> {
  showView("changes");
  const result: GitViewResult<ChangesView> = await window.jarvis.gitChanges(sessionId);

  if (!result.ok) {
    current = undefined;
    clearView();
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
