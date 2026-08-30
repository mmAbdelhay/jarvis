import type { AgentConfig } from "../registry/types.js";

export type SessionState = "starting" | "running" | "waiting" | "done" | "dead";

export type Session = {
  id: string;
  project: string;
  projectPath: string;
  agentId: string;
  model?: string;
  state: SessionState;
  summary: string;
  startedAt: number;
  lastActivityAt: number;
};

export interface ProcessHandle {
  write(data: string): void;
  kill(): void;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number) => void): void;
}

export type Spawner = (agent: AgentConfig, projectPath: string) => ProcessHandle;

export type StartInput = {
  project: string;
  projectPath: string;
  agent: AgentConfig;
};
