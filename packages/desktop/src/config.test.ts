import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { defaultSessionsDbPath, loadConfig, parseConfig } from "./config.js";

const valid = {
  agents: { "claude-mm": { command: "claude-mm", model: "opus", default: true } },
  routing: [{ match: { project: "acme" }, agent: "claude-acme" }],
  projects: { acme: "~/projects/acme" },
  brain: { systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain" },
};

describe("parseConfig", () => {
  it("maps agents and routing into a registry config", () => {
    const config = parseConfig(valid);
    expect(config.registry.agents["claude-mm"]?.command).toBe("claude-mm");
    expect(config.registry.routing?.[0]?.agent).toBe("claude-acme");
  });

  it("expands a leading tilde in project paths", () => {
    const config = parseConfig(valid);
    expect(config.projects["acme"]?.startsWith("~")).toBe(false);
    expect(config.projects["acme"]).toContain("/projects/acme");
  });

  it("leaves absolute project paths untouched", () => {
    const config = parseConfig({ ...valid, projects: { a: "/tmp/a" } });
    expect(config.projects["a"]).toBe("/tmp/a");
  });

  it("throws when agents is missing", () => {
    expect(() => parseConfig({ projects: {}, brain: valid.brain })).toThrow(/agents/);
  });

  it("throws when brain is missing or not an object", () => {
    expect(() => parseConfig({ ...valid, brain: undefined })).toThrow(/brain/);
    expect(() => parseConfig({ ...valid, brain: "nope" })).toThrow(/brain/);
  });

  it("defaults routing to an empty list", () => {
    const config = parseConfig({ ...valid, routing: undefined });
    expect(config.registry.routing).toEqual([]);
  });

  it("throws when a routing entry is missing agent", () => {
    expect(() =>
      parseConfig({ ...valid, routing: [{ match: { project: "x" } }] }),
    ).toThrow(/routing\[0\]\.agent/);
  });

  it("throws when an agent entry is not an object", () => {
    expect(() => parseConfig({ ...valid, agents: { foo: "not-an-object" } })).toThrow(
      /agents\.foo/,
    );
  });

  it("throws when a projects value is not a string", () => {
    expect(() => parseConfig({ ...valid, projects: { acme: 123 } })).toThrow(
      /projects\.acme/,
    );
  });

  it("throws when agents is an array", () => {
    expect(() => parseConfig({ ...valid, agents: [] })).toThrow(/agents/);
  });

  it("defaults the whisper paths when the section is absent", () => {
    const config = parseConfig(valid);
    expect(config.whisper.binaryPath).toContain("whisper-cli");
    expect(config.whisper.binaryPath.startsWith("~")).toBe(false);
  });

  // Important 7: base corrupts the Arabic project name itself in testing
  // ("سعودي سيل" -> "سعودي ينسيل"), so the shipped default must be
  // large-v3-turbo, not base.
  it("defaults to the large-v3-turbo whisper model, expanded", () => {
    const config = parseConfig(valid);
    expect(config.whisper.modelPath).toContain("ggml-large-v3-turbo.bin");
    expect(config.whisper.modelPath.startsWith("~")).toBe(false);
  });

  it("uses explicit whisper paths and expands a leading tilde", () => {
    const config = parseConfig({
      ...valid,
      whisper: { binaryPath: "~/custom/whisper-cli", modelPath: "/models/ggml.bin" },
    });
    expect(config.whisper.binaryPath.startsWith("~")).toBe(false);
    expect(config.whisper.binaryPath).toContain("/custom/whisper-cli");
    expect(config.whisper.modelPath).toBe("/models/ggml.bin");
  });

  it("throws when whisper.binaryPath is not a string", () => {
    expect(() => parseConfig({ ...valid, whisper: { binaryPath: 123 } })).toThrow(
      /whisper\.binaryPath/,
    );
  });

  it("throws when whisper is not an object", () => {
    expect(() => parseConfig({ ...valid, whisper: "nope" })).toThrow(/whisper/);
  });

  // Critical 3: the shipped example config sets `brain.cwd: ~/.config/jarvis/brain`,
  // and `~/…` resolved against the SDK's own working-directory logic (not
  // the shell) is not a real path — every turn would fail.
  it("expands a leading tilde in brain.cwd", () => {
    const config = parseConfig({ ...valid, brain: { ...valid.brain, cwd: "~/.config/jarvis/brain" } });
    expect(config.brain.cwd.startsWith("~")).toBe(false);
    expect(config.brain.cwd).toContain("/.config/jarvis/brain");
  });

  it("expands a leading tilde in the default brain.cwd", () => {
    const config = parseConfig({ ...valid, brain: { systemPrompt: "You are Jarvis." } });
    expect(config.brain.cwd.startsWith("~")).toBe(false);
    expect(config.brain.cwd).toContain("/.config/jarvis/brain");
  });

  it("leaves an absolute brain.cwd untouched", () => {
    const config = parseConfig(valid);
    expect(config.brain.cwd).toBe("/tmp/jarvis-brain");
  });

  it("points sessionsDbPath at sessions.db beside the config directory", () => {
    const config = parseConfig(valid);
    expect(config.sessionsDbPath).toBe(join(homedir(), ".config/jarvis/sessions.db"));
    expect(config.sessionsDbPath).toBe(defaultSessionsDbPath());
  });
});

describe("loadConfig", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("creates the brain cwd directory if it does not already exist", async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-config-test-"));
    const brainCwd = join(dir, "brain-does-not-exist-yet");
    const configPath = join(dir, "jarvis.yaml");
    await writeFile(
      configPath,
      [
        "agents:",
        "  claude-mm:",
        "    command: claude-mm",
        "    default: true",
        "brain:",
        "  systemPrompt: You are Jarvis.",
        `  cwd: ${brainCwd}`,
      ].join("\n"),
    );

    const config = await loadConfig(configPath);

    expect(config.brain.cwd).toBe(brainCwd);
    const stats = await stat(brainCwd);
    expect(stats.isDirectory()).toBe(true);
  });
});
