// The one capacity reader ProviderMonitor is handed: picks a free source by
// vendor. Each source is its own module with its own parser and tests —
//   anthropic  capacity-snapshot.ts   the status-line snapshot in the account's config dir
//   openai     capacity-codex.ts      Codex's own session logs
//   github     capacity-copilot.ts    GitHub's quota endpoint through the signed-in `gh`
// — and none of them spends a model query. A vendor with no source, or a
// Claude account without a config dir (ProviderMonitor never asks for one,
// but the contract is "unavailable, never a throw"), reads as unavailable.

import type { CapacityReading, CapacityTarget } from "@jarvis/core";
import { createCodexCapacityReader } from "./capacity-codex.js";
import { createCopilotCapacityReader } from "./capacity-copilot.js";
import { createSnapshotCapacityReader } from "./capacity-snapshot.js";
import type { CommandRunner } from "./docker.js";

export type CapacityReaderDeps = {
  /** Runs `gh`/`security` (the Copilot source) with the login-shell PATH; see main.ts's agentEnv. */
  run: CommandRunner;
  /** process.platform, passed from the impure edge (platform-convention rule). */
  platform?: string;
  /** Injected for tests; each defaults to its module's real reader. */
  readSnapshot?: (configDir: string) => Promise<CapacityReading>;
  readCodex?: () => Promise<CapacityReading>;
  readCopilot?: () => Promise<CapacityReading>;
};

export function createCapacityReader(
  deps: CapacityReaderDeps,
): (target: CapacityTarget) => Promise<CapacityReading> {
  const readSnapshot = deps.readSnapshot ?? createSnapshotCapacityReader();
  const readCodex = deps.readCodex ?? createCodexCapacityReader();
  const readCopilot =
    deps.readCopilot ?? createCopilotCapacityReader({ run: deps.run, platform: deps.platform });
  return async (target: CapacityTarget): Promise<CapacityReading> => {
    switch (target.vendor) {
      case "anthropic":
        return target.configDir === undefined
          ? { ok: false, reason: "unavailable" }
          : readSnapshot(target.configDir);
      case "openai":
        return readCodex();
      case "github":
        return readCopilot();
      default:
        return { ok: false, reason: "unavailable" };
    }
  };
}
