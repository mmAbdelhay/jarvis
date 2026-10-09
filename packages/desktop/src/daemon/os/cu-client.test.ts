// packages/desktop/src/daemon/os/cu-client.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { CuClientError, PNG_BASE64_PREFIX } from "@jarvis/core";
import { afterEach, describe, expect, it } from "vitest";
import { connectUnix, createCuClient, cuSocketPath } from "./cu-client.js";

const WINDOWS = process.platform === "win32";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const timers = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
};

type Handler = (request: Record<string, unknown>, socket: Socket) => unknown;

async function fakeHelper(handle: Handler): Promise<{
  path: string;
  server: Server;
  sockets: Socket[];
  received: Record<string, unknown>[];
}> {
  const dir = await mkdtemp(join("/tmp", "cu-"));
  const path = join(dir, "cu.sock");
  const sockets: Socket[] = [];
  const received: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        received.push(request);
        const answer = handle(request, socket);
        if (answer !== undefined) socket.write(`${JSON.stringify(answer)}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { path, server, sockets, received };
}

function client(
  path: string,
  over: { verifyPeer?: () => Promise<boolean>; requestTimeoutMs?: number } = {},
) {
  const lines: string[] = [];
  const c = createCuClient({
    connect: () => connectUnix(path),
    verifyPeer: over.verifyPeer ?? (async () => true),
    timers,
    log: (line) => lines.push(line),
    ...(over.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: over.requestTimeoutMs }),
  });
  cleanups.push(() => c.close());
  return { c, lines };
}

describe("cuSocketPath", () => {
  it("is $XDG_RUNTIME_DIR/jarvis/cu.sock for an absolute runtime dir only", () => {
    expect(cuSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe(
      "/run/user/1000/jarvis/cu.sock",
    );
    expect(cuSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000/" })).toBe(
      "/run/user/1000/jarvis/cu.sock",
    );
    expect(cuSocketPath({})).toBeUndefined();
    expect(cuSocketPath({ XDG_RUNTIME_DIR: "relative" })).toBeUndefined();
  });
});

describe.skipIf(WINDOWS)("createCuClient over a real Unix socket (contracts §1)", () => {
  it("sends NDJSON requests with ids and reads typed answers", async () => {
    const png = `${PNG_BASE64_PREFIX}AAAA`;
    const helper = await fakeHelper((req) => {
      if (req["op"] === "capture")
        return {
          id: req["id"],
          ok: true,
          data: { pngBase64: png, width: 1280, height: 800, scale: 1, windows: [] },
        };
      if (req["op"] === "apps")
        return { id: req["id"], ok: true, data: [{ appId: "org.gimp.GIMP", name: "GIMP" }] };
      if (req["op"] === "describeAt")
        return { id: req["id"], ok: true, data: { role: "push button", name: "Save" } };
      if (req["op"] === "windows")
        return {
          id: req["id"],
          ok: true,
          data: [
            {
              windowId: 1,
              appId: "org.gimp.GIMP",
              title: "t",
              x: 0,
              y: 0,
              w: 10,
              h: 10,
              focused: true,
              allowed: false,
            },
          ],
        };
      return { id: req["id"], ok: true, data: null };
    });
    const { c } = client(helper.path);
    await c.begin("s1", ["org.gimp.GIMP"]);
    await expect(c.windows()).resolves.toEqual([
      expect.objectContaining({ appId: "org.gimp.GIMP", windowId: "1" }),
    ]);
    await expect(c.capture(1280)).resolves.toMatchObject({ width: 1280, height: 800 });
    await c.click(5, 6, "left", false);
    await c.click(5, 6, "left", true);
    await c.type("héllo");
    await c.key("ctrl+s");
    await c.scroll(1, 2, 0, 3);
    await c.drag(1, 2, 3, 4);
    await c.apps();
    await c.describeAt(7, 8);
    await c.end();
    expect(helper.received.map(({ id: _id, ...rest }) => rest)).toEqual([
      { op: "begin", sessionId: "s1", appIds: ["org.gimp.GIMP"] },
      { op: "windows" },
      { op: "capture", maxEdge: 1280 },
      { op: "click", x: 5, y: 6, button: "left" },
      { op: "click", x: 5, y: 6, button: "left", double: true },
      { op: "type", text: "héllo" },
      { op: "key", combo: "ctrl+s" },
      { op: "scroll", x: 1, y: 2, dx: 0, dy: 3 },
      { op: "drag", x1: 1, y1: 2, x2: 3, y2: 4 },
      { op: "apps" },
      { op: "describeAt", x: 7, y: 8 },
      { op: "end" },
    ]);
    expect(new Set(helper.received.map((r) => r["id"])).size).toBe(12);
  });

  it("turns a refusal into a CuClientError with the contract's code", async () => {
    const helper = await fakeHelper((req) => ({
      id: req["id"],
      ok: false,
      error: { code: "outside", message: "not in an allowed window" },
    }));
    const { c } = client(helper.path);
    await expect(c.click(1, 1, "left", false)).rejects.toMatchObject({ code: "outside" });
    const odd = await fakeHelper((req) => ({ id: req["id"], ok: false, error: { code: "weird" } }));
    await expect(client(odd.path).c.end()).rejects.toMatchObject({ code: "failed" });
  });

  it("refuses a socket whose peer is not jarvis-cu, before sending anything", async () => {
    const helper = await fakeHelper((req) => ({ id: req["id"], ok: true, data: null }));
    const { c } = client(helper.path, { verifyPeer: async () => false });
    await expect(c.begin("s", ["x"])).rejects.toEqual(expect.any(CuClientError));
    await expect(c.begin("s", ["x"])).rejects.toMatchObject({ code: "unsupported" });
    expect(helper.received).toEqual([]);
  });

  it("survives a socket error while the peer check is pending", async () => {
    const helper = await fakeHelper((req) => ({ id: req["id"], ok: true, data: null }));
    const lines: string[] = [];
    const c = createCuClient({
      connect: () => connectUnix(helper.path),
      verifyPeer: (socket) =>
        new Promise<boolean>((resolve) => {
          setImmediate(() =>
            socket.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" })),
          );
          setTimeout(() => resolve(false), 20);
        }),
      timers,
      log: (line) => lines.push(line),
    });
    cleanups.push(() => c.close());
    await expect(c.begin("s", ["x"])).rejects.toMatchObject({ code: "unsupported" });
    expect(lines).toContain("[cu] socket error: ECONNRESET");
  });

  it("says unsupported when the helper is not running", async () => {
    const { c } = client("/tmp/does-not-exist-jarvis-cu.sock");
    await expect(c.capture(1280)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("delivers paused events, and fails pending requests when the helper goes away", async () => {
    const helper = await fakeHelper((req, socket) => {
      if (req["op"] === "begin") {
        socket.write(`${JSON.stringify({ event: "paused", reason: "esc" })}\n`);
        socket.write(`${JSON.stringify({ event: "paused", reason: "bogus" })}\n`);
        return { id: req["id"], ok: true, data: null };
      }
      if (req["op"] === "capture") {
        setTimeout(() => socket.destroy(), 10);
        return undefined;
      }
      return { id: req["id"], ok: true, data: null };
    });
    const { c } = client(helper.path);
    const reasons: string[] = [];
    let gone = 0;
    c.onPaused((reason) => reasons.push(reason));
    c.onGone(() => gone++);
    await c.begin("s", ["x"]);
    await expect(c.capture(1280)).rejects.toMatchObject({ code: "failed" });
    expect(reasons).toEqual(["esc"]);
    expect(gone).toBe(1);
  });

  it("times out a silent helper", async () => {
    const helper = await fakeHelper(() => undefined);
    const { c } = client(helper.path, { requestTimeoutMs: 50 });
    await expect(c.end()).rejects.toMatchObject({ code: "failed" });
  });

  it("never logs request or response payloads", async () => {
    const helper = await fakeHelper((req) =>
      req["op"] === "type"
        ? { id: req["id"], ok: false, error: { code: "excluded", message: "focus" } }
        : "not json",
    );
    const { c, lines } = client(helper.path);
    await expect(c.type("my secret text")).rejects.toMatchObject({ code: "excluded" });
    expect(lines.join("\n")).not.toContain("my secret text");
  });
});
