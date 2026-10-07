// Starts jarvis-pkg and jarvis-diag (contracts §1) as children of jarvisd,
// each on its own: one missing or broken server leaves the other usable, and
// the tool registry simply has fewer tools.
//
// No electron here (core/no-electron.test.ts).
import type { McpSession } from "@jarvis/core";
import { connectMcpServer, type McpSpawn, type McpTimers } from "@jarvis/platform/model";

export async function connectOsMcpServers(options: {
  servers: readonly string[];
  commandFor(name: string): { command: string; args: string[] };
  spawn: McpSpawn;
  timers: McpTimers;
  clientVersion: string;
  log(line: string): void;
}): Promise<McpSession[]> {
  const settled = await Promise.allSettled(
    options.servers.map((name) => {
      const { command, args } = options.commandFor(name);
      return connectMcpServer({
        name,
        command,
        args,
        spawn: options.spawn,
        timers: options.timers,
        clientVersion: options.clientVersion,
        log: options.log,
      });
    }),
  );
  return settled.flatMap((result, i) => {
    if (result.status === "fulfilled") return [result.value];
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    options.log(`[mcp] ${options.servers[i]} did not start: ${reason}`);
    return [];
  });
}
