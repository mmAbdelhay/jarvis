import { randomUUID } from "node:crypto";
import type {
  ProcessHandle,
  Session,
  Spawner,
  StartInput,
} from "./types.js";

export class SessionManager {
  readonly #spawn: Spawner;
  readonly #sessions = new Map<string, Session>();
  readonly #processes = new Map<string, ProcessHandle>();
  readonly #listeners = new Set<(sessions: Session[]) => void>();

  constructor(spawn: Spawner) {
    this.#spawn = spawn;
  }

  start(input: StartInput): Session {
    const now = Date.now();
    const id = randomUUID();
    const session: Session = {
      id,
      project: input.project,
      projectPath: input.projectPath,
      agentId: input.agent.id,
      ...(input.agent.model === undefined ? {} : { model: input.agent.model }),
      state: "starting",
      summary: "",
      startedAt: now,
      lastActivityAt: now,
    };

    this.#sessions.set(id, session);

    const handle = this.#spawn(input.agent, input.projectPath);
    this.#processes.set(id, handle);
    handle.onOutput((chunk) => this.#onOutput(id, chunk));
    handle.onExit((code) => this.#onExit(id, code));

    this.#emit();
    return session;
  }

  send(id: string, text: string): void {
    const handle = this.#processes.get(id);
    if (handle === undefined) throw new Error(`No session ${id}`);
    handle.write(`${text}\n`);
  }

  kill(id: string): void {
    const handle = this.#processes.get(id);
    if (handle === undefined) throw new Error(`No session ${id}`);
    handle.kill();
    this.#update(id, { state: "dead" });
  }

  list(): Session[] {
    return [...this.#sessions.values()];
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  onChange(listener: (sessions: Session[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #onOutput(id: string, chunk: string): void {
    const summary = lastNonEmptyLine(chunk);
    this.#update(id, {
      state: "running",
      ...(summary === undefined ? {} : { summary }),
    });
  }

  #onExit(id: string, code: number): void {
    this.#update(id, { state: code === 0 ? "done" : "dead" });
  }

  #update(id: string, patch: Partial<Session>): void {
    const existing = this.#sessions.get(id);
    if (existing === undefined) return;
    if (existing.state === "dead" || existing.state === "done") return;
    this.#sessions.set(id, { ...existing, ...patch, lastActivityAt: Date.now() });
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.list();
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}

function lastNonEmptyLine(chunk: string): string | undefined {
  const lines = chunk.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1);
}
