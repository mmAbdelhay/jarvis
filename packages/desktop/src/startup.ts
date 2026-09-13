import { capacityReportText, checkAll } from "@jarvis/core";
import type { AgentHealth, AgentRegistry, CommandRunner, ProviderStatus } from "@jarvis/core";

/**
 * What to run when an agent CLI is installed but its native binary is not.
 *
 * The path is the one thing here that is not portable: it is wherever npm
 * puts global packages, which is /opt/homebrew on a Homebrew Mac, /usr/lib or
 * ~/.npm-global on Linux, and whatever `npm config set prefix` was told
 * anywhere. Hard-coding Homebrew's sent every Linux user to a directory that
 * does not exist on their machine.
 *
 * `npm root -g` answers exactly this, so the hint tells them to ask it rather
 * than guessing on their behalf — one command either way, and this one is
 * right everywhere.
 */
const REPAIR_HINT = 'Repair with: node "$(npm root -g)/@anthropic-ai/claude-code/install.cjs"';

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

/**
 * The startup report's second half. Deliberately a SEPARATE message from
 * startupReport's health line rather than an extension of it: the health
 * probe runs `--version` (bounded at 5s, opens no session, learns nothing
 * about capacity), while a capacity reading is a real ~3.3s billed API query
 * per account. Folding them into one message would hold the health report —
 * the one the user relies on today — behind three paid round trips for a
 * number that is not urgent at launch. So health speaks first, and this
 * follows when the startup refresh settles.
 *
 * Returns "" when no account produced a reading, and the caller then sends
 * no turn at all rather than announcing that it knows nothing.
 */
export function capacityReport(statuses: readonly ProviderStatus[], language: "ar" | "en"): string {
  return capacityReportText(statuses, language);
}
