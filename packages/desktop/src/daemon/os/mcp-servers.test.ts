import { fileURLToPath } from "node:url";
import { nodeMcpSpawn } from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";
import { connectOsMcpServers } from "./mcp-servers.js";

const FIXTURE = fileURLToPath(
  new URL("../../../../platform/src/mcp/__fixtures__/fake-mcp-server.mjs", import.meta.url),
);
const timers = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
};

describe("connectOsMcpServers", () => {
  it("starts the servers that can start and logs the ones that cannot", async () => {
    const lines: string[] = [];
    const sessions = await connectOsMcpServers({
      servers: ["jarvis-pkg", "jarvis-diag"],
      commandFor: (name) =>
        name === "jarvis-pkg"
          ? { command: process.execPath, args: [FIXTURE, name] }
          : { command: "/nonexistent/jarvis-diag", args: [] },
      spawn: nodeMcpSpawn(process.env, (line) => lines.push(line)),
      timers,
      clientVersion: "test",
      log: (line) => lines.push(line),
    });
    try {
      expect(sessions.map((s) => s.name)).toEqual(["jarvis-pkg"]);
      expect(lines.join("\n")).toContain("jarvis-diag did not start");
    } finally {
      for (const s of sessions) s.close();
    }
  });
});
