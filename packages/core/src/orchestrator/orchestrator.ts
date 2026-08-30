import type { AgentRegistry } from "../registry/registry.js";
import type { SessionManager } from "../session/manager.js";
import type { Brain, BrainReply, ToolSpec, Turn } from "./types.js";

const TOOLS: ToolSpec[] = [
  { name: "session.start", description: "Start an agent session in a project" },
  { name: "session.send", description: "Send text to a running session" },
  { name: "session.kill", description: "Stop a running session" },
];

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
      const message = error instanceof Error ? error.message : String(error);
      return this.#answer(message, language, {});
    }

    let context: Partial<Turn> = {};
    let note = "";

    for (const call of reply.toolCalls) {
      const outcome = this.#runTool(call);
      if (outcome.error !== undefined) note = outcome.error;
      context = { ...context, ...outcome.context };
    }

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

  #runTool(call: { name: string; input: Record<string, unknown> }): {
    context: Partial<Turn>;
    error?: string;
  } {
    if (call.name !== "session.start") return { context: {} };

    const project = String(call.input["project"] ?? "");
    const projectPath = this.#options.projects[project];
    if (projectPath === undefined) {
      return { context: {}, error: `I don't know a project called "${project}".` };
    }

    const explicit = call.input["agent"];
    let agent;
    try {
      agent = this.#options.registry.resolve({
        project,
        ...(typeof explicit === "string" ? { explicitAgent: explicit } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { context: {}, error: message };
    }

    const session = this.#options.sessions.start({ project, projectPath, agent });
    return {
      context: {
        sessionId: session.id,
        agentId: agent.id,
        ...(agent.model === undefined ? {} : { model: agent.model }),
      },
    };
  }

  async #answer(text: string, language: "ar" | "en", context: Partial<Turn>): Promise<Turn> {
    const turn: Turn = { role: "assistant", text, language, at: Date.now(), ...context };
    this.#record(turn);
    await this.#options.speak(text, language);
    return turn;
  }

  #record(turn: Turn): void {
    this.#turns.push(turn);
    for (const listener of this.#listeners) listener(turn);
  }
}
