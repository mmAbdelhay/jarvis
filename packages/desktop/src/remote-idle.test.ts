import { describe, expect, it, vi } from "vitest";
import type { JarvisConfig } from "./config.js";
import { disableRemoteOnDisk } from "./remote-idle.js";
import type { SettingsWriteResult } from "./settings-io.js";

// A full, non-default config — every `remote:` sub-key hand-set away from
// DEFAULT_REMOTE — so a draft built from a fresh DEFAULT_REMOTE instead of
// copying the read config is caught: `bindAddress` below is not the
// default, and every bite-proof in this file trades on that.
const CONFIG: JarvisConfig = {
  registry: {
    agents: { "claude-main": { command: "claude-main", model: "opus", default: true } },
    routing: [{ match: { project: "acme" }, agent: "claude-main" }],
  },
  projects: { acme: "/Users/x/projects/acme" },
  databases: { acme: [{ id: "db1", engine: "mysql" }] },
  editors: { acme: [{ name: "web", path: "packages/web" }] },
  clusters: { acme: [{ name: "dev", context: "ctx-a" }] },
  docker: { acme: [{ name: "api", container: "api-1" }] },
  chat: { acme: [{ name: "Team", driver: "slack" as const }] },
  workflows: { acme: "/Users/x/projects/acme/.jarvis/workflows" },
  headlamp: { binary: "/some/path" },
  prayer: { enabled: false },
  terminal: {
    completion: { enabled: true, historyPath: "/h", commandLogPath: "/l" },
    blocks: { enabled: true, inputEditor: true },
    notifyAfterSeconds: 30,
  },
  voice: {
    engine: "say" as const,
    piperBinary: "/opt/piper",
    piperModel: "/voices/alan.onnx",
    piperArabicModel: "/voices/ar.onnx",
    englishVoice: "Daniel",
    speakGreeting: true,
    arabicVoice: "Majed",
    greeting: { en: "Good {timeOfDay} sir, how can I help you today?", ar: "{timeOfDay} يا سيدي" },
  },
  brain: { systemPrompt: "You are Jarvis.", cwd: "/Users/x/.config/jarvis/brain" },
  whisper: { binaryPath: "/opt/whisper/bin/whisper-cli", modelPath: "/opt/whisper/model.bin" },
  performance: {
    suspendTabsAfterMinutes: 0,
    stopSidecarsAfterMinutes: 45,
    terminalScrollback: 20000,
  },
  browser: { allowPopups: false },
  sessions: { importWindowDays: 90 },
  remote: {
    enabled: true,
    bindAddress: "100.84.17.203",
    port: 4200,
    sidecarProxy: true,
    tls: { certPath: "/certs/m.crt", keyPath: "/certs/m.key" },
    push: { enabled: true, includeProjectNames: true },
    idleDisableMinutes: 30,
  },
  sessionsDbPath: "/Users/x/.config/jarvis/sessions.db",
};

type Updater = (current: JarvisConfig) => JarvisConfig;

/**
 * A fake of main.ts's own composed `writeConfig`: reads `onDisk()` (its
 * stand-in for the serialized re-read `loadConfig` does inside the real
 * queue), hands the result to `update`, and — the real implementation's own
 * short-circuit — skips straight to `{ ok: true }` without ever "writing"
 * when `update` hands back the exact object it was given. Every draft
 * `update` actually produces is captured in `drafts`, so a test can assert
 * on it the same way it used to assert on the plain-draft mock's own call
 * arguments.
 */
function fakeWriteConfig(
  onDisk: () => Promise<JarvisConfig>,
  drafts: JarvisConfig[],
  outcome: () => Promise<SettingsWriteResult> = async () => ({ ok: true }),
) {
  return vi.fn(async (update: Updater): Promise<SettingsWriteResult> => {
    const current = await onDisk();
    const draft = update(current);
    if (draft === current) return { ok: true };
    drafts.push(draft);
    return outcome();
  });
}

describe("disableRemoteOnDisk", () => {
  it("writes back the read config with only remote.enabled flipped, and nothing else changed", async () => {
    const drafts: JarvisConfig[] = [];
    const writeConfig = fakeWriteConfig(async () => CONFIG, drafts);
    const log = vi.fn();

    const ok = await disableRemoteOnDisk({ writeConfig, log });

    expect(ok).toBe(true);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    const draft = drafts[0];
    expect(draft).toEqual({ ...CONFIG, remote: { ...CONFIG.remote, enabled: false } });
    // Named individually per the brief: every one of these must have
    // round-tripped byte-for-byte, not just the aggregate toEqual above.
    expect(draft?.remote.tls).toEqual(CONFIG.remote.tls);
    expect(draft?.remote.push).toEqual(CONFIG.remote.push);
    expect(draft?.remote.idleDisableMinutes).toBe(CONFIG.remote.idleDisableMinutes);
    expect(draft?.remote.bindAddress).toBe(CONFIG.remote.bindAddress);
    expect(draft?.projects).toEqual(CONFIG.projects);
    expect(draft?.registry.agents).toEqual(CONFIG.registry.agents);
    expect(log).toHaveBeenCalledWith("remote: idle auto-disable saved to jarvis.yaml");
  });

  // [bite-proof: build a fresh DEFAULT_REMOTE instead of copying the read
  // config — the hand-set bindAddress ("100.84.17.203") is lost, replaced
  // by DEFAULT_REMOTE's "127.0.0.1".]
  it("bite-proof: a draft built from a fresh default would lose the hand-set bindAddress", async () => {
    const drafts: JarvisConfig[] = [];
    const writeConfig = fakeWriteConfig(async () => CONFIG, drafts);
    await disableRemoteOnDisk({ writeConfig, log: vi.fn() });
    expect(drafts[0]?.remote.bindAddress).not.toBe("127.0.0.1");
  });

  // M12 Task 12 minor: the read now happens *inside* deps.writeConfig
  // (main.ts's own serialized queue), so "already off" can only be known
  // once `update` runs — `update` answers it by returning the exact
  // `current` object it was handed, which is what tells the real
  // writeConfig there is nothing to write.
  //
  // [bite-proof: drop the `if (!wasEnabled) return current;` early return
  // in disableRemoteOnDisk's own updater — every call then spreads a
  // *new* object even when already off, so `drafts` below is no longer
  // empty and this test fails, even though the "already off" log line
  // (driven by `wasEnabled` alone, not by what `update` returns) still
  // fires either way — proving the log message alone would not have
  // caught this regression, only the no-write assertion does.]
  it("already off on disk: update is a no-op (returns the same object), returns true, and logs it", async () => {
    const drafts: JarvisConfig[] = [];
    const alreadyOff: JarvisConfig = { ...CONFIG, remote: { ...CONFIG.remote, enabled: false } };
    const writeConfig = fakeWriteConfig(async () => alreadyOff, drafts);
    const log = vi.fn();

    const ok = await disableRemoteOnDisk({ writeConfig, log });

    expect(ok).toBe(true);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    // No draft was ever captured — update() returned `current` itself, so
    // the real writeConfig never reaches the point that would push one.
    expect(drafts).toEqual([]);
    expect(log).toHaveBeenCalledWith("remote: idle auto-disable — already off on disk");
  });

  it("a rejected read inside writeConfig returns false and logs it by name, producing no draft", async () => {
    const drafts: JarvisConfig[] = [];
    const writeConfig = fakeWriteConfig(async () => {
      throw new Error("ENOENT: no such file");
    }, drafts);
    const log = vi.fn();

    const ok = await disableRemoteOnDisk({ writeConfig, log });

    expect(ok).toBe(false);
    expect(drafts).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("remote: idle auto-disable could not save:"),
    );
  });

  it("writeConfig answering {ok:false} returns false and logs the detail", async () => {
    const drafts: JarvisConfig[] = [];
    const writeConfig = fakeWriteConfig(
      async () => CONFIG,
      drafts,
      async () => ({
        ok: false,
        detail: "validation failed",
      }),
    );
    const log = vi.fn();

    const ok = await disableRemoteOnDisk({ writeConfig, log });

    expect(ok).toBe(false);
    expect(log).toHaveBeenCalledWith("remote: idle auto-disable could not save: validation failed");
  });

  // [bite-proof: remove the try/catch around deps.writeConfig — a thrown
  // rejection would propagate instead of resolving to false, and
  // `.resolves` below would fail.]
  it("a throwing writeConfig never propagates: resolves to false instead", async () => {
    const writeConfig = vi.fn(async (): Promise<SettingsWriteResult> => {
      throw new Error("disk full");
    });
    const log = vi.fn();

    await expect(disableRemoteOnDisk({ writeConfig, log })).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("remote: idle auto-disable could not save:"),
    );
  });
});
