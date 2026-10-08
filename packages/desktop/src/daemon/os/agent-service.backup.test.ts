import { USER_TEXT } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { DONE, fakeSession, scripted, startAgent, tool } from "./__fixtures__/os-agent-harness.js";

const BACKUP = "ollama http://127.0.0.1:11434 qwen3:1.7b";
const YAML = `os:
  providers:
    - { id: local, kind: ollama, baseUrl: http://127.0.0.1:11434, model: qwen3:8b }
`;
const sessions = () => [
  fakeSession("jarvis-diag", [
    tool("net.status", "safe"),
    tool("logs.query", "safe"),
    tool("sys.health", "safe"),
  ]),
  fakeSession("jarvis-pkg", [tool("pkg.install", "confirm", { batch: "items" })]),
];
const readBackupTag = async () => "qwen3:1.7b";

describe("jarvisd's backup brain (M4 §1)", () => {
  it("answers with the backup when the configured provider is down, with the simple tools only", async () => {
    const backup = scripted([[{ type: "text", delta: "أنا هنا" }, DONE]], ["qwen3:1.7b"]);
    const { agent, waitFor, events } = await startAgent({
      yaml: YAML,
      sessions: sessions(),
      providers: { [BACKUP]: backup },
      overrides: { readBackupTag },
    });
    const { turnId } = agent.prompt("hello");
    expect(await waitFor((e) => e.type === "turn-end" && e.turnId === turnId)).toMatchObject({
      reason: "done",
    });
    expect(backup.requests[0]?.tools.map((t) => t.name).sort()).toEqual([
      "net_status",
      "sys_health",
    ]);
    expect(events().flatMap((e) => (e.type === "text" ? [e.delta] : []))).toEqual([
      `${USER_TEXT.en.backupNotice}\n\n`,
      "أنا هنا",
    ]);
    expect((await agent.providerList()).activeId).toBe("backup");
  });

  it("no provider configured: the backup answers", async () => {
    const backup = scripted([[{ type: "text", delta: "hi" }, DONE]], ["qwen3:1.7b"]);
    const { agent, waitFor } = await startAgent({
      sessions: sessions(),
      providers: { [BACKUP]: backup },
      overrides: { readBackupTag },
    });
    const { turnId } = agent.prompt("hello");
    expect(await waitFor((e) => e.type === "turn-end" && e.turnId === turnId)).toMatchObject({
      reason: "done",
    });
    expect(backup.requests).toHaveLength(1);
  });

  it("without a backup model and without providers, says so in the UI language", async () => {
    const { agent, waitFor } = await startAgent({
      sessions: sessions(),
      overrides: { readBackupTag: async () => null, defaultLanguage: "ar" },
    });
    const { turnId } = agent.prompt("hello");
    expect(await waitFor((e) => e.type === "turn-end" && e.turnId === turnId)).toMatchObject({
      reason: "error",
      error: USER_TEXT.ar.noProvider,
    });
  });

  it("keeps the usual model and every tool while it answers", async () => {
    const local = scripted([[{ type: "text", delta: "hi" }, DONE]], ["qwen3:8b"]);
    const backup = scripted([], ["qwen3:1.7b"]);
    const { agent, waitFor, events } = await startAgent({
      yaml: YAML,
      sessions: sessions(),
      providers: { "ollama http://127.0.0.1:11434 qwen3:8b": local, [BACKUP]: backup },
      overrides: { readBackupTag },
    });
    const { turnId } = agent.prompt("hello");
    await waitFor((e) => e.type === "turn-end" && e.turnId === turnId);
    expect(backup.requests).toEqual([]);
    expect(local.requests[0]?.tools.length).toBeGreaterThan(2);
    expect(events().flatMap((e) => (e.type === "text" ? [e.delta] : []))).toEqual(["hi"]);
  });
});
