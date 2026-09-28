import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDSHAKE_TIMEOUT_MS } from "@jarvis/wire";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ControlClient,
  ControlRequestError,
  ControlRestartRequired,
  connectControl,
  requestControlStop,
} from "./client.js";
import { type ControlClock, type ControlDeps, nodeControlDeps } from "./deps.js";
import { controlPaths } from "./endpoint.js";
import { answersWithProof } from "./liveness.js";
import { STALE_LOCK_GRACE_MS } from "./lock.js";
import { CONTROL_PROTOCOL_VERSION, encodeJsonFrame, type Frame, FrameDecoder } from "./frames.js";
import { type ControlHandlers, type ControlServer, createControlServer } from "./server.js";

const WINDOWS = process.platform === "win32";
const PLATFORM = process.platform;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Unix socket paths are capped near 104 bytes, and macOS's os.tmpdir() alone
// eats half of that — so the fixtures live under /tmp there.
async function fixture(): Promise<{ dir: string; runDirectory: string }> {
  const dir = await mkdtemp(join(WINDOWS ? tmpdir() : "/tmp", "jc-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return { dir, runDirectory: join(dir, "run") };
}

const echoHandlers: ControlHandlers = {
  async invoke(channel, args) {
    if (channel === "test:fail") throw new ControlRequestError("forbidden", "no");
    if (channel === "test:bigint") return 1n;
    return { channel, args };
  },
  stop() {},
  async upload(channel, args, bytes) {
    return {
      channel,
      args,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  },
};

function startRaw(
  runDirectory: string,
  overrides: { build?: string; deps?: ControlDeps; handlers?: ControlHandlers } = {},
) {
  return createControlServer({
    platform: PLATFORM,
    runDirectory,
    build: overrides.build ?? "build-1",
    handlers: overrides.handlers ?? echoHandlers,
    deps: overrides.deps ?? nodeControlDeps(),
  });
}

async function start(
  runDirectory: string,
  overrides: { build?: string; deps?: ControlDeps; handlers?: ControlHandlers } = {},
): Promise<ControlServer> {
  const result = await startRaw(runDirectory, overrides);
  if (result.kind !== "started") throw new Error("expected the lock");
  cleanups.push(() => result.server.close());
  return result.server;
}

async function client(runDirectory: string, build = "build-1"): Promise<ControlClient> {
  const c = await connectControl({
    platform: PLATFORM,
    runDirectory,
    build,
    deps: nodeControlDeps(),
  });
  cleanups.push(() => c.close());
  return c;
}

type Raw = { socket: Socket; frames: Frame[]; closed: Promise<void>; isClosed(): boolean };

/** A raw socket that records every frame the server sends and when it closes. */
function raw(endpoint: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    const frames: Frame[] = [];
    const decoder = new FrameDecoder(1024 * 1024);
    let closedFlag = false;
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (let f = decoder.next(); f !== undefined; f = decoder.next()) frames.push(f);
    });
    const closed = new Promise<void>((done) =>
      socket.on("close", () => {
        closedFlag = true;
        done();
      }),
    );
    socket.once("connect", () => resolve({ socket, frames, closed, isClosed: () => closedFlag }));
    socket.once("error", reject);
    cleanups.push(() => void socket.destroy());
  });
}

function hmac(secretHex: string, label: string, first: string, second: string): string {
  return createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(label)
    .update(Buffer.from(first, "hex"))
    .update(Buffer.from(second, "hex"))
    .digest("hex");
}

function fakeClock(): ControlClock & { timers: Array<{ ms: number; fire: () => void }> } {
  const timers: Array<{ ms: number; fire: () => void; cleared: boolean }> = [];
  return {
    timers,
    now: () => Date.now(),
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

/** Real timers, except the stale-lock grace, which fires at once. */
function graceDeps(): ControlDeps {
  const real = nodeControlDeps();
  return {
    ...real,
    clock: {
      ...real.clock,
      setTimeout: (callback, ms) =>
        ms === STALE_LOCK_GRACE_MS ? setImmediate(callback) : real.clock.setTimeout(callback, ms),
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

async function killedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const pid = child.pid;
  if (pid === undefined) throw new Error("no child pid");
  child.kill("SIGKILL");
  await exited;
  return pid;
}

/** Leaves a socket file at the endpoint with nobody listening, as a SIGKILLed daemon does. */
async function staleSocket(runDirectory: string): Promise<void> {
  const socketPath = controlPaths(PLATFORM, runDirectory).socketPath;
  const script = `require("node:fs").mkdirSync(${JSON.stringify(runDirectory)},{recursive:true,mode:0o700});require("node:net").createServer().listen(${JSON.stringify(socketPath)},()=>process.stdout.write("up"));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  expect((await stat(socketPath)).isSocket()).toBe(true);
}

/** Runs the client half of the handshake by hand, returning what it saw. */
async function handshake(
  endpoint: string,
  secretHex: string,
  options: {
    nonceC?: string;
    proof?: (nonceS: string, nonceC: string) => string;
    v?: number;
    build?: string;
    intent?: string;
  } = {},
): Promise<{ connection: Raw; nonceS: string; proof: string }> {
  const connection = await raw(endpoint);
  const nonceC = options.nonceC ?? randomBytes(32).toString("hex");
  connection.socket.write(
    encodeJsonFrame({
      t: "hello",
      v: options.v ?? CONTROL_PROTOCOL_VERSION,
      build: options.build ?? "build-1",
      nonceC,
      ...(options.intent === undefined ? {} : { intent: options.intent }),
    }),
  );
  await until(() => connection.frames.length >= 1);
  const challenge = connection.frames[0] as {
    kind: "json";
    value: { t: string; nonceS: string; proof: string };
  };
  expect(challenge.value.t).toBe("challenge");
  const { nonceS } = challenge.value;
  expect(challenge.value.proof).toBe(hmac(secretHex, "jarvisd-server", nonceC, nonceS));
  const proof = options.proof
    ? options.proof(nonceS, nonceC)
    : hmac(secretHex, "jarvisd-client", nonceS, nonceC);
  connection.socket.write(encodeJsonFrame({ t: "auth", proof }));
  return { connection, nonceS, proof };
}

describe("the control transport", () => {
  it("authenticates and carries requests and handler errors", async () => {
    const { runDirectory } = await fixture();
    await start(runDirectory);
    const c = await client(runDirectory);

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

  it.skipIf(WINDOWS)(
    "refuses a server that cannot prove the secret, and never sends it a proof or the secret",
    async () => {
      const { runDirectory } = await fixture();
      const paths = controlPaths(PLATFORM, runDirectory);
      await mkdir(runDirectory, { recursive: true, mode: 0o700 });
      const secret = randomBytes(32).toString("hex");
      await writeFile(paths.secretPath, secret, { mode: 0o600 });

      const received: Buffer[] = [];
      const impostor = createServer((socket) => {
        const decoder = new FrameDecoder(1024 * 1024);
        socket.on("data", (chunk: Buffer) => {
          received.push(chunk);
          decoder.push(chunk);
          for (let f = decoder.next(); f !== undefined; f = decoder.next()) {
            const nonceC = (f as { value: { nonceC: string } }).value.nonceC;
            const nonceS = randomBytes(32).toString("hex");
            const guessed = randomBytes(32).toString("hex");
            socket.write(
              encodeJsonFrame({
                t: "challenge",
                nonceS,
                proof: hmac(guessed, "jarvisd-server", nonceC, nonceS),
              }),
            );
          }
        });
      });
      await new Promise<void>((resolve) => impostor.listen(paths.socketPath, resolve));
      cleanups.push(() => new Promise<void>((resolve) => impostor.close(() => resolve())));

      await expect(client(runDirectory)).rejects.toThrow(/prove/);
      const bytes = Buffer.concat(received);
      const decoder = new FrameDecoder(1024 * 1024);
      decoder.push(bytes);
      const frames: Frame[] = [];
      for (let f = decoder.next(); f !== undefined; f = decoder.next()) frames.push(f);
      expect(frames.map((f) => (f as { value: { t: string } }).value.t)).toEqual(["hello"]);
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.includes(Buffer.from(secret, "hex"))).toBe(false);
    },
  );

  it.skipIf(WINDOWS)("caps frames at 4 KiB until the daemon has proven itself", async () => {
    const { runDirectory } = await fixture();
    const paths = controlPaths(PLATFORM, runDirectory);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.secretPath, randomBytes(32).toString("hex"), { mode: 0o600 });
    let peerClosed: Promise<void> = Promise.resolve();
    const impostor = createServer((socket) => {
      peerClosed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      socket.once("data", () => socket.write(encodeJsonFrame({ t: "x", pad: "y".repeat(5_000) })));
    });
    await new Promise<void>((resolve) => impostor.listen(paths.socketPath, resolve));
    cleanups.push(() => new Promise<void>((resolve) => impostor.close(() => resolve())));
    await expect(client(runDirectory)).rejects.toThrow(/too large/);
    await peerClosed;
  });

  it("recognises the daemon by its proof, and nothing else", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const { secretPath } = controlPaths(PLATFORM, runDirectory);
    const deps = nodeControlDeps();
    await expect(answersWithProof(server.endpoint, secretPath, deps)).resolves.toBe(true);
    await writeFile(`${secretPath}.other`, randomBytes(32).toString("hex"));
    await expect(answersWithProof(server.endpoint, `${secretPath}.other`, deps)).resolves.toBe(
      false,
    );
    await expect(answersWithProof(server.endpoint, `${secretPath}.missing`, deps)).resolves.toBe(
      false,
    );
    await server.close();
    await expect(answersWithProof(server.endpoint, secretPath, deps)).resolves.toBe(false);
  });

  it("removes the control secret and the published endpoint on a clean close", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const paths = controlPaths(PLATFORM, runDirectory);
    await expect(stat(paths.secretPath)).resolves.toBeDefined();
    await server.close();
    for (const path of [paths.secretPath, paths.endpointPath, paths.pidPath]) {
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("closes a wrong client proof without replying past the challenge", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const secret = await readFile(controlPaths(PLATFORM, runDirectory).secretPath, "utf8");
    const { connection } = await handshake(server.endpoint, secret, {
      proof: () => randomBytes(32).toString("hex"),
    });
    await connection.closed;
    expect(connection.frames).toHaveLength(1);
  });

  it("refuses a client proof replayed against a new server nonce", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const secret = await readFile(controlPaths(PLATFORM, runDirectory).secretPath, "utf8");
    const nonceC = randomBytes(32).toString("hex");

    const first = await handshake(server.endpoint, secret, { nonceC });
    await until(() => first.connection.frames.length === 2);
    expect((first.connection.frames[1] as { value: { t: string } }).value.t).toBe("welcome");

    const replay = await handshake(server.endpoint, secret, { nonceC, proof: () => first.proof });
    expect(replay.nonceS).not.toBe(first.nonceS);
    await replay.connection.closed;
    expect(replay.connection.frames).toHaveLength(1);
  });

  it("closes a connection whose first frame is not a hello", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const { socket, frames, closed } = await raw(server.endpoint);
    socket.write(encodeJsonFrame({ t: "req", id: 1, ch: "test:echo", a: [] }));
    await closed;
    expect(frames).toEqual([]);
  });

  it("closes a pre-hello frame over 4 KiB", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const { socket, frames, closed } = await raw(server.endpoint);
    socket.write(encodeJsonFrame({ t: "hello", pad: "x".repeat(5_000) }));
    await closed;
    expect(frames).toEqual([]);
  });

  it("closes a connection that does not finish the handshake within 5 s", async () => {
    const { runDirectory } = await fixture();
    const clock = fakeClock();
    const server = await start(runDirectory, { deps: { ...nodeControlDeps(), clock } });
    const before = clock.timers.length;
    const { frames, closed } = await raw(server.endpoint);
    await until(() => clock.timers.length === before + 1);
    const timer = clock.timers[before];
    expect(timer?.ms).toBe(HANDSHAKE_TIMEOUT_MS);
    expect(HANDSHAKE_TIMEOUT_MS).toBe(5_000);
    timer?.fire();
    await closed;
    expect(frames).toEqual([]);
  });

  it("refuses a 17th connection that has not finished the handshake", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const waiting: Raw[] = [];
    for (let i = 0; i < 16; i++) waiting.push(await raw(server.endpoint));
    const extra = await raw(server.endpoint);
    await extra.closed;
    expect(waiting.every((c) => !c.isClosed())).toBe(true);
    // An authenticated client is not held back by the cap once one leaves.
    waiting[0]?.socket.destroy();
    await waiting[0]?.closed;
    await new Promise((r) => setTimeout(r, 100));
    const c = await client(runDirectory);
    await expect(c.invoke("test:echo", [])).resolves.toEqual({ channel: "test:echo", args: [] });
  });

  it("answers a build mismatch with restart-required", async () => {
    const { runDirectory } = await fixture();
    await start(runDirectory, { build: "build-new" });
    const failure = await client(runDirectory, "build-old").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ControlRestartRequired);
    expect((failure as ControlRestartRequired).build).toBe("build-new");
  });

  it("answers a protocol version mismatch with restart-required, but only after the proof", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const secret = await readFile(controlPaths(PLATFORM, runDirectory).secretPath, "utf8");
    const { connection } = await handshake(server.endpoint, secret, {
      v: CONTROL_PROTOCOL_VERSION + 1,
    });
    await connection.closed;
    expect(connection.frames.map((f) => (f as { value: { t: string } }).value.t)).toEqual([
      "challenge",
      "restart-required",
    ]);
  });

  // Review C1: a daemon of another build must still be stoppable without a
  // service manager (Windows, a foreground `jarvisd run`), or an update
  // leaves the app facing a daemon it can neither use nor stop.
  it("stops a daemon of another build when the hello says intent stop", async () => {
    const { runDirectory } = await fixture();
    let stops = 0;
    await start(runDirectory, {
      build: "build-new",
      handlers: { ...echoHandlers, stop: () => void stops++ },
    });
    await requestControlStop({
      platform: PLATFORM,
      runDirectory,
      build: "build-old",
      deps: nodeControlDeps(),
    });
    expect(stops).toBe(1);
    // A plain hello from the same old build is still told to restart.
    await expect(client(runDirectory, "build-old")).rejects.toBeInstanceOf(ControlRestartRequired);
    expect(stops).toBe(1);
  });

  it("stops across a protocol version mismatch too, answering stopping and nothing else", async () => {
    const { runDirectory } = await fixture();
    let stops = 0;
    const server = await start(runDirectory, {
      handlers: { ...echoHandlers, stop: () => void stops++ },
    });
    const secret = await readFile(controlPaths(PLATFORM, runDirectory).secretPath, "utf8");
    const { connection } = await handshake(server.endpoint, secret, {
      v: CONTROL_PROTOCOL_VERSION + 1,
      build: "another",
      intent: "stop",
    });
    await connection.closed;
    expect(connection.frames.map((f) => (f as { value: { t: string } }).value.t)).toEqual([
      "challenge",
      "stopping",
    ]);
    expect(stops).toBe(1);
  });

  it("stops nothing for an intent-stop hello with a wrong proof, or an unknown intent", async () => {
    const { runDirectory } = await fixture();
    let stops = 0;
    const server = await start(runDirectory, {
      handlers: { ...echoHandlers, stop: () => void stops++ },
    });
    const secret = await readFile(controlPaths(PLATFORM, runDirectory).secretPath, "utf8");
    const wrong = await handshake(server.endpoint, secret, {
      intent: "stop",
      proof: () => "00".repeat(32),
    });
    await wrong.connection.closed;
    expect(wrong.connection.frames).toHaveLength(1);

    const odd = await raw(server.endpoint);
    odd.socket.write(
      encodeJsonFrame({
        t: "hello",
        v: CONTROL_PROTOCOL_VERSION,
        build: "build-1",
        nonceC: randomBytes(32).toString("hex"),
        intent: "restart",
      }),
    );
    await odd.closed;
    expect(odd.frames).toEqual([]);
    expect(stops).toBe(0);
  });

  it("round-trips a 16 MiB blob", async () => {
    const { runDirectory } = await fixture();
    await start(runDirectory);
    const c = await client(runDirectory);
    const bytes = randomBytes(16 * 1024 * 1024);
    await expect(c.upload("test:upload", ["name.bin"], bytes)).resolves.toEqual({
      channel: "test:upload",
      args: ["name.bin"],
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await expect(c.invoke("test:echo", [])).resolves.toEqual({ channel: "test:echo", args: [] });
  });

  it("delivers 1000 pushes to every client in order", async () => {
    const { runDirectory } = await fixture();
    const server = await start(runDirectory);
    const a = await client(runDirectory);
    const b = await client(runDirectory);
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

  it("tells a second server the daemon is busy and keeps serving", async () => {
    const { runDirectory } = await fixture();
    await start(runDirectory);
    const secretPath = controlPaths(PLATFORM, runDirectory).secretPath;
    const secretBefore = await readFile(secretPath, "utf8");
    await expect(startRaw(runDirectory)).resolves.toEqual({ kind: "busy" });
    expect(await readFile(secretPath, "utf8")).toBe(secretBefore);
    const c = await client(runDirectory);
    await expect(c.invoke("test:echo", [])).resolves.toEqual({ channel: "test:echo", args: [] });
  });

  it("lets a client that connects the moment the endpoint appears authenticate", async () => {
    const { runDirectory } = await fixture();
    const starting = startRaw(runDirectory);
    let connected: ControlClient | undefined;
    for (let i = 0; i < 2000 && connected === undefined; i++) {
      try {
        connected = await connectControl({
          platform: PLATFORM,
          runDirectory,
          build: "build-1",
          deps: nodeControlDeps(),
        });
      } catch (error) {
        // Only "not there yet" is allowed; a stale or missing secret would
        // surface as a refused handshake instead.
        expect((error as { code?: string }).code).toMatch(/^(ENOENT|ECONNREFUSED)$/);
        await new Promise((r) => setTimeout(r, 1));
      }
    }
    const started = await starting;
    if (started.kind !== "started") throw new Error("expected the lock");
    cleanups.push(() => started.server.close());
    if (connected === undefined) throw new Error("never connected");
    cleanups.push(() => connected?.close());
    await expect(connected.invoke("test:echo", [])).resolves.toEqual({
      channel: "test:echo",
      args: [],
    });
  });

  it("writes a fresh 32-byte hex secret on every start", async () => {
    const { runDirectory } = await fixture();
    const secretPath = controlPaths(PLATFORM, runDirectory).secretPath;
    const first = await start(runDirectory);
    const one = await readFile(secretPath, "utf8");
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    await first.close();
    await start(runDirectory);
    const two = await readFile(secretPath, "utf8");
    expect(two).toMatch(/^[0-9a-f]{64}$/);
    expect(two).not.toBe(one);
  });

  it("holds a pid lock while running and releases it on close", async () => {
    const { runDirectory } = await fixture();
    const pidPath = controlPaths(PLATFORM, runDirectory).pidPath;
    const server = await start(runDirectory);
    expect(await readFile(pidPath, "utf8")).toMatch(new RegExp(`^${process.pid}:[0-9a-f]+$`));
    await server.close();
    await expect(stat(pidPath)).rejects.toThrow();
  });

  async function preparedRunDirectory(): Promise<{ runDirectory: string; pidPath: string }> {
    const { runDirectory } = await fixture();
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await chmod(runDirectory, 0o700);
    return { runDirectory, pidPath: controlPaths(PLATFORM, runDirectory).pidPath };
  }

  it("takes over the pid lock of a dead daemon", async () => {
    const { runDirectory, pidPath } = await preparedRunDirectory();
    await writeFile(pidPath, String(await killedChildPid()));
    await start(runDirectory);
    expect(await readFile(pidPath, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
  });

  it("takes over a live unrelated pid when no endpoint answers (pid reuse after a crash)", async () => {
    const { runDirectory, pidPath } = await preparedRunDirectory();
    await writeFile(pidPath, String(process.ppid));
    await start(runDirectory, { deps: graceDeps() });
    expect(await readFile(pidPath, "utf8")).toMatch(new RegExp(`^${process.pid}:`));
  });

  it("treats this process's own pid left in the file as stale", async () => {
    const { runDirectory, pidPath } = await preparedRunDirectory();
    await writeFile(pidPath, `${process.pid}:from-an-earlier-boot`);
    await start(runDirectory);
    expect(await readFile(pidPath, "utf8")).toMatch(new RegExp(`^${process.pid}:[0-9a-f]+$`));
  });

  it.skipIf(WINDOWS)("stays busy for a live pid whose endpoint answers", async () => {
    const { runDirectory, pidPath } = await preparedRunDirectory();
    await writeFile(pidPath, String(process.ppid));
    const other = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) =>
      other.listen(controlPaths(PLATFORM, runDirectory).socketPath, resolve),
    );
    cleanups.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
    await expect(startRaw(runDirectory, { deps: graceDeps() })).resolves.toEqual({ kind: "busy" });
    expect(await readFile(pidPath, "utf8")).toBe(String(process.ppid));
  });

  it.skipIf(WINDOWS)(
    "leaves the secret it found in place when another process binds the endpoint first",
    async () => {
      const { runDirectory, pidPath } = await preparedRunDirectory();
      const paths = controlPaths(PLATFORM, runDirectory);
      await writeFile(paths.secretPath, "a".repeat(64), { mode: 0o600 });
      const real = nodeControlDeps();
      const foreign = createServer((socket) => socket.destroy());
      cleanups.push(() => new Promise<void>((resolve) => foreign.close(() => resolve())));
      // A process that ignores the pid lock binds the path between our probe
      // and our listen, so our listen() meets EADDRINUSE.
      const deps: ControlDeps = {
        ...real,
        net: {
          ...real.net,
          createServer(onConnection) {
            const server = real.net.createServer(onConnection);
            const listen = server.listen.bind(server) as (path: string) => unknown;
            (server as unknown as { listen: (path: string) => unknown }).listen = (path) => {
              foreign.listen(path, () => listen(path));
              return server;
            };
            return server;
          },
        },
      };
      await expect(startRaw(runDirectory, { deps })).resolves.toEqual({ kind: "busy" });
      expect(await readFile(paths.secretPath, "utf8")).toBe("a".repeat(64));
      await expect(stat(pidPath)).rejects.toThrow();
    },
  );

  it.skipIf(WINDOWS)("keeps the secret 0600, the socket 0600 and the run dir 0700", async () => {
    const { runDirectory } = await fixture();
    const paths = controlPaths(PLATFORM, runDirectory);
    await start(runDirectory);
    expect((await stat(paths.secretPath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(runDirectory)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(WINDOWS)("recovers a stale socket left by a killed daemon", async () => {
    const { runDirectory } = await fixture();
    await staleSocket(runDirectory);
    await start(runDirectory);
    const c = await client(runDirectory);
    await expect(c.invoke("test:echo", [])).resolves.toEqual({ channel: "test:echo", args: [] });
  });

  it.skipIf(WINDOWS)(
    "lets exactly one of two racing daemons take over a stale socket",
    async () => {
      const { runDirectory } = await fixture();
      await staleSocket(runDirectory);
      const results = await Promise.all([startRaw(runDirectory), startRaw(runDirectory)]);
      for (const result of results) {
        if (result.kind === "started") cleanups.push(() => result.server.close());
      }
      expect(results.map((r) => r.kind).sort()).toEqual(["busy", "started"]);
      const c = await client(runDirectory);
      await expect(c.invoke("test:echo", [])).resolves.toEqual({ channel: "test:echo", args: [] });
    },
  );

  it.skipIf(WINDOWS)("refuses to unlink a non-socket file at the endpoint", async () => {
    const { runDirectory } = await fixture();
    const socketPath = controlPaths(PLATFORM, runDirectory).socketPath;
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await chmod(runDirectory, 0o700);
    await writeFile(socketPath, "not a socket");
    await expect(startRaw(runDirectory)).rejects.toThrow(/not a socket/);
    expect(await readFile(socketPath, "utf8")).toBe("not a socket");
    // A refused start leaves no pid lock behind.
    await expect(stat(controlPaths(PLATFORM, runDirectory).pidPath)).rejects.toThrow();
  });

  it.skipIf(WINDOWS)("refuses a run dir that is a symlink", async () => {
    const { dir, runDirectory } = await fixture();
    const real = join(dir, "elsewhere");
    await mkdir(real, { mode: 0o700 });
    await chmod(real, 0o700);
    await symlink(real, runDirectory);
    await expect(startRaw(runDirectory)).rejects.toThrow(/symlink/);
  });

  it.skipIf(WINDOWS)("refuses a run dir owned by another user", async () => {
    const { runDirectory } = await fixture();
    await mkdir(runDirectory, { mode: 0o700 });
    await chmod(runDirectory, 0o700);
    const real = nodeControlDeps();
    const deps: ControlDeps = {
      ...real,
      process: { ...real.process, uid: () => (process.getuid?.() ?? 0) + 1 },
    };
    await expect(startRaw(runDirectory, { deps })).rejects.toThrow(/owned/);
  });

  it.skipIf(WINDOWS)("refuses a run dir other users can read", async () => {
    const { runDirectory } = await fixture();
    await mkdir(runDirectory);
    await chmod(runDirectory, 0o755);
    await expect(startRaw(runDirectory)).rejects.toThrow(/0700/);
  });

  it("rejects pending requests when the server goes away", async () => {
    const { runDirectory } = await fixture();
    let release: () => void = () => {};
    const server = await start(runDirectory, {
      handlers: {
        ...echoHandlers,
        invoke: () => new Promise((resolve) => (release = () => resolve(null))),
      },
    });
    const c = await client(runDirectory);
    let closed = false;
    c.onClose(() => (closed = true));
    // Caught up front: the rejection lands during close(), before any await below.
    const pending = c.invoke("test:hang", []).catch((e: unknown) => e);
    await server.close();
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(closed).toBe(true);
  });
});
