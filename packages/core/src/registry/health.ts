import type { AgentConfig } from "./types.js";

export type AgentHealth = { id: string; ok: boolean; detail: string };

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const BROKEN_MARKERS = [
  "native binary not installed",
  "command not found",
  "postinstall did not run",
];

export async function checkAgent(
  agent: AgentConfig,
  run: CommandRunner,
): Promise<AgentHealth> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await run(agent.command, ["--version"]);
  } catch (error) {
    return { id: agent.id, ok: false, detail: (error as Error).message };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const broken = BROKEN_MARKERS.find((marker) => combined.includes(marker));
  if (broken !== undefined) {
    return { id: agent.id, ok: false, detail: firstLine(combined) };
  }

  if (result.code !== 0) {
    return { id: agent.id, ok: false, detail: firstLine(combined) || `exit ${result.code}` };
  }

  const version = result.stdout.trim();
  if (version === "") {
    return { id: agent.id, ok: false, detail: "produced no output" };
  }

  return { id: agent.id, ok: true, detail: version };
}

export async function checkAll(
  agents: AgentConfig[],
  run: CommandRunner,
): Promise<AgentHealth[]> {
  return Promise.all(agents.map((agent) => checkAgent(agent, run)));
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}
