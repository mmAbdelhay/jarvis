import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDSHAKE_TIMEOUT_MS } from "@jarvis/wire";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ControlClient,
  ControlRequestError,
  ControlRestartRequired,
  connectControl,
} from "./client.js";
import { type ControlClock, type ControlDeps, nodeControlDeps } from "./deps.js";
import { CONTROL_PROTOCOL_VERSION, encodeJsonFrame, FrameDecoder } from "./frames.js";
import { type ControlHandlers, type ControlServer, createControlServer } from "./server.js";

const WINDOWS = process.platform === "win32";
const PLATFORM = process.platform;

// Unix socket paths are capped near 104 bytes, and macOS's os.tmpdir() alone
// eats half of that — so the fixtures live under /tmp there.
async function fixture(): Promise<{ dir: string; endpoint: string; secretPath: string }> {
  const dir = await mkdtemp(join(WINDOWS ? tmpdir() : "/tmp", "jc-"));
  const endpoint = WINDOWS
    ? `\\\\.\\pipe\\jarvisd-test-${randomBytes(8).toString("hex")}`
    : join(dir, "run", "jarvisd.sock");
  return { dir, endpoint, secretPath: join(dir, "run", "control.secret") };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const echoHandlers: ControlHandlers = {
  async invoke(channel, args) {
    if (channel === "test:fail") throw new ControlRequestError("forbidden", "no");
    if (channel === "test:bigint") return 1n;
    return { channel, args };
  },
  async upload(channel, args, bytes) {
    return {
      channel,
      args,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  },
};

async function start(
  paths: { endpoint: string; secretPath: string },
  overrides: { build?: string; deps?: ControlDeps } = {},
): Promise<ControlServer> {
  const result = await createControlServer({
    endpoint: paths.endpoint,
    platform: PLATFORM,
    secretPath: paths.secretPath,
    build: overrides.build ?? "build-1",
    handlers: echoHandlers,
    deps: overrides.deps ?? nodeControlDeps(),
  });
  if (result.kind !== "started") throw new Error("expected the lock");
  cleanups.push(() => result.server.close());
  return result.server;
}

async function client(
  paths: { endpoint: string; secretPath: string },
  build = "build-1",
): Promise<ControlClient> {
  const c = await connectControl({
    endpoint: paths.endpoint,
    secretPath: paths.secretPath,
    build,
    deps: nodeControlDeps(),
  });
  cleanups.push(() => c.close());
  return c;
}

/** A raw socket that records every frame the server sends and when it closes. */
function raw(
  endpoint: string,
): Promise<{ socket: Socket; frames: unknown[]; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const frames: unknown[] = [];
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (let f = decoder.next(); f !== undefined; f = decoder.next()) frames.push(f);
    });
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.once("connect", () => resolve({ socket, frames, closed }));
    socket.once("error", reject);
    cleanups.push(() => void socket.destroy());
  });
}

function fakeClock(): ControlClock & { timers: Array<{ ms: number; fire: () => void }> } {
  const timers: Array<{ ms: number; fire: () => void; cleared: boolean }> = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { ms, cleared: false, fire: () => (timer.cleared ? undefined : fn()) };
      timers.push(timer);
      return timer;
    },
    clearTimeout(handle) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("the control transport", () => {
  it("authenticates and carries requests and handler errors", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    await start(paths);
    const c = await client(paths);

    await expect(c.invoke("test:echo", [1, "a", { b: true }])).resolves.toEqual({
      channel: "test:echo",
      args: [1, "a", { b: true }],
    });
    const failure = await c.invoke("test:fail", []).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ControlRequestError);
    expect((failure as ControlRequestError).code).toBe("forbidden");
    const unencodable = await c.invoke("test:bigint", []).catch((e: unknown) => e);
    expect((unencodable as ControlRequestError).code).toBe("internal");
  });

  it("closes a wrong secret without replying", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    await start(paths);
    const { socket, frames, closed } = await raw(paths.endpoint);
    socket.write(
      encodeJsonFrame({
        t: "hello",
        v: CONTROL_PROTOCOL_VERSION,
        secret: randomBytes(32).toString("hex"),
        build: "build-1",
      }),
    );
    await closed;
    expect(frames).toEqual([]);
  });

  it("closes a connection whose first frame is not a hello", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    await start(paths);
    const { socket, frames, closed } = await raw(paths.endpoint);
    socket.write(encodeJsonFrame({ t: "req", id: 1, ch: "test:echo", a: [] }));
    await closed;
    expect(frames).toEqual([]);
  });

  it("closes a connection that sends no hello within 5 s", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    const clock = fakeClock();
    await start(paths, { deps: { ...nodeControlDeps(), clock } });
    const { frames, closed } = await raw(paths.endpoint);
    await until(() => clock.timers.length === 1);
    expect(clock.timers[0]?.ms).toBe(HANDSHAKE_TIMEOUT_MS);
    expect(HANDSHAKE_TIMEOUT_MS).toBe(5_000);
    clock.timers[0]?.fire();
    await closed;
    expect(frames).toEqual([]);
  });

  it("answers a build mismatch with restart-required", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    await start(paths, { build: "build-new" });
    const failure = await client(paths, "build-old").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ControlRestartRequired);
    expect((failure as ControlRestartRequired).build).toBe("build-new");
  });

  it("round-trips a 16 MiB blob", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    await start(paths);
    const c = await client(paths);
    const bytes = randomBytes(16 * 1024 * 1024);
    await expect(c.upload("test:upload", ["name.bin"], bytes)).resolves.toEqual({
      channel: "test:upload",
      args: ["name.bin"],
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    // The connection is still usable after the blob lane.
    await expect(c.invoke("test:echo", [])).resolves.toEqual({ channel: "test:echo", args: [] });
  });

  it("delivers 1000 pushes to every client in order", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    const server = await start(paths);
    const a = await client(paths);
    const b = await client(paths);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    a.onPush((channel, payload) => seenA.push([channel, payload]));
    b.onPush((channel, payload) => seenB.push([channel, payload]));
    const expected = Array.from({ length: 1000 }, (_, i) => ["test:tick", { i }]);
    for (let i = 0; i < 1000; i++) server.push("test:tick", { i });
    await until(() => seenA.length === 1000 && seenB.length === 1000);
    expect(seenA).toEqual(expected);
    expect(seenB).toEqual(expected);
  });

  it("tells a second server the endpoint is busy and keeps serving", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    await start(paths);
    const secretBefore = await readFile(paths.secretPath, "utf8");
    const second = await createControlServer({
      endpoint: paths.endpoint,
      platform: PLATFORM,
      secretPath: paths.secretPath,
      build: "build-1",
      handlers: echoHandlers,
      deps: nodeControlDeps(),
    });
    expect(second).toEqual({ kind: "busy" });
    // The loser must not overwrite the live daemon's secret.
    expect(await readFile(paths.secretPath, "utf8")).toBe(secretBefore);
    const c = await client(paths);
    await expect(c.invoke("test:echo", [])).resolves.toEqual({ channel: "test:echo", args: [] });
  });

  it("writes a fresh 32-byte hex secret on every start", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    const first = await start(paths);
    const one = await readFile(paths.secretPath, "utf8");
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    await first.close();
    await start(paths);
    const two = await readFile(paths.secretPath, "utf8");
    expect(two).toMatch(/^[0-9a-f]{64}$/);
    expect(two).not.toBe(one);
  });

  it.skipIf(WINDOWS)("keeps the secret 0600, the socket 0600 and the run dir 0700", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    await start(paths);
    expect((await stat(paths.secretPath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.endpoint)).mode & 0o777).toBe(0o600);
    expect((await stat(join(paths.dir, "run"))).mode & 0o777).toBe(0o700);
  });

  it.skipIf(WINDOWS)("recovers a stale socket left by a killed daemon", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    const script = `const fs=require("node:fs");fs.mkdirSync(${JSON.stringify(join(paths.dir, "run"))},{recursive:true});require("node:net").createServer().listen(${JSON.stringify(paths.endpoint)},()=>process.stdout.write("up"));`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    expect((await stat(paths.endpoint)).isSocket()).toBe(true);

    await start(paths);
    const c = await client(paths);
    await expect(c.invoke("test:echo", [])).resolves.toEqual({ channel: "test:echo", args: [] });
  });

  it.skipIf(WINDOWS)("refuses to unlink a non-socket file at the endpoint", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(paths.dir, "run"), { recursive: true });
    await writeFile(paths.endpoint, "not a socket");
    await expect(
      createControlServer({
        endpoint: paths.endpoint,
        platform: PLATFORM,
        secretPath: paths.secretPath,
        build: "build-1",
        handlers: echoHandlers,
        deps: nodeControlDeps(),
      }),
    ).rejects.toThrow();
    expect(await readFile(paths.endpoint, "utf8")).toBe("not a socket");
  });

  it("rejects pending requests when the server goes away", async () => {
    const paths = await fixture();
    cleanups.push(() => rm(paths.dir, { recursive: true, force: true }));
    let release: () => void = () => {};
    const result = await createControlServer({
      endpoint: paths.endpoint,
      platform: PLATFORM,
      secretPath: paths.secretPath,
      build: "build-1",
      handlers: {
        ...echoHandlers,
        invoke: () => new Promise((resolve) => (release = () => resolve(null))),
      },
      deps: nodeControlDeps(),
    });
    if (result.kind !== "started") throw new Error("expected the lock");
    const c = await client(paths);
    let closed = false;
    c.onClose(() => (closed = true));
    const pending = c.invoke("test:hang", []);
    await result.server.close();
    release();
    await expect(pending).rejects.toThrow();
    expect(closed).toBe(true);
  });
});
