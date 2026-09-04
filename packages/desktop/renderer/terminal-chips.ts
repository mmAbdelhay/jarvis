// packages/desktop/renderer/terminal-chips.ts
//
// The chip row above a terminal's prompt — a runtime version, the shell's
// directory, its git branch and dirty counts, the strip Warp shows above
// its own input:
//
//   v22.11.0    ~/projects/jarvis    master    ± 4
//
// Pure rendering: this file owns no timer, no IPC call and no knowledge of
// panes or shells. It is handed a `TerminalChips` (or `undefined`, for a
// pane whose data is not ready or not known) and draws exactly that — the
// caller (terminal-pane.ts) decides when to call `render` and what to do
// while a read is in flight.
import type { TerminalChips } from "../src/ipc.js";

export type ChipRow = {
  element: HTMLElement;
  /** Draws exactly what `chips` says. `undefined` clears the row — a pane
   *  this process never started, or one whose read has not resolved yet
   *  and has nothing stale to show. A chip whose value is absent (no
   *  branch, no runtime) is left out of the row entirely, never drawn
   *  empty. */
  render(chips: TerminalChips | undefined): void;
};

/** `cwd` with `$HOME` collapsed to `~`, by path segment — not by string
 *  prefix. A cwd that merely starts with the same characters as home
 *  ("/Users/xavier" against home "/Users/x") is not under it and is left
 *  alone; the prefix has to end at a path separator, or be the whole
 *  string. */
function formatCwd(cwd: string, home: string): string {
  if (home === "") return cwd;
  if (cwd === home) return "~";
  const prefix = home.endsWith("/") ? home : `${home}/`;
  if (cwd.startsWith(prefix)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

/** One `<span class="terminal-chip">`, built with `createElement` and
 *  `textContent` — never `innerHTML`. A branch name is untrusted text: it
 *  comes from the repository, not from Jarvis. */
function chip(text: string, extraClass?: string): HTMLElement {
  const span = document.createElement("span");
  span.className = extraClass === undefined ? "terminal-chip" : `terminal-chip ${extraClass}`;
  span.textContent = text;
  return span;
}

export function createChipRow(host: HTMLElement, home: string): ChipRow {
  const element = document.createElement("div");
  element.className = "terminal-chips";
  host.append(element);

  return {
    element,
    render(chips) {
      element.replaceChildren();
      if (chips === undefined) return;
      if (chips.runtime !== undefined) element.append(chip(chips.runtime));
      element.append(chip(formatCwd(chips.cwd, home)));
      if (chips.branch !== undefined) {
        // A detached HEAD's "branch" is a short SHA, not a name — wrapped
        // in parentheses so it never reads as an ordinary branch.
        const label = chips.detached ? `(${chips.branch})` : chips.branch;
        element.append(chip(label, "terminal-chip--branch"));
        const total = chips.insertions + chips.deletions;
        element.append(chip(`± ${total}`, total > 0 ? "terminal-chip--dirty" : undefined));
      }
    },
  };
}
