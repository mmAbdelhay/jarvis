import { describe, expect, it } from "vitest";
import {
  buildStampCandidates,
  DEFAULT_MCP_DIR,
  mcpDirFrom,
  MODEL_STATE_PATH,
  osConfigPath,
  readOsBuildId,
} from "./os-paths.js";

describe("os paths", () => {
  it("uses /usr/lib/jarvis/mcp unless JARVIS_MCP_DIR overrides it", () => {
    expect(DEFAULT_MCP_DIR).toBe("/usr/lib/jarvis/mcp");
    expect(mcpDirFrom({})).toBe("/usr/lib/jarvis/mcp");
    expect(mcpDirFrom({ JARVIS_MCP_DIR: "" })).toBe("/usr/lib/jarvis/mcp");
    expect(mcpDirFrom({ JARVIS_MCP_DIR: "/tmp/mcp" })).toBe("/tmp/mcp");
  });
  it("puts jarvis.yaml under ~/.config/jarvis", () => {
    expect(osConfigPath("/home/jarvis")).toBe("/home/jarvis/.config/jarvis/jarvis.yaml");
  });
  it("looks for the build stamp beside the bundle, then in tsc's dist", () => {
    expect(buildStampCandidates("/usr/lib/jarvis/daemon")).toEqual([
      "/usr/lib/jarvis/daemon/build-stamp.json",
      "/usr/build-stamp.json",
    ]);
    expect(buildStampCandidates("/repo/packages/desktop/dist/src/daemon/os")[1]).toBe(
      "/repo/packages/desktop/dist/build-stamp.json",
    );
  });
  it('reads the bundle\'s {"build"} stamp the shell also reads (contracts §6 #6), else the tsc stamp, else "dev"', () => {
    expect(readOsBuildId("/x", () => '{"build":"0.1.4+abc.2026-10-07T10:00:00Z"}\n')).toBe(
      "0.1.4+abc.2026-10-07T10:00:00Z",
    );
    expect(readOsBuildId("/x", () => '{"version":"0.1.4","commit":"abc","builtAt":"T"}')).toBe(
      "0.1.4+abc.T",
    );
    expect(readOsBuildId("/x", () => '{"build":""}')).toBe("dev");
    expect(
      readOsBuildId("/x", () => {
        throw new Error("ENOENT");
      }),
    ).toBe("dev");
  });
});

describe("MODEL_STATE_PATH", () => {
  it("is the M2 contracts §5 path", () => {
    expect(MODEL_STATE_PATH).toBe("/var/lib/jarvis/model-state.json");
  });
});
