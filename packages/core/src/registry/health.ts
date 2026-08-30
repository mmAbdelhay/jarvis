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

// A slow-but-healthy agent on a loaded machine should not be misreported as
// broken, so the default is generous; callers (and tests) can override it.
export const DEFAULT_HEALTH_TIMEOUT_MS = 5000;

export async function checkAgent(
  agent: AgentConfig,
  run: CommandRunner,
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<AgentHealth> {
  let result: { code: number; stdout: string; stderr: string };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // agent.args carries mode flags for real invocations (e.g. copilot's
    // ["-p"] selects prompt mode), not a launcher prefix — probing with
    // those flags appended would run the wrong mode (`copilot -p --version`
    // is not a health check). The probe always asks for --version alone.
    //
    // An agent whose --version probe never answers is, for the purposes of
    // this report, broken — so the wait is bounded with a race against a
    // timeout rather than left open-ended. This only bounds the *wait*: if
    // the timeout wins, the child process spawned by `run` is left running
    // in the background (reaping it is the spawn layer's responsibility,
    // not this pure, Electron-free health check).
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`Health probe for "${agent.id}" timed out after ${timeoutMs}ms.`),
        );
      }, timeoutMs);
    });
    try {
      result = await Promise.race([run(agent.command, ["--version"]), timeout]);
    } finally {
      // Clear on every path (success or timeout-race loss) so a resolved
      // probe never leaves a dangling timer keeping the event loop — and
      // the test process — alive.
      clearTimeout(timer);
    }
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
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<AgentHealth[]> {
  // checkAgent never rejects (all failure paths, including a timeout, are
  // caught and folded into a `{ ok: false }` result), so one agent timing
  // out cannot fail Promise.all or affect any other agent's result.
  return Promise.all(agents.map((agent) => checkAgent(agent, run, timeoutMs)));
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}
