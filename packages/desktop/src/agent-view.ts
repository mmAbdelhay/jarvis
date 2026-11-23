// The desktop's Chat view of a Terminal pane running a coding agent — Claude
// Code, Copilot or Codex (terminal:agentView), its verified prompt answers
// (terminal:agentAnswer) and the composer's send (terminal:agentSend).
//
// The phone's claude-view.ts is the model and shares its caches and its
// "look again" notifier (pane-session-cache.ts); this handler is desktop-only
// and does not touch the phone's protocol. The view joins the session's
// transcript tail (turns, model) with what the pane's screen shows right now
// (a prompt, the spinner). Prompt keys never leave this file, and nothing
// here logs a path, a session name, or any transcript, screen or typed
// text — only category tokens.

import { readAgentInputState, readClaudeScreen, readPrompt, stripAnsi } from "@jarvis/core";
import {
  type ChatTurn,
  parseChatTranscript,
  parseCodexChat,
  parseCopilotChat,
} from "@jarvis/platform";
import type { ClaudeAnswerResult, ClaudeMode } from "@jarvis/wire";
import { basename, dirname } from "node:path";
import type { ClaudeViewDeps } from "./claude-view.js";
import { PANE_SESSION_TTL_MS, PANE_NONE_TTL_MS } from "./claude-view.js";
import { bracketedSubmit, sanitizeForPaste } from "./bracketed.js";
import type { PaneAgentLookup, PaneAgentSession } from "./pane-agent-session.js";
import { createChatCache, createPaneSessionCache } from "./pane-session-cache.js";

export type AgentVendor = PaneAgentSession["vendor"];

/** A pending prompt as the Chat view shows it: the options by label only. */
export type AgentPrompt = { question: string; options: { label: string }[] };

export type AgentView =
  | { kind: "none" }
  | {
      kind: "agent";
      vendor: AgentVendor;
      sessionId: string;
      title?: string;
      model?: string;
      mode?: ClaudeMode;
      turns: ChatTurn[];
      prompt?: AgentPrompt;
      /** The agent shows an approval menu readPrompt cannot read (Codex's
       *  numbered one): it can only be answered in the terminal. */
      needsTerm?: true;
      working?: string;
    };

export type AgentAnswerResult = ClaudeAnswerResult;

/** `gone`: no agent session (or no pane) to send to; `prompt`: the agent is
 *  at a menu, where an Enter would answer it; `invalid`: the text. */
export type AgentSendResult = { ok: true } | { ok: false; reason: "gone" | "prompt" | "invalid" };

/** The most text one send carries. */
export const AGENT_SEND_MAX_BYTES = 64 * 1024;

const NONE: AgentView = { kind: "none" };
/** The generic label for a vendor whose spinner text is not read. */
const WORKING_LABEL = "Working…";

export type AgentViewDeps = Omit<ClaudeViewDeps, "lookup"> & {
  lookup: Pick<PaneAgentLookup, "forProcess" | "retain">;
};

type Chat = { turns: ChatTurn[]; model?: string };

function parserFor(vendor: AgentVendor): (text: string) => Chat {
  if (vendor === "github") return (text) => parseCopilotChat(text);
  if (vendor === "openai") return (text) => parseCodexChat(text);
  return (text) => parseChatTranscript(text);
}

/** The screen's last 40 rows, the part every reader looks at. */
function screenTail(screen: string): string {
  return stripAnsi(screen).split("\n").slice(-40).join("\n");
}

export function createAgentViewHandlers(deps: AgentViewDeps): {
  view(paneKey: unknown): Promise<AgentView>;
  answer(paneKey: unknown, index: unknown, label: unknown): AgentAnswerResult;
  send(paneKey: unknown, text: unknown): Promise<AgentSendResult>;
  /** Drops a pane's cached session (its shell exited). */
  forgetPane(paneKey: string): void;
} {
  const cache = createPaneSessionCache<PaneAgentSession>({
    panes: () => deps.panes(),
    scanAgents: () => deps.scanAgents(),
    lookup: deps.lookup,
    now: () => deps.now(),
    ttlMs: PANE_SESSION_TTL_MS,
    noneTtlMs: PANE_NONE_TTL_MS,
  });
  const chats = createChatCache<Chat>(deps);

  function log(token: string): void {
    try {
      deps.log(`agent-view: ${token}`);
    } catch {
      // A failing logger cannot turn a refusal into a throw.
    }
  }

  function none(token: string): AgentView {
    log(token);
    return NONE;
  }

  return {
    forgetPane: (paneKey) => cache.forget(paneKey),

    async view(paneKey) {
      try {
        if (typeof paneKey !== "string") return NONE;
        const panes = deps.panes();
        const livePanes = new Set(panes.filter((pane) => !pane.exited).map((pane) => pane.paneKey));
        chats.retain(cache.prune(livePanes));
        if (!livePanes.has(paneKey)) return NONE;
      } catch {
        return none("panes");
      }
      let session: PaneAgentSession | undefined;
      try {
        session = await cache.sessionFor(paneKey);
      } catch (error) {
        return none(error instanceof Error && error.message === "scan" ? "scan" : "lookup");
      }
      if (session === undefined) return NONE;
      // Only now is a remote or window looking at an agent: a plain
      // `npm run dev` pane costs no output pushes and no transcript watch.
      try {
        deps.notice(paneKey);
      } catch {
        log("notice");
      }
      const transcriptPath = session.transcriptPath;
      if (transcriptPath !== undefined) {
        try {
          deps.follow(paneKey, { dir: dirname(transcriptPath), file: basename(transcriptPath) });
        } catch {
          log("follow");
        }
      }
      // The shell can exit while the scan or lookup awaits; see claude-view.ts.
      try {
        if (!cache.live(paneKey)) {
          deps.forget(paneKey);
          cache.forget(paneKey);
          return NONE;
        }
      } catch {
        return none("panes");
      }

      let chat: Chat = { turns: [] };
      if (transcriptPath !== undefined) {
        try {
          chat = await chats.get(session.sessionId, transcriptPath, parserFor(session.vendor));
        } catch {
          return none("transcript");
        }
      }
      try {
        const screen = deps.screenText(paneKey) ?? "";
        let mode: ClaudeMode | undefined;
        let prompt: ReturnType<typeof readPrompt>;
        let working: string | undefined;
        let needsTerm = false;
        if (session.vendor === "anthropic") {
          const read = readClaudeScreen(screen);
          ({ prompt, working } = read);
          mode = read.mode;
        } else {
          const tail = screenTail(screen);
          prompt = readPrompt(tail);
          if (readAgentInputState(tail, session.vendor) === "busy") working = WORKING_LABEL;
        }
        if (prompt === undefined) {
          needsTerm = readAgentInputState(screenTail(screen), session.vendor) === "approval-prompt";
        }
        return {
          kind: "agent",
          vendor: session.vendor,
          sessionId: session.sessionId,
          ...(session.name === undefined ? {} : { title: session.name }),
          ...(chat.model === undefined ? {} : { model: chat.model }),
          ...(mode === undefined ? {} : { mode }),
          turns: chat.turns,
          ...(prompt === undefined
            ? {}
            : {
                prompt: {
                  question: prompt.question,
                  options: prompt.options.map(({ label }) => ({ label })),
                },
              }),
          ...(needsTerm ? { needsTerm: true as const } : {}),
          ...(working === undefined ? {} : { working }),
        };
      } catch {
        return none("screen");
      }
    },

    // Read again at the moment of answering, never trusted from the call —
    // terminal:answer's rule. The renderer names the option by index and
    // label; both must match the screen now, and the keys typed are the ones
    // read now.
    answer(paneKey, index, label) {
      try {
        if (!cache.live(paneKey)) return { ok: false, reason: "gone" };
        const prompt = readPrompt(screenTail(deps.screenText(paneKey) ?? ""));
        if (prompt === undefined) return { ok: false, reason: "gone" };
        const option = Number.isInteger(index) ? prompt.options[index as number] : undefined;
        if (option === undefined || option.label !== label) {
          return { ok: false, reason: "changed" };
        }
        deps.write(paneKey, option.keys);
        return { ok: true };
      } catch {
        log("answer");
        return { ok: false, reason: "gone" };
      }
    },

    async send(paneKey, text) {
      if (
        typeof text !== "string" ||
        Buffer.byteLength(text) > AGENT_SEND_MAX_BYTES ||
        sanitizeForPaste(text).trim() === ""
      ) {
        return { ok: false, reason: "invalid" };
      }
      try {
        if (!cache.live(paneKey)) return { ok: false, reason: "gone" };
        // A fresh scan, never the cached one: an agent that exited a moment
        // ago leaves a shell here, and this text must not reach a shell.
        cache.forget(paneKey);
        const session = await cache.sessionFor(paneKey);
        if (session === undefined || !cache.live(paneKey)) return { ok: false, reason: "gone" };
        // The screen as it is now, after the scan: a trailing Enter must
        // never answer a menu the agent drew meanwhile.
        const tail = screenTail(deps.screenText(paneKey) ?? "");
        if (
          readPrompt(tail) !== undefined ||
          readAgentInputState(tail, session.vendor) === "approval-prompt"
        ) {
          return { ok: false, reason: "prompt" };
        }
        deps.write(paneKey, bracketedSubmit(text));
        return { ok: true };
      } catch {
        log("send");
        return { ok: false, reason: "gone" };
      }
    },
  };
}
