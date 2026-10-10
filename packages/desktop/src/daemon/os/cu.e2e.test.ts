// packages/desktop/src/daemon/os/cu.e2e.test.ts
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { type AgentEvent, type AuditEntry, type CuState, parseFakeScript } from "@jarvis/core";
import { createAuditLog, createMemorySecretStore, nodeAuditFs } from "@jarvis/platform/model";
import { afterEach, describe, expect, it } from "vitest";
import { connectControl } from "../control/client.js";
import { nodeControlDeps } from "../control/deps.js";
import { nodePeerCheck, SS_PATH } from "../control/peer.js";
import { createControlServer } from "../control/server.js";
import { createOsAgent } from "./agent-service.js";
import { connectUnix, createCuClient } from "./cu-client.js";
import { createOsBinding, createOsRouter } from "./os-binding.js";

const WINDOWS = process.platform === "win32";
const FAKE_CU = fileURLToPath(new URL("./__fixtures__/fake-jarvis-cu.mjs", import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const timers = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  clearInterval: (h: unknown) => clearInterval(h as NodeJS.Timeout),
};
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 600 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error("condition never became true");
}

const CONFIG = [
  "os:",
  "  providers:",
  "    - { id: work, kind: anthropic, baseUrl: 'https://api.anthropic.com', model: claude-sonnet-4-5 }",
  "  computerUse:",
  "    enabled: { work: true }",
  "    cloudConsent: { work: '2026-10-10T09:00:00Z' }",
  "",
].join("\n");

describe.skipIf(WINDOWS)("computer use over the real control socket and a fake jarvis-cu", () => {
  it("prompt -> session card -> look -> click -> excluded click -> save card -> done, audited without screenshots", async () => {
    const dir = await mkdtemp(join("/tmp", "jcu-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const cuSock = join(dir, "cu.sock");
    const opsLog = join(dir, "ops.log");
    const helper: ChildProcess = spawn(process.execPath, [FAKE_CU, cuSock, opsLog]);
    cleanups.push(async () => {
      if (helper.exitCode !== null || helper.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        helper.once("exit", () => resolve());
        helper.kill();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("fake jarvis-cu did not start")), 2000);
      const ready = () => {
        clearTimeout(timeout);
        resolve();
      };
      const failed = (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      };
      helper.stdout?.once("data", ready);
      helper.once("error", failed);
      helper.once("exit", (code) => failed(new Error(`helper exited: ${code}`)));
      helper.stderr?.on("data", (chunk) => failed(new Error(String(chunk))));
    });

    // On Linux CI the kernel check is real: the fake helper runs as node.
    const realPeer = process.platform === "linux" && existsSync(SS_PATH);
    const cuClient = createCuClient({
      connect: () => connectUnix(cuSock),
      verifyPeer: realPeer
        ? async (socket) =>
            (await nodePeerCheck().executableOf(socket)) === realpathSync(process.execPath)
        : async () => true,
      timers,
      log: () => {},
    });
    cleanups.push(() => cuClient.close());

    const configPath = join(dir, "jarvis.yaml");
    await writeFile(configPath, CONFIG);
    let push: (channel: string, payload: unknown) => void = () => {};
    const agent = createOsAgent({
      push: (channel, payload) => push(channel, payload),
      configPath,
      configIo: { readFile: (p) => readFile(p, "utf8"), writeFile: (p, t) => writeFile(p, t) },
      secrets: createMemorySecretStore(),
      providerKeys: createMemorySecretStore(),
      readModelState: async () => null,
      makeProvider: () => {
        throw new Error("the fake provider is active");
      },
      fakeScript: parseFakeScript([
        {
          expectPromptContains: "export",
          replies: [
            {
              toolCalls: [
                {
                  name: "screen.look",
                  input: { goal: "export beach.xcf as PNG", apps: ["org.gimp.GIMP"] },
                },
              ],
            },
            { toolCalls: [{ name: "screen.click", input: { x: 20, y: 20, target: "File" } }] },
            { toolCalls: [{ name: "screen.click", input: { x: 300, y: 20, target: "Canvas" } }] },
            { toolCalls: [{ name: "screen.click", input: { x: 40, y: 40, target: "Canvas" } }] },
            { toolCalls: [{ name: "screen.done", input: { summary: "exported beach.png" } }] },
            { text: "Exported beach.png." },
          ],
        },
      ]),
      connectMcp: async () => [],
      computerUse: { client: cuClient, hash: async (png) => png },
      audit: createAuditLog({ path: join(dir, "audit.jsonl"), fs: nodeAuditFs }),
      now: Date.now,
      newId: () => randomBytes(8).toString("hex"),
      timers,
      log: () => {},
    });
    cleanups.push(() => agent.shutdown());
    const handlers = createOsBinding(createOsRouter({ agent }), {
      requestStop: () => {},
      defer: (cb) => setImmediate(cb),
    });
    const runDirectory = join(dir, "run");
    const started = await createControlServer({
      platform: process.platform,
      runDirectory,
      build: "e2e",
      handlers,
      deps: nodeControlDeps(),
    });
    if (started.kind !== "started") throw new Error("control server busy");
    cleanups.push(() => started.server.close());
    push = (channel, payload) => started.server.push(channel, payload);
    await agent.start();

    const client = await connectControl({
      platform: process.platform,
      runDirectory,
      build: "e2e",
      deps: nodeControlDeps(),
    });
    cleanups.push(() => client.close());
    const events: AgentEvent[] = [];
    const states: CuState[] = [];
    client.onPush((channel, payload) => {
      if (channel === "cu:state") states.push(payload as CuState);
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

    const { turnId } = (await client.invoke("agent:prompt", [
      { text: "export beach.xcf as PNG to Pictures" },
    ])) as { turnId: string };
    await until(() => events.some((e) => e.type === "turn-end"));
    expect(events.at(-1)).toEqual({ type: "turn-end", turnId, reason: "done" });
    expect(
      events
        .filter((e) => e.type === "card")
        .map((e) => (e.type === "card" ? e.card.items[0]?.tool : "")),
    ).toEqual(["cu.begin", "screen.click"]);
    const ops = readFileSync(opsLog, "utf8").trim().split("\n");
    expect(ops.filter((op) => ["begin", "capture", "click", "end"].includes(op))).toEqual([
      "begin",
      "capture",
      "click",
      "click",
      "click",
      "end",
    ]);
    expect(ops.filter((op) => op === "describeAt")).toHaveLength(3);
    expect(states.some((s) => s.active && s.apps[0] === "org.gimp.GIMP")).toBe(true);
    expect(states.at(-1)?.active).toBe(false);

    const audit = (await client.invoke("audit:list", [{ limit: 20 }])) as AuditEntry[];
    expect(audit.map((e) => [e.tool, e.result])).toEqual([
      ["cu.end", "ok"],
      ["screen.click", "ok"],
      ["screen.click", "failed"],
      ["screen.click", "ok"],
      ["cu.begin", "ok"],
    ]);
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain("iVBORw0KGgo");

    // The settings and control channels over the socket.
    await expect(client.invoke("cu:stop", [])).resolves.toBeNull();
    await expect(
      client.invoke("cu:setEnabled", [{ providerId: "work", enabled: false }]),
    ).resolves.toBeNull();
    await expect(client.invoke("cu:consent", [{ providerId: "nope" }])).rejects.toMatchObject({
      code: "bad-request",
    });
  }, 15_000);
});

// Exercise the fixture's actual NDJSON handler with injected filesystem and
// transport effects, so its contract can also be checked without socket access.
describe("fake jarvis-cu protocol", () => {
  it("refuses an excluded surface inside the fullscreen capture without logging payloads", () => {
    const socket = new EventEmitter();
    const replies: Array<{ id: string; ok: boolean; data?: unknown; error?: { code: string } }> =
      [];
    const ops: string[] = [];
    const wire = Object.assign(socket, {
      setEncoding: () => {},
      write: (line: string) => replies.push(JSON.parse(line)),
    });
    const source = readFileSync(FAKE_CU, "utf8").replace(
      /^import .* from "node:(fs|net)";\n/gm,
      "",
    );
    runInNewContext(source, {
      appendFileSync: (_path: string, line: string) => ops.push(line),
      chmodSync: () => {},
      createServer: (connect: (socket: typeof wire) => void) => ({
        listen: (_path: string, ready: () => void) => {
          connect(wire);
          ready();
        },
      }),
      process: { argv: ["node", FAKE_CU, "cu.sock", "ops.log"], stdout: { write: () => {} } },
    });
    const request = (id: string, op: string, fields = {}) =>
      socket.emit("data", `${JSON.stringify({ id, op, ...fields })}\n`);
    request("1", "apps");
    request("2", "begin", { sessionId: "private-goal", appIds: ["org.gimp.GIMP"] });
    request("3", "capture");
    request("4", "click", { x: 20, y: 20, button: "left" });
    request("5", "click", { x: 300, y: 20, button: "left" });
    request("6", "click", { x: 1280, y: 20, button: "left" });
    request("7", "end");
    request("8", "click", { x: 20, y: 20, button: "left" });
    request("9", "end");
    expect(replies[0]?.data).toEqual([{ appId: "org.gimp.GIMP", name: "GIMP" }]);
    expect(replies[2]?.data).toMatchObject({
      width: 1280,
      height: 800,
      windows: [{ x: 0, y: 0, w: 1280, h: 800, focused: true, allowed: true }],
    });
    expect(replies[3]).toEqual({ id: "4", ok: true, data: null });
    expect(replies[4]).toMatchObject({ id: "5", ok: false, error: { code: "excluded" } });
    expect(replies[5]).toMatchObject({ id: "6", ok: false, error: { code: "outside" } });
    expect(replies[7]).toMatchObject({ id: "8", ok: false, error: { code: "no-session" } });
    expect(replies[8]).toEqual({ id: "9", ok: true, data: null });
    expect(ops.join("")).toBe("apps\nbegin\ncapture\nclick\nclick\nclick\nend\nclick\nend\n");
  });
});
