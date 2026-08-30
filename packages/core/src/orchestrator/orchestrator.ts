import type { AgentConfig } from "../registry/types.js";
import type { AgentRegistry } from "../registry/registry.js";
import type { SessionManager } from "../session/manager.js";
import type { Brain, BrainReply, ToolSpec, Turn } from "./types.js";

const TOOLS: ToolSpec[] = [
  { name: "session.start", description: "Start an agent session in a project" },
  { name: "session.send", description: "Send text to a running session" },
  { name: "session.kill", description: "Stop a running session" },
];

type ToolContext = Partial<Pick<Turn, "sessionId" | "agentId" | "model">>;

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
      reply = await this.#options.brain.ask({ text, tools: TOOLS });
    } catch (error) {
      const message = MESSAGES.brainFailed(errorMessage(error), language);
      return this.#answer(message, language, {});
    }

    let context: ToolContext = {};
    const notes: string[] = [];

    for (const call of reply.toolCalls ?? []) {
      const outcome = this.#runTool(call, language);
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

  #runTool(call: ToolCall, language: "ar" | "en"): { context: ToolContext; error?: string } {
    if (call.name === "session.start") return this.#startSession(call, language);
    if (call.name === "session.send") return this.#sendToSession(call, language);
    if (call.name === "session.kill") return this.#killSession(call, language);
    return { context: {}, error: MESSAGES.unknownTool(call.name, language) };
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
