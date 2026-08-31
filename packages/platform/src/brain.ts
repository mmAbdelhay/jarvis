import { query as sdkQuery, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Brain, BrainContext, BrainReply, CapacityReading, ToolSpec } from "@jarvis/core";
import { parseUsage } from "./capacity.js";

const TOOL_BLOCK = /```jarvis-tool\s*\n([\s\S]*?)\n```/g;

/**
 * The subset of an Agent SDK message this adapter reads. Deliberately
 * narrower than the SDK's real `SDKMessage` union (which carries dozens of
 * event types we never look at) so tests can build fixtures without wiring
 * up every required field of the real types. The real SDK's `query()`
 * yields messages that satisfy this shape structurally, so it needs no cast
 * to fit here.
 */
export type BrainSdkMessage =
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "assistant"; message: { content: readonly { type: string; text?: string }[] } }
  | { type: string };

export type SdkQueryResult = AsyncIterable<BrainSdkMessage> & {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
};

export type SdkQueryFn = (params: { prompt: string; options?: Options }) => SdkQueryResult;

export type BrainConfig = {
  systemPrompt: string;
  /**
   * Working directory the SDK session runs in. This must be a directory
   * with no `.claude` project config of its own: a headless SDK session
   * inherits whatever hooks and skills live under its cwd (confirmed by
   * the Task 1 spike, which picked up an unrelated SessionStart hook and
   * skill injection purely from running under this repo's directory), and
   * those would otherwise pollute every orchestrator turn.
   */
  cwd: string;
  /** Injected for tests; defaults to the real Agent SDK `query`. */
  query?: SdkQueryFn;
  /**
   * Which configured account the brain's own SDK session runs under. Set it
   * and two things follow: the brain's spend is attributable, and its usage
   * reading — taken mid-stream off a round trip already paid for — can be
   * credited to that account for free. Leave it unset and the brain behaves
   * exactly as before, with no capacity attribution at all: guessing which
   * account paid would put a number on the wrong row.
   */
  accountId?: string;
  /** That account's CLAUDE_CONFIG_DIR, resolved from the registry by config.ts. */
  configDir?: string;
  /**
   * Called exactly once per turn, only when accountId is set. If this
   * throws, the throw is swallowed here — it can never escape into the
   * turn, and is never retried (a retry would double-attribute).
   */
  onUsage?: (agentId: string, reading: CapacityReading) => void;
};

export function parseCliReply(stdout: string): BrainReply {
  const toolCalls: BrainReply["toolCalls"] = [];

  const text = stdout
    .replace(TOOL_BLOCK, (_match, body: string) => {
      try {
        const parsed = JSON.parse(body) as { name?: unknown; input?: unknown };
        if (typeof parsed.name === "string") {
          toolCalls.push({
            name: parsed.name,
            input: (parsed.input ?? {}) as Record<string, unknown>,
          });
        }
      } catch {
        // A malformed block is dropped: the user still gets the prose reply.
      }
      return "";
    })
    .trim();

  return { text, toolCalls };
}

function defaultQuery(params: { prompt: string; options?: Options }): SdkQueryResult {
  return sdkQuery(params);
}

function describeTool(tool: ToolSpec): string {
  const fields = Object.entries(tool.inputSchema).map(([key, description]) => `${key} (${description})`);
  const schema = fields.length === 0 ? "" : ` — input: ${fields.join(", ")}`;
  return `- ${tool.name}: ${tool.description}${schema}`;
}

function buildPrompt(
  systemPrompt: string,
  text: string,
  tools: readonly ToolSpec[],
  context: BrainContext,
): string {
  const projectsLine =
    context.projects.length === 0
      ? "(no projects configured)"
      : context.projects.join(", ");

  const sessionsLine =
    context.sessions.length === 0
      ? "(no sessions running)"
      : context.sessions
          .map((session) => {
            const summary = session.summary === "" ? "" : ` "${session.summary}"`;
            return `${session.id} — project ${session.project}, agent ${session.agentId}, state ${session.state}${summary}`;
          })
          .join("; ");

  const changesLine =
    context.changes.length === 0
      ? "(none)"
      : context.changes
          .map(
            (entry) =>
              `${entry.sessionId} — project ${entry.project}, branch ${entry.branch}, ${entry.files} files, +${entry.insertions} -${entry.deletions}`,
          )
          .join("; ");

  return [
    systemPrompt,
    "",
    "Available tools. To call one, emit a fenced block:",
    "```jarvis-tool",
    '{ "name": "<tool>", "input": { ... } }',
    "```",
    ...tools.map(describeTool),
    "",
    // These two lines are what let the model resolve "project" and
    // "sessionId" inputs to real values instead of guessing them — see
    // the Critical 1/2 seam this closes.
    `Known projects: ${projectsLine}`,
    `Running sessions: ${sessionsLine}`,
    `Uncommitted changes: ${changesLine}`,
    "",
    `User: ${text}`,
  ].join("\n");
}

/**
 * Builds a Brain backed by the Agent SDK, authenticated against the user's
 * existing Claude subscription (no API key needed — see the Task 1 spike).
 *
 * Conversation memory is this adapter's responsibility, not the
 * orchestrator's: `orchestrator` passes only the current utterance to
 * `ask()`, deliberately omitting history, because the SDK maintains
 * session state natively. This function holds the one long-lived SDK
 * session across every `ask()` call by capturing the session id from the
 * first turn's `init` message and resuming that same session on every
 * later turn, so a follow-up like "ok kill it" still has the context of
 * what "it" refers to.
 */
export function createBrain(config: BrainConfig): Brain {
  const query = config.query ?? defaultQuery;
  let sessionId: string | undefined;

  return {
    async ask({
      text,
      tools,
      context,
    }: {
      text: string;
      tools: readonly ToolSpec[];
      context: BrainContext;
    }): Promise<BrainReply> {
      const prompt = buildPrompt(config.systemPrompt, text, tools, context);

      // Deleting rather than leaving it set-or-unset keeps the child's env
      // identical regardless of whether this process happens to have the
      // key set: an inherited ANTHROPIC_API_KEY would make the SDK
      // subprocess authenticate by key instead of the target account's
      // subscription, so every account would silently report
      // rate_limits_available: false forever, with nothing to explain why
      // (mirrors capacity.ts's identical guard, for the same reason, for the
      // whole turn rather than just a capacity read).
      const env = { ...process.env };
      delete env["ANTHROPIC_API_KEY"];

      const options: Options = {
        cwd: config.cwd,
        // SDK isolation mode: no project/user/local settings, hooks, or
        // skills leak into the orchestrator's own conversation.
        settingSources: [],
        // No built-in tools (Bash, Read, Write, ...): the model may only
        // *describe* jarvis tool calls as fenced text, never execute
        // anything itself. The orchestrator dispatches the real calls.
        tools: [],
        ...(sessionId === undefined ? {} : { resume: sessionId }),
        ...(config.configDir === undefined
          ? {}
          : { env: { ...env, CLAUDE_CONFIG_DIR: config.configDir } }),
      };

      let replyText = "";
      let usageRead = false;
      const stream = query({ prompt, options });
      const readUsage = async (): Promise<void> => {
        const { accountId, onUsage } = config;
        if (accountId === undefined || onUsage === undefined) return;
        const read = stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if (read === undefined) return;
        let reading: CapacityReading;
        try {
          reading = parseUsage(await read.call(stream));
        } catch {
          // The assistant's answer is the product. An experimental API that
          // is explicitly named DO_NOT_RELY_ON_THIS_API_YET must never be
          // able to break a turn.
          reading = { ok: false, reason: "unavailable" };
        }
        try {
          // onUsage is called exactly once, here, whatever the reading
          // turned out to be. A second attempt on a throwing callback would
          // double-attribute the same turn to the same account; letting the
          // throw propagate would take the whole turn down for a side
          // effect. Neither is acceptable, so it is swallowed instead.
          onUsage(accountId, reading);
        } catch {
          // No error binding: nothing here can stringify a caller-supplied
          // payload into a message.
        }
      };

      for await (const message of stream) {
        if (message.type === "system" && "subtype" in message && message.subtype === "init") {
          sessionId = message.session_id;
        }
        if (message.type === "assistant" && "message" in message) {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text !== undefined) {
              replyText += block.text;
            }
          }
        }
        if (message.type === "assistant" && !usageRead) {
          usageRead = true;
          // Free: this round trip is already paid for by the turn itself.
          // Mid-stream is the only moment it works — after the result
          // message the query is closed (controller verification, note 2).
          await readUsage();
        }
      }

      return parseCliReply(replyText);
    },
  };
}
