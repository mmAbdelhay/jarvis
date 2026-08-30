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
    // agent.args carries mode flags for real invocations (e.g. copilot's
    // ["-p"] selects prompt mode), not a launcher prefix — probing with
    // those flags appended would run the wrong mode (`copilot -p --version`
    // is not a health check). The probe always asks for --version alone.
    result = await run(agent.command, ["--version"]);
  } catch (error) {
    return {
      id: agent.id,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const broken = BROKEN_MARKERS.find((marker) => combined.includes(marker));
  if (broken !== undefined) {
    return { id: agent.id, ok: false, detail: firstLine(combined) };
  }

  if (result.code !== 0) {
    return { id: agent.id, ok: false, detail: firstLine(combined) || `exit ${result.code}` };
  }

  // Version text must land on stdout to count as healthy. Widening this to
  // the combined stream would let stderr noise (warnings, deprecation
  // notices) read as a version string and report a broken agent as
  // healthy — the worse failure direction than a false negative here.
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
