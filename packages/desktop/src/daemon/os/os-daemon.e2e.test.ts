import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AgentEvent, type AuditEntry, parseFakeScript, type SysSnapshot } from "@jarvis/core";
import {
  createAuditLog,
  createMemorySecretStore,
  nodeAuditFs,
  nodeMcpSpawn,
} from "@jarvis/platform/model";
import { afterEach, describe, expect, it } from "vitest";
import { connectControl } from "../control/client.js";
import { nodeControlDeps } from "../control/deps.js";
import { createControlServer } from "../control/server.js";
import { createOsAgent } from "./agent-service.js";
import { connectOsMcpServers } from "./mcp-servers.js";
import { createOsBinding } from "./os-binding.js";

const WINDOWS = process.platform === "win32";
const FIXTURE = fileURLToPath(
  new URL("../../../../platform/src/mcp/__fixtures__/fake-mcp-server.mjs", import.meta.url),
);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timers = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
};

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!check()) throw new Error("condition never became true");
}

// Same reasons as the other daemon e2e tests: no named-pipe daemon in CI on Windows.
describe.skipIf(WINDOWS)("jarvisd OS mode over the real control socket", () => {
  it("prompt -> one card -> approve -> install -> answer -> audit", async () => {
    // Unix socket paths are capped near 104 bytes; macOS's tmpdir eats half.
    const dir = await mkdtemp(join("/tmp", "jo-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const runDirectory = join(dir, "run");
    let push: (channel: string, payload: unknown) => void = () => {};
    const agent = createOsAgent({
      push: (channel, payload) => push(channel, payload),
      configPath: join(dir, "jarvis.yaml"),
      configIo: {
        readFile: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        writeFile: async () => {},
      },
      secrets: createMemorySecretStore(),
      readModelState: async () => null,
      makeProvider: () => {
        throw new Error("the fake provider is active");
      },
      fakeScript: parseFakeScript([
        {
          expectPromptContains: "install hello",
          replies: [
            {
              toolCalls: [
                { name: "pkg.install", input: { items: [{ source: "apt", id: "hello" }] } },
              ],
            },
            { text: "Installed hello." },
          ],
        },
      ]),
      connectMcp: () =>
        connectOsMcpServers({
          servers: ["jarvis-pkg"],
          commandFor: (name) => ({ command: process.execPath, args: [FIXTURE, name] }),
          spawn: nodeMcpSpawn(process.env, () => {}),
          timers,
          clientVersion: "test",
          log: () => {},
        }),
      audit: createAuditLog({ path: join(dir, "audit.jsonl"), fs: nodeAuditFs }),
      now: Date.now,
      newId: () => randomBytes(8).toString("hex"),
      timers,
      log: () => {},
    });
    cleanups.push(() => agent.shutdown());
    const handlers = createOsBinding(agent, {
      requestStop: () => {},
      defer: (cb) => setImmediate(cb),
    });
    const started = await createControlServer({
      platform: process.platform,
      runDirectory,
      build: "e2e-build",
      handlers,
      deps: nodeControlDeps(),
    });
    if (started.kind !== "started") throw new Error("control server busy");
    const server = started.server;
    cleanups.push(() => server.close());
    push = (channel, payload) => server.push(channel, payload);
    server.onConnect(() => agent.resync());
    await agent.start();

    const client = await connectControl({
      platform: process.platform,
      runDirectory,
      build: "e2e-build",
      deps: nodeControlDeps(),
    });
    cleanups.push(() => client.close());
    const events: AgentEvent[] = [];
    const channels: string[] = [];
    const snapshotsSeen: SysSnapshot[] = [];
    client.onPush((channel, payload) => {
      channels.push(channel);
      if (channel === "sys:snapshot") snapshotsSeen.push(payload as SysSnapshot);
      if (channel !== "agent:events") return;
      const event = payload as AgentEvent;
      events.push(event);
      if (event.type === "card") {
        void client.invoke("agent:confirm", [
          {
            cardId: event.card.cardId,
            approve: true,
            ticked: event.card.items.map((i) => i.itemId),
            secrets: {},
          },
        ]);
      }
    });

    await expect(client.invoke("provider:list", [])).resolves.toEqual({
      active: null,
      kinds: ["anthropic", "openai-compatible", "ollama", "gemini"],
    });
    await expect(client.invoke("agent:prompt", [{}])).rejects.toMatchObject({
      code: "bad-request",
    });

    const { turnId } = (await client.invoke("agent:prompt", [
      { text: "please install hello" },
    ])) as { turnId: string };
    await until(() => events.some((e) => e.type === "turn-end"));
    expect(events.at(-1)).toEqual({ type: "turn-end", turnId, reason: "done" });
    const card = events.find((e) => e.type === "card");
    expect(card?.type === "card" && card.card.items[0]).toMatchObject({
      tool: "pkg.install",
      title: "pkg.install on jarvis-pkg",
      source: "debian",
    });
    expect(events).toContainEqual({
      type: "card-closed",
      cardId: card?.type === "card" ? card.card.cardId : "",
      decision: "approved",
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool", name: "pkg.install", status: "ok" }),
    );
    expect(events).toContainEqual({ type: "text", turnId, delta: "Installed hello." });

    const audit = (await client.invoke("audit:list", [{ limit: 10 }])) as AuditEntry[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tool: "pkg.install",
      decision: "approved",
      via: "desktop",
      result: "ok",
    });
    // Contracts §6 #23: audit ts on the socket is epoch ms, a number.
    expect(typeof audit[0]?.ts).toBe("number");
    // M2 contracts §2: updates:check runs updates.list over the real socket.
    await expect(client.invoke("updates:check", [])).resolves.toEqual({ count: 2, security: 1 });
    // Contracts §6 #7/#8: the new connection got provider:status, doctor:state and sys:snapshot.
    // The control server pushes on connect, before this listener exists; ask again.
    agent.resync();
    await until(() =>
      ["provider:status", "doctor:state", "sys:snapshot"].every((c) => channels.includes(c)),
    );
    // The check's refresh and the resync race; wait for the snapshot that carries it.
    await until(() => snapshotsSeen.some((s) => s.updates.count === 2 && s.updates.security === 1));
  });
});
