// What the Chat view can do to a running agent besides typing to it: stop its
// turn (Esc), switch Claude's mode (Shift+Tab, read back from the screen) and
// send an allow-listed slash command. Each one re-reads the pane's screen
// after any await and right before it writes, refuses with a reason token
// whenever the screen is not exactly what the action assumes, and never
// logs anything but tokens.

import {
  inputLineHasDraft,
  readAgentInputState,
  readAgentMenu,
  readClaudeMode,
  stripAnsi,
} from "@jarvis/core";
import type { ClaudeMode } from "@jarvis/wire";
import { builtInNames } from "./agent-command-tables.js";
import { bracketedSubmit } from "./bracketed.js";
import type { PaneAgentSession } from "./pane-agent-session.js";

export type AgentControlDeps = {
  sessions: {
    session(paneKey: string, fresh?: boolean): Promise<PaneAgentSession | undefined>;
    live(paneKey: unknown): boolean;
  };
  screenText(paneKey: string): string | undefined;
  write(paneKey: string, data: string): void;
  sleep(ms: number): Promise<void>;
  log(token: string): void;
  /** Names of the custom commands and skills found for a session. */
  commandNames?(session: PaneAgentSession): Promise<ReadonlySet<string>>;
};

export type AgentStopResult =
  | { ok: true }
  | { ok: false; reason: "gone" | "prompt" | "idle" | "draft" | "unsupported" };

export type AgentModeResult =
  | { ok: true; mode: ClaudeMode }
  | {
      ok: false;
      reason: "gone" | "prompt" | "draft" | "unsupported" | "invalid" | "unreadable" | "stuck";
      mode?: ClaudeMode;
    };

export type AgentCommandResult =
  | { ok: true }
  | { ok: false; reason: "gone" | "prompt" | "busy" | "draft" | "invalid" | "unknown" };

/** Shift+Tab, the key Claude Code cycles its mode with. */
const SHIFT_TAB = "\x1b[Z";
const ESC = "\x1b";
const MAX_PRESSES = 5;
const MODES: readonly ClaudeMode[] = ["default", "acceptEdits", "plan", "auto"];
const SETTLE_MS = 1_500;
const POLL_MS = 100;

const COMMAND = /^\/([A-Za-z][A-Za-z0-9:._-]{0,60})(?: ([A-Za-z0-9._:@[\]/-]{1,64}))?$/;

type Reading = "menu" | "idle" | "busy" | "draft" | "other";

/** What the pane's input is doing, from the screen as it is right now. */
function reading(screen: string, vendor: PaneAgentSession["vendor"]): Reading {
  if (readAgentMenu(screen, vendor) !== undefined) return "menu";
  const state = readAgentInputState(screen, vendor);
  if (state === "approval-prompt") return "menu";
  if (inputLineHasDraft(screen, vendor)) return "draft";
  if (state === "idle-input") return "idle";
  if (state === "busy") return "busy";
  return "other";
}

export function createAgentControls(deps: AgentControlDeps): {
  stop(paneKey: unknown): Promise<AgentStopResult>;
  mode(paneKey: unknown, mode: unknown): Promise<AgentModeResult>;
  command(paneKey: unknown, command: unknown): Promise<AgentCommandResult>;
} {
  function log(token: string): void {
    try {
      deps.log(`agent-controls: ${token}`);
    } catch {
      // A failing logger cannot turn a refusal into a throw.
    }
  }

  /** The live agent in a pane, from a fresh scan (never a shell that took its place). */
  async function agentIn(paneKey: unknown): Promise<PaneAgentSession | undefined> {
    if (typeof paneKey !== "string" || !deps.sessions.live(paneKey)) return undefined;
    const session = await deps.sessions.session(paneKey, true);
    return session !== undefined && deps.sessions.live(paneKey) ? session : undefined;
  }

  const screenOf = (paneKey: string): string => deps.screenText(paneKey) ?? "";

  /** Waits until the screen differs from `before`; false when it never does. */
  async function changed(paneKey: string, before: string): Promise<boolean> {
    for (let waited = 0; waited <= SETTLE_MS; waited += POLL_MS) {
      if (stripAnsi(screenOf(paneKey)) !== stripAnsi(before)) return true;
      await deps.sleep(POLL_MS);
    }
    return false;
  }

  return {
    async stop(paneKey) {
      try {
        const session = await agentIn(paneKey);
        if (session === undefined || typeof paneKey !== "string")
          return { ok: false, reason: "gone" };
        if (session.vendor === "github") return { ok: false, reason: "unsupported" };
        // Read after the scan, written in the same tick: only a turn that is
        // running right now is interrupted, once.
        const seen = reading(screenOf(paneKey), session.vendor);
        if (seen === "menu") return { ok: false, reason: "prompt" };
        // A draft in the box hides whether a turn runs: say so, not "idle".
        if (seen === "draft") return { ok: false, reason: "draft" };
        if (seen !== "busy") return { ok: false, reason: "idle" };
        deps.write(paneKey, ESC);
        return { ok: true };
      } catch {
        log("stop");
        return { ok: false, reason: "gone" };
      }
    },

    async mode(paneKey, wanted) {
      if (typeof wanted !== "string" || !MODES.includes(wanted as ClaudeMode)) {
        return { ok: false, reason: "invalid" };
      }
      const target = wanted as ClaudeMode;
      try {
        const session = await agentIn(paneKey);
        if (session === undefined || typeof paneKey !== "string")
          return { ok: false, reason: "gone" };
        if (session.vendor !== "anthropic") return { ok: false, reason: "unsupported" };
        let presses = 0;
        for (;;) {
          const screen = screenOf(paneKey);
          const seen = reading(screen, session.vendor);
          if (seen === "menu") return { ok: false, reason: "prompt" };
          if (seen === "draft") return { ok: false, reason: "draft" };
          if (seen === "other") return { ok: false, reason: "unreadable" };
          const current = readClaudeMode(screen);
          if (current === undefined) return { ok: false, reason: "unreadable" };
          if (current === target) return { ok: true, mode: current };
          if (presses >= MAX_PRESSES) return { ok: false, reason: "stuck", mode: current };
          deps.write(paneKey, SHIFT_TAB);
          presses++;
          if (!(await changed(paneKey, screen))) {
            return { ok: false, reason: "stuck", mode: current };
          }
        }
      } catch {
        log("mode");
        return { ok: false, reason: "gone" };
      }
    },

    async command(paneKey, text) {
      if (typeof text !== "string") return { ok: false, reason: "invalid" };
      const match = COMMAND.exec(text);
      if (match === null) return { ok: false, reason: "invalid" };
      try {
        const session = await agentIn(paneKey);
        if (session === undefined || typeof paneKey !== "string")
          return { ok: false, reason: "gone" };
        const name = match[1] ?? "";
        const known =
          builtInNames(session.vendor).has(name) ||
          (deps.commandNames !== undefined && (await deps.commandNames(session)).has(name));
        if (!known) return { ok: false, reason: "unknown" };
        const seen = reading(screenOf(paneKey), session.vendor);
        if (seen === "menu") return { ok: false, reason: "prompt" };
        if (seen === "draft") return { ok: false, reason: "draft" };
        if (seen === "busy") return { ok: false, reason: "busy" };
        if (seen !== "idle") return { ok: false, reason: "gone" };
        deps.write(paneKey, bracketedSubmit(text));
        return { ok: true };
      } catch {
        log("command");
        return { ok: false, reason: "gone" };
      }
    },
  };
}
