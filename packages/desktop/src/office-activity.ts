// What each agent in the Office is doing right now, read in the main process
// (the watcher below) and drawn by renderer/office-model.ts and
// office-view.ts. Nothing here is ever logged but category tokens.

/** One pane's or session's state. "question" also covers an approval menu
 *  that cannot be read (no question text then). "unknown": the read failed. */
export type OfficeState = "question" | "busy" | "idle" | "unknown";

export type OfficeEntry = {
  /** The agent's own name: "Claude Code", "Copilot" or "Codex". */
  agent?: string;
  state: OfficeState;
  /** At most 200 characters, control characters stripped. Never in a
   *  notification. */
  question?: string;
  doing?: string;
  model?: string;
};

export type OfficeActivity = {
  panes: Record<string, OfficeEntry>;
  sessions: Record<string, OfficeEntry>;
};

export const EMPTY_OFFICE_ACTIVITY: OfficeActivity = { panes: {}, sessions: {} };
