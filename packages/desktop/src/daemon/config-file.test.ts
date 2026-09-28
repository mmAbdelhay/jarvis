import { describe, expect, it } from "vitest";
import { readDaemonEnabled, writeDaemonEnabled, type ConfigFileIo } from "./config-file.js";

function memoryIo(files: Record<string, string>): ConfigFileIo & { files: Record<string, string> } {
  return {
    files,
    async readFile(path) {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    async writeFile(path, text) {
      files[path] = text;
    },
  };
}

const BASE = `# mine
agents:
  claude:
    command: claude # keep this comment
brain:
  cwd: /tmp/brain
`;

describe("daemon.enabled in jarvis.yaml", () => {
  it("reads off for a missing file, an unparseable one, an absent section and a bad value", async () => {
    expect(await readDaemonEnabled("/none", memoryIo({}))).toBe(false);
    expect(await readDaemonEnabled("/c", memoryIo({ "/c": "agents: [" }))).toBe(false);
    expect(await readDaemonEnabled("/c", memoryIo({ "/c": BASE }))).toBe(false);
    expect(
      await readDaemonEnabled("/c", memoryIo({ "/c": `${BASE}daemon:\n  enabled: "yes"\n` })),
    ).toBe(false);
  });

  it("reads on", async () => {
    expect(
      await readDaemonEnabled("/c", memoryIo({ "/c": `${BASE}daemon:\n  enabled: true\n` })),
    ).toBe(true);
  });

  it("turns it on and off in place, keeping the user's comments", async () => {
    const io = memoryIo({ "/c": BASE });
    await writeDaemonEnabled("/c", true, io);
    expect(io.files["/c"]).toContain("# keep this comment");
    expect(io.files["/c"]).toContain("daemon:\n  enabled: true");
    expect(await readDaemonEnabled("/c", io)).toBe(true);

    await writeDaemonEnabled("/c", false, io);
    expect(io.files["/c"]).not.toContain("daemon");
    expect(io.files["/c"]).toContain("# keep this comment");
    expect(await readDaemonEnabled("/c", io)).toBe(false);
  });

  it("refuses to write a file Jarvis would not load, and leaves it untouched", async () => {
    const broken = "agents:\n  claude: {}\nbrain:\n  cwd: /tmp/b\n";
    const io = memoryIo({ "/c": broken });
    await expect(writeDaemonEnabled("/c", true, io)).rejects.toThrow("agents.claude.command");
    expect(io.files["/c"]).toBe(broken);

    const io2 = memoryIo({ "/c": "agents: [" });
    await expect(writeDaemonEnabled("/c", true, io2)).rejects.toThrow("does not parse");
  });
});
