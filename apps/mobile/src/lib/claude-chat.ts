// Task 8: what the phone's Claude Code chat view shows, as pure data — the
// feed rows (newest first, for an inverted list), the header lines, the key
// row and the small labels. Claude's own text is never translated or logged.
import type { ChatTool, ClaudeAnswerResult, ClaudeMode, ClaudeView } from "@jarvis/wire";
import type { MessageKey } from "./i18n";
import type { BarKey } from "./terminal-keys";

export type FeedItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; tool: ChatTool }
  | { kind: "working"; key: string; text: string };

/** The chat key row; the "⋯" cap after it opens the full key panel. */
export const CLAUDE_CHAT_KEYS: readonly BarKey[] = ["esc", "shiftTab", "ctrlC", "up", "down"];

/** Feed rows newest first. An assistant turn reads tools, then its text. */
export function chatFeed(view: ClaudeView): FeedItem[] {
  if (view.kind !== "claude") return [];
  const items: FeedItem[] = [];
  view.turns.forEach((turn, index) => {
    if (turn.role === "user") {
      if (turn.text.trim() !== "") items.push({ kind: "user", key: `${index}u`, text: turn.text });
      return;
    }
    turn.tools.forEach((tool, toolIndex) => {
      items.push({ kind: "tool", key: `${index}t${toolIndex}`, tool });
    });
    if (turn.text.trim() !== "") items.push({ kind: "text", key: `${index}a`, text: turn.text });
  });
  if (view.working !== undefined && view.working.trim() !== "") {
    items.push({ kind: "working", key: "working", text: view.working });
  }
  return items.reverse();
}

/** Header title (Claude's session title, else the pane key) and sub-line. */
export function chatHeader(
  view: Extract<ClaudeView, { kind: "claude" }>,
  paneKey: string,
  project: string | undefined,
): { title: string; subtitle: string } {
  const title = view.title?.trim();
  return {
    title: title === undefined || title === "" ? paneKey : title,
    // "Claude Code" is the product's name, kept as written in every language.
    subtitle: project === undefined || project === "" ? "Claude Code" : `${project} · Claude Code`,
  };
}

/** A link's visible text. Text that is not simply the address also shows
 *  the host, so a label cannot hide where the link goes. */
export function linkParts(text: string, url: string): { text: string; host?: string } {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return { text: url };
  }
  const bare = url.replace(/^https:\/\//, "").replace(/\/$/, "");
  if (text === url || text === bare || text === host) return { text: bare };
  return { text, host };
}

export function modeKey(mode: ClaudeMode | undefined): MessageKey {
  return `claude.mode.${mode ?? "default"}`;
}

export function toolText(tool: ChatTool): string {
  return tool.target === undefined || tool.target === ""
    ? tool.name
    : `${tool.name} ${tool.target}`;
}

/** A meter's fill, whole percent, 0..100. */
export function meterWidth(used: number): number {
  return Math.round(Math.max(0, Math.min(100, used)));
}

export function answerNoticeKey(result: ClaudeAnswerResult): MessageKey | undefined {
  if (result.ok) return undefined;
  return result.reason === "changed" ? "claude.answerChanged" : "claude.answerGone";
}
