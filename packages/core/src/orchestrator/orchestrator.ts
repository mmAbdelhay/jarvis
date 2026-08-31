import type { AgentConfig } from "../registry/types.js";
import type { AgentRegistry } from "../registry/registry.js";
import type { SessionManager } from "../session/manager.js";
import type { GitProvider } from "../git/types.js";
import type { SessionChanges } from "../git/tracker.js";
import {
  gitChangesText,
  gitCommitText,
  gitDiffOpenedText,
  gitFailureText,
} from "../git/messages.js";
import type { Brain, BrainContext, BrainReply, ToolSpec, Turn } from "./types.js";

const TOOLS = [
  {
    name: "session.start",
    description: "Start an agent session in a project",
    inputSchema: {
      project: "Name of the project to open, from the list of known projects",
      agent: "(optional) explicit agent id to use instead of routing",
    },
  },
  {
    name: "session.send",
    description: "Send text to a running session",
    inputSchema: {
      sessionId: "id of a running session, from the list of running sessions",
      text: "text to send to that session",
    },
  },
  {
    name: "session.kill",
    description: "Stop a running session",
    inputSchema: {
      sessionId: "id of a running session, from the list of running sessions",
    },
  },
  {
    name: "git.status",
    description: "Show what files a session has changed in its project, and on which branch",
    inputSchema: {
      sessionId: "id of a session, from the list of running sessions",
    },
  },
  {
    name: "git.diff",
    description: "Open the diff of one changed file in a session's project",
    inputSchema: {
      sessionId: "id of a session, from the list of running sessions",
      path: "path of the file relative to the project root, as shown in the changed-file list",
    },
  },
  {
    name: "git.commit",
    description:
      "Commit the files already staged in a session's project; if none are staged, stage and commit its tracked modified files (never untracked ones)",
    inputSchema: {
      sessionId: "id of a session, from the list of running sessions",
      message: "the commit message, in the language the user used",
    },
  },
] as const satisfies readonly ToolSpec[];

export type ToolName = (typeof TOOLS)[number]["name"];

export const TOOL_NAMES: readonly ToolName[] = TOOLS.map((tool) => tool.name);

type ToolContext = Partial<Pick<Turn, "sessionId" | "agentId" | "model" | "view" | "path">>;

type ToolResult = { context: ToolContext; error?: string };
type ToolHandler = (call: ToolCall, language: "ar" | "en") => Promise<ToolResult>;

type ToolCall = { name: string; input: Record<string, unknown> };

const MESSAGES = {
  unknownProject: (project: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `لا أعرف مشروعًا باسم "${project}".`
      : `I don't know a project called "${project}".`,
  agentResolveFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر العثور على الوكيل: ${message}`
      : `I couldn't find that agent: ${message}`,
  sessionStartFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر بدء الجلسة: ${message}`
      : `I couldn't start that session: ${message}`,
  unknownSession: (sessionId: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `لا أعرف جلسة باسم "${sessionId}".`
      : `I don't know a session called "${sessionId}".`,
  sendFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر إرسال الرسالة: ${message}`
      : `I couldn't send that message: ${message}`,
  killFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `تعذر إيقاف الجلسة: ${message}`
      : `I couldn't stop that session: ${message}`,
  unknownTool: (name: string, language: "ar" | "en"): string =>
    language === "ar"
      ? `لا أعرف كيف أفعل ذلك ("${name}").`
      : `I don't know how to do that ("${name}").`,
  brainFailed: (message: string, language: "ar" | "en"): string =>
    language === "ar" ? `حدث خطأ: ${message}` : `Something went wrong: ${message}`,
};

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type OrchestratorOptions = {
  brain: Brain;
  registry: AgentRegistry;
  sessions: SessionManager;
  git: GitProvider;
  changes: () => SessionChanges[];
  speak(text: string, language: "ar" | "en"): Promise<void>;
  projects: Record<string, string>;
};

export class Orchestrator {
  readonly #options: OrchestratorOptions;
  readonly #turns: Turn[] = [];
  readonly #listeners = new Set<(turn: Turn) => void>();

  constructor(options: OrchestratorOptions) {
    this.#options = options;
  }

  async handle(text: string, language: "ar" | "en"): Promise<Turn> {
    this.#record({ role: "user", text, language, at: Date.now() });

    let reply: BrainReply;
    try {
      reply = await this.#options.brain.ask({ text, tools: TOOLS, context: this.#context() });
    } catch (error) {
      const message = MESSAGES.brainFailed(errorMessage(error), language);
      return this.#answer(message, language, {});
    }

    let context: ToolContext = {};
    const notes: string[] = [];

    for (const call of reply.toolCalls ?? []) {
      const outcome = await this.#runTool(call, language);
      if (outcome.error !== undefined) notes.push(outcome.error);
      if (Object.keys(outcome.context).length > 0) context = outcome.context;
    }

    const note = notes.join(" ");
    const spoken = note === "" ? reply.text : `${reply.text} ${note}`.trim();
    return this.#answer(spoken, language, context);
  }

  transcript(): Turn[] {
    return [...this.#turns];
  }

  onTurn(listener: (turn: Turn) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Rebuilt on every turn (not cached): projects are static per config, but
  // sessions change as they start, finish, and die, so a stale snapshot
  // would let the brain reference a session id that's already gone.
  #context(): BrainContext {
    return {
      projects: Object.keys(this.#options.projects),
      sessions: this.#options.sessions.list().map((session) => ({
        id: session.id,
        project: session.project,
        agentId: session.agentId,
        state: session.state,
        summary: session.summary,
      })),
      // Read through the injected getter, not stored: the tracker refreshes
      // asynchronously and a cached copy here would go stale between turns —
      // the same reasoning the sessions list above already documents.
      changes: this.#options.changes(),
    };
  }

  // TOOLS and the dispatch table are tied together by `Record<ToolName, …>`:
  // declaring a tool with no handler, or a handler for a tool nobody
  // declared, is now a typecheck failure rather than a silent runtime
  // fall-through to unknownTool.
  #handlers(): Record<ToolName, ToolHandler> {
    return {
      "session.start": async (call, language) => this.#startSession(call, language),
      "session.send": async (call, language) => this.#sendToSession(call, language),
      "session.kill": async (call, language) => this.#killSession(call, language),
      "git.status": (call, language) => this.#gitStatus(call, language),
      "git.diff": (call, language) => this.#gitDiff(call, language),
      "git.commit": (call, language) => this.#gitCommit(call, language),
    };
  }

  #isToolName(name: string): name is ToolName {
    return TOOL_NAMES.some((known) => known === name);
  }

  async #runTool(call: ToolCall, language: "ar" | "en"): Promise<ToolResult> {
    if (!this.#isToolName(call.name)) {
      return { context: {}, error: MESSAGES.unknownTool(call.name, language) };
    }
    return this.#handlers()[call.name](call, language);
  }

  #startSession(call: ToolCall, language: "ar" | "en"): { context: ToolContext; error?: string } {
    const project = stringInput(call.input, "project");
    const projectPath = this.#options.projects[project];
    if (projectPath === undefined) {
      return { context: {}, error: MESSAGES.unknownProject(project, language) };
    }

    const explicit = call.input["agent"];
    let agent: AgentConfig;
    try {
      agent = this.#options.registry.resolve({
        project,
        ...(typeof explicit === "string" ? { explicitAgent: explicit } : {}),
      });
    } catch (error) {
      return { context: {}, error: MESSAGES.agentResolveFailed(errorMessage(error), language) };
    }

    let session: ReturnType<SessionManager["start"]>;
    try {
      session = this.#options.sessions.start({ project, projectPath, agent });
    } catch (error) {
      return { context: {}, error: MESSAGES.sessionStartFailed(errorMessage(error), language) };
    }

    return {
      context: {
        sessionId: session.id,
        agentId: agent.id,
        ...(agent.model === undefined ? {} : { model: agent.model }),
      },
    };
  }

  #sendToSession(call: ToolCall, language: "ar" | "en"): { context: ToolContext; error?: string } {
    const sessionId = stringInput(call.input, "sessionId");
    const text = stringInput(call.input, "text");
    try {
      this.#options.sessions.send(sessionId, text);
    } catch (error) {
      const message = this.#isUnknownSession(error, sessionId)
        ? MESSAGES.unknownSession(sessionId, language)
        : MESSAGES.sendFailed(errorMessage(error), language);
      return { context: {}, error: message };
    }
    return { context: { sessionId } };
  }

  #killSession(call: ToolCall, language: "ar" | "en"): { context: ToolContext; error?: string } {
    const sessionId = stringInput(call.input, "sessionId");
    try {
      this.#options.sessions.kill(sessionId);
    } catch (error) {
      const message = this.#isUnknownSession(error, sessionId)
        ? MESSAGES.unknownSession(sessionId, language)
        : MESSAGES.killFailed(errorMessage(error), language);
      return { context: {}, error: message };
    }
    return { context: { sessionId } };
  }

  #isUnknownSession(error: unknown, sessionId: string): boolean {
    return error instanceof Error && error.message === `No session ${sessionId}`;
  }

  // Resolving the repository from the session id (never from model-supplied
  // free text) is what stops a hallucinated path from reaching git.
  #repoFor(
    call: ToolCall,
    language: "ar" | "en",
  ): { sessionId: string; repoPath: string; project: string } | { error: string } {
    const sessionId = stringInput(call.input, "sessionId");
    const session = this.#options.sessions.get(sessionId);
    if (session === undefined) {
      return { error: MESSAGES.unknownSession(sessionId, language) };
    }
    return { sessionId, repoPath: session.projectPath, project: session.project };
  }

  async #gitStatus(call: ToolCall, language: "ar" | "en"): Promise<ToolResult> {
    const target = this.#repoFor(call, language);
    if ("error" in target) return { context: {}, error: target.error };

    const outcome = await this.#options.git.changes(target.repoPath);
    if (!outcome.ok) {
      return { context: {}, error: gitFailureText(outcome.error, language) };
    }
    return {
      context: { sessionId: target.sessionId, view: "changes" },
      error: gitChangesText(outcome.value, outcome.value.files.length, language),
    };
  }

  async #gitDiff(call: ToolCall, language: "ar" | "en"): Promise<ToolResult> {
    const target = this.#repoFor(call, language);
    if ("error" in target) return { context: {}, error: target.error };

    const path = stringInput(call.input, "path");
    const outcome = await this.#options.git.diff(target.repoPath, path);
    if (!outcome.ok) {
      return { context: {}, error: gitFailureText(outcome.error, language) };
    }
    // Pass the whole diff, not just the path: a binary or too-large diff is
    // `ok: true` with `hunks: []`, so the text must branch on those flags
    // rather than always claiming a diff was opened (ruling P12).
    return {
      context: { sessionId: target.sessionId, view: "changes", path },
      error: gitDiffOpenedText(outcome.value, language),
    };
  }

  async #gitCommit(call: ToolCall, language: "ar" | "en"): Promise<ToolResult> {
    const target = this.#repoFor(call, language);
    if ("error" in target) return { context: {}, error: target.error };

    const changes = await this.#options.git.changes(target.repoPath);
    if (!changes.ok) {
      return { context: {}, error: gitFailureText(changes.error, language) };
    }

    // Controller ruling P27 (reversing the earlier "stage every changed
    // file" reading): the click lane and the voice lane must agree on what
    // "commit" means. If the user already staged files by hand in the
    // Changes view, voice commits exactly those — never a wider set the
    // model happened to see in `git status`. Only when nothing is staged
    // does this fall back to tracked-modified files, so a plain "save my
    // work" with no manual staging still does something. Either way,
    // untracked files (`status === "?"`) are never auto-staged: a scratch
    // file or `.env.local` sitting untracked in the tree must never ride
    // along on a voice commit neither lane asked for.
    const alreadyStaged = changes.value.files.filter((file) => file.staged);
    const toStage = alreadyStaged.length > 0
      ? []
      : changes.value.files.filter((file) => file.status !== "?");

    if (toStage.length > 0) {
      const staged = await this.#options.git.stage(
        target.repoPath,
        toStage.map((file) => file.path),
      );
      if (!staged.ok) {
        return { context: {}, error: gitFailureText(staged.error, language) };
      }
    }

    const message = stringInput(call.input, "message");
    const outcome = await this.#options.git.commit(target.repoPath, message);
    if (!outcome.ok) {
      return { context: {}, error: gitFailureText(outcome.error, language) };
    }

    const included = new Set(
      (alreadyStaged.length > 0 ? alreadyStaged : toStage).map((file) => file.path),
    );
    const excludedUntracked = changes.value.files.filter(
      (file) => file.status === "?" && !included.has(file.path),
    ).length;

    return {
      context: { sessionId: target.sessionId, view: "changes" },
      error: gitCommitText(outcome.value, target.project, language, excludedUntracked),
    };
  }

  async #answer(text: string, language: "ar" | "en", context: ToolContext): Promise<Turn> {
    const turn: Turn = { role: "assistant", text, language, at: Date.now(), ...context };
    this.#record(turn);
    try {
      await this.#options.speak(text, language);
    } catch {
      // A TTS failure must not fail a turn the transcript already recorded as succeeded.
    }
    return turn;
  }

  #record(turn: Turn): void {
    this.#turns.push(turn);
    for (const listener of [...this.#listeners]) {
      try {
        listener(turn);
      } catch {
        // Isolate subscribers: one throwing listener must not starve the others
        // or abort the turn, the way SessionManager already isolates its listeners.
      }
    }
  }
}
