import { checkAll } from "@jarvis/core";
import type { AgentHealth, AgentRegistry, CommandRunner } from "@jarvis/core";

const REPAIR_HINT =
  "Repair with: node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/install.cjs";

export async function startupReport(
  registry: AgentRegistry,
  run: CommandRunner,
): Promise<{ healthy: AgentHealth[]; broken: AgentHealth[]; message: string }> {
  const results = await checkAll(registry.list(), run);
  const healthy = results.filter((result) => result.ok);
  const broken = results.filter((result) => !result.ok);

  if (broken.length === 0) {
    return { healthy, broken, message: `${healthy.length} agents ready.` };
  }

  const names = broken.map((agent) => agent.id).join(", ");
  const stub = broken.some((agent) => agent.detail.includes("native binary not installed"));
  const hint = stub ? ` ${REPAIR_HINT}` : "";

  if (healthy.length === 0) {
    return { healthy, broken, message: `No agents are working: ${names}.${hint}` };
  }

  return { healthy, broken, message: `${healthy.length} agents ready. Broken: ${names}.${hint}` };
}
