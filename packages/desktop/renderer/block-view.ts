// A finished command's block, as the user sees it: a header carrying the
// command, its exit status, its duration and where it ran, plus four
// controls, over the output renderOutput() already knows how to draw.
//
// Built the way terminal-find-close is built in terminal-addons.ts —
// document.createElement and textContent throughout, never innerHTML. The
// command comes out of the user's own shell and is untrusted exactly like
// the program output next to it, so nothing here trusts it either.

import { renderOutput } from "./block-render.js";
import type { BlockRecord } from "./terminal-blocks.js";

export type BlockViewHooks = {
  cols: number;
  /** Puts text in the input editor — or, with no editor, types it at the
   *  prompt. Never runs it. */
  fill: (command: string) => void;
  copy: (text: string) => void;
  /** The user's home directory, for collapsing `cwd` to `~`. */
  home: string;
  /** The more menu's "Filter to this command" — narrows the block list down
   *  to blocks that ran this exact command. Wired to the pane's BlockNav. */
  filterToCommand: (command: string) => void;
  /** Makes this block the selected one — what clicking its header does,
   *  and the only pointer route to the palette's "Copy output" and
   *  "Re-run command", which act on the selection. Wired to the pane's
   *  BlockNav; absent for a pane with no nav (blocks switched off), where
   *  there is no selection to make. */
  select?: ((view: BlockView) => void) | undefined;
};

export type BlockView = {
  element: HTMLElement;
  record: BlockRecord;
  setSelected(selected: boolean): void;
  collapse(collapsed: boolean): void;
  isCollapsed(): boolean;
  text(): string;
  /**
   * Appends (or, on a second call, replaces) a `.block-explanation` element
   * holding the brain's answer to "Explain this failure" — via
   * `textContent`, never `innerHTML`: the answer is untrusted text
   * rendered exactly like the block's own output. "" does nothing, which
   * is what a failed or empty explain call already resolves to.
   */
  explain(text: string): void;
};

/** `((endedAt - startedAt) / 1000).toFixed(1) + "s"` under a minute,
 *  `Xm Ys` above it. A command with no end yet (should not reach this view,
 *  which only ever sees finished blocks, but nothing here may throw over
 *  it) is treated as zero-length rather than negative or NaN. */
function formatDuration(startedAt: number, endedAt: number | undefined): string {
  const millis = Math.max(0, (endedAt ?? startedAt) - startedAt);
  const seconds = millis / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  // Rounded to whole seconds first, then split — splitting the unrounded
  // value can round a >=59.5s remainder up to "60s" (e.g. 119.5s would read
  // as "1m 60s" instead of "2m 0s").
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return `${minutes}m ${rest}s`;
}

/** `cwd` with `$HOME` collapsed to `~`, by string prefix. A cwd that merely
 *  starts with the same characters as home ("/Users/xavier" against home
 *  "/Users/x") is not under it and is left alone — the prefix must end at a
 *  path separator, or be the whole string. */
function formatCwd(cwd: string | undefined, home: string): string {
  if (cwd === undefined) return "";
  if (home === "") return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(home.endsWith("/") ? home : `${home}/`)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

/** A `<span role="button">`, matching how terminal-find-close is built. */
function actionButton(className: string, label: string, title: string): HTMLElement {
  const button = document.createElement("span");
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.setAttribute("role", "button");
  return button;
}

function buildHeader(record: BlockRecord, hooks: BlockViewHooks, view: BlockView): HTMLElement {
  const header = document.createElement("div");
  header.className = "block-header";
  // Clicking a header selects the block, as the design and the guide both
  // say it does. Without it the selection is reachable only from ⌘↑/⌘↓ and
  // there is no pointer route at all to the palette actions that act on it.
  // Every control inside the header stops propagation, so this never fires
  // for a click on collapse, copy, re-run or more.
  header.addEventListener("click", () => hooks.select?.(view));

  const command = document.createElement("span");
  command.className = "block-command";
  command.textContent = record.command;

  const status = document.createElement("span");
  status.className = "block-status";
  status.textContent = record.exitCode === 0 ? "✓" : `✗ ${record.exitCode ?? "?"}`;

  const duration = document.createElement("span");
  duration.className = "block-duration";
  duration.textContent = formatDuration(record.startedAt, record.endedAt);

  const cwd = document.createElement("span");
  cwd.className = "block-cwd";
  cwd.textContent = formatCwd(record.cwd, hooks.home);

  const actions = document.createElement("span");
  actions.className = "block-actions";

  const collapseButton = actionButton("block-collapse", "▾", "Collapse");
  collapseButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const next = !view.isCollapsed();
    view.collapse(next);
    collapseButton.textContent = next ? "▸" : "▾";
    collapseButton.title = next ? "Expand" : "Collapse";
  });

  const copyButton = actionButton("block-copy", "⧉", "Copy output");
  copyButton.addEventListener("click", (event) => {
    event.stopPropagation();
    hooks.copy(record.output);
  });

  // Re-run does not run. It fills the input — the editor, or the prompt
  // with no editor — and stops there, so a stray click on a block whose
  // command was destructive never fires it.
  const rerunButton = actionButton("block-rerun", "↻", "Fill command");
  rerunButton.addEventListener("click", (event) => {
    event.stopPropagation();
    hooks.fill(record.command);
  });

  const moreButton = actionButton("block-more", "⋯", "More");
  moreButton.setAttribute("aria-expanded", "false");
  const menu = buildMoreMenu(record, hooks);
  moreButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const next = menu.hidden; // opening if it was hidden
    menu.hidden = !next;
    moreButton.setAttribute("aria-expanded", String(next));
  });

  actions.append(collapseButton, copyButton, rerunButton, moreButton);
  header.append(command, status, duration, cwd, actions);

  const wrap = document.createElement("div");
  wrap.className = "block-header-wrap";
  wrap.append(header, menu);
  return wrap;
}

/** copy command, copy both, and filter to this command. */
function buildMoreMenu(record: BlockRecord, hooks: BlockViewHooks): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "block-more-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;

  const copyCommand = actionButton("block-more-item", "Copy command", "Copy command");
  copyCommand.dataset["action"] = "copy-command";
  copyCommand.addEventListener("click", (event) => {
    event.stopPropagation();
    hooks.copy(record.command);
    menu.hidden = true;
  });

  const copyBoth = actionButton("block-more-item", "Copy both", "Copy command and output");
  copyBoth.dataset["action"] = "copy-both";
  copyBoth.addEventListener("click", (event) => {
    event.stopPropagation();
    hooks.copy(`${record.command}\n${record.output}`);
    menu.hidden = true;
  });

  const filter = actionButton("block-more-item", "Filter to this command", "Filter to this command");
  filter.dataset["action"] = "filter";
  filter.addEventListener("click", (event) => {
    event.stopPropagation();
    hooks.filterToCommand(record.command);
    menu.hidden = true;
  });

  menu.append(copyCommand, copyBoth, filter);
  return menu;
}

/** Builds the block's DOM. Never throws: a header that cannot be built
 *  leaves a block that still shows its raw command and output rather than
 *  taking the pane down with it. */
export function createBlockView(record: BlockRecord, hooks: BlockViewHooks): BlockView {
  const element = document.createElement("div");
  element.className = "block";
  element.dataset["status"] = record.exitCode === 0 ? "ok" : "failed";

  let collapsed = false;
  let explanationEl: HTMLElement | undefined;
  const view: BlockView = {
    element,
    record,
    setSelected(selected: boolean): void {
      element.classList.toggle("selected", selected);
    },
    collapse(next: boolean): void {
      collapsed = next;
      element.classList.toggle("collapsed", collapsed);
    },
    isCollapsed(): boolean {
      return collapsed;
    },
    text(): string {
      return `${record.command}\n${record.output}`;
    },
    explain(text: string): void {
      if (text === "") return;
      if (explanationEl === undefined) {
        explanationEl = document.createElement("div");
        explanationEl.className = "block-explanation";
        element.append(explanationEl);
      }
      // textContent, deliberately — see the type's own note above.
      explanationEl.textContent = text;
    },
  };

  try {
    element.append(buildHeader(record, hooks, view));
  } catch {
    // No header — the block still shows its command as plain text.
    const fallback = document.createElement("div");
    fallback.className = "block-header";
    fallback.textContent = record.command;
    element.append(fallback);
  }

  element.append(renderOutput(record.output, hooks.cols));

  if (record.truncated) {
    const elided = document.createElement("div");
    elided.className = "block-elided";
    // The middle, not the end: the splitter keeps the head and the tail of
    // anything past 2 MB and marks the gap between them inline (a build
    // log's failure is at its end, so the tail is the half that matters).
    elided.textContent = "… capped at 2 MB — the middle of this output is elided above";
    element.append(elided);
  }

  return view;
}
