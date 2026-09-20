// The one real-network test in this package (global constraints): a real
// `createBridge` wired to the real TLS listener (server.ts), the real
// filesystem (node-io.ts) under a throwaway temp directory, and a real
// self-signed certificate (certificate.ts) — driven entirely from
// `127.0.0.1` port `0` by the pinned probe client (probe-client.ts), the
// same client `scripts/remote-probe.mjs` uses for a manual pass. Every
// other test in this package injects the clock, the CSPRNG, the filesystem
// and the socket; this is the one place all four are real, which is
// exactly why there is only one of it.

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { setImmediate as yieldToLoop, setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bridge, RemoteStatus } from "./bridge.js";
import { createBridge } from "./bridge.js";
import { loadCertificate } from "./certificate.js";
import { nodeFs, nodeTimers } from "./node-io.js";
import { OUTBOX_TICK_MS } from "./outbox.js";
import { STREAM_MAX_BYTES, utf8Bytes } from "./policy.js";
import type { ChannelPolicies, ChannelPolicy, StreamPolicy } from "./policy.js";
import type { DeviceSession } from "./probe-client.js";
import { connectDevice, openPinned, pairDevice, socketUrl } from "./probe-client.js";
import {
  CLOSE,
  encodeMessage,
  type PairingLink,
  parsePairingUri,
  PROTOCOL_VERSION,
} from "./protocol.js";
import { listenTls } from "./server.js";

type StreamPayload = { key?: string; chunk: string; offset?: number };

/** `test:stream`'s policy: the wire codec `{key, chunk, offset}` the flood test round-trips. */
const testStreamPolicy: StreamPolicy = {
  kind: "stream",
  maxBytes: STREAM_MAX_BYTES,
  keyOf: (p) => (p as StreamPayload).key,
  chunkOf: (p) => (p as StreamPayload).chunk,
  offsetOf: (p) => (p as StreamPayload).offset,
  withChunk: (payload, chunk, offset) => {
    const { key } = payload as StreamPayload;
    const result: StreamPayload = { chunk };
    if (key !== undefined) result.key = key;
    if (offset !== undefined) result.offset = offset;
    return result;
  },
};

const TEST_POLICIES: ChannelPolicies = new Map<string, ChannelPolicy>([
  ["metrics:update", { kind: "latest" }],
  ["test:stream", testStreamPolicy],
]);

const ENFORCE_FILE_MODES = process.platform !== "win32";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** node:fs/promises' stat, narrowed to the POSIX permission bits — meaningless on win32, where callers skip it. */
async function modeOf(path: string): Promise<number> {
  const info = await stat(path);
  return info.mode & 0o777;
}

/** A bare TLS connection to the bridge, verification off — the raw pre-auth probes below speak HTTP over it directly, never through `ws`. */
function rawConnect(host: string, port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host, port, rejectUnauthorized: false, minVersion: "TLSv1.3" },
      () => {
        socket.off("error", reject);
        resolve(socket);
      },
    );
    socket.once("error", reject);
  });
}

/**
 * Connects, writes `bytes`, and reports how many bytes came back and
 * whether the server actually closed the socket within a 500ms grace
 * period — "no banner before auth" (rule 3) means exactly zero bytes *and*
 * a real close, for garbage, for `Expect: 100-continue`, and for a
 * malformed upgrade alike. Checking only the byte count would pass just as
 * well for a socket Node left hanging open forever (registering an empty
 * `clientError` listener suppresses Node's own default 400 *without*
 * destroying the socket) — that is not "the wire goes dead", so both are
 * asserted.
 */
async function probeUnauthenticated(
  host: string,
  port: number,
  bytes: string,
): Promise<{ received: number; closed: boolean }> {
  const socket = await rawConnect(host, port);
  let received = 0;
  socket.on("data", (chunk: Buffer) => {
    received += chunk.length;
  });
  socket.write(bytes);
  const closed = await new Promise<boolean>((resolve) => {
    socket.once("close", () => resolve(true));
    setTimeout(() => resolve(false), 500).unref();
  });
  socket.destroy();
  return { received, closed };
}

describe("bridge.integration", () => {
  let dir: string;
  let bridge: Bridge;
  let handleCalls = 0;
  let lastDeviceId: string | undefined;
  const uploadedBlobs: Uint8Array[] = [];
  let link: PairingLink;
  let credential: { deviceId: string; token: string };
  let session: DeviceSession;
  // Every status this bridge ever emits, so the "confirming" window
  // `pairDevice` produces can be asserted on after the fact rather than
  // raced against — `onStatus` below both auto-approves and records.
  const statusLog: RemoteStatus[] = [];
  // A spy, not a no-op (Task 4: server.ts now reports a post-listen
  // `error` through this) — every M4 case below still passes unchanged.
  const logLines: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-remote-"));
    const random = (size: number) => randomBytes(size);

    bridge = await createBridge({
      dir,
      fs: nodeFs,
      random,
      now: Date.now,
      timers: nodeTimers,
      listen: listenTls,
      loadCertificate: (config) =>
        loadCertificate(config, {
          fs: nodeFs,
          dir,
          random,
          now: Date.now,
          enforceFileModes: ENFORCE_FILE_MODES,
        }),
      // The sidecar proxy itself is proxy.integration.test.ts's job (a
      // second, dedicated real-network file, per the global constraints);
      // this bridge only needs to prove it never wires one in when the gate
      // is off, which every case here already is (sidecarProxy stays false
      // below).
      createProxy: () => undefined,
      handle: async (channel, _args, device, blob) => {
        handleCalls += 1;
        lastDeviceId = device.id;
        if (channel === "projects:list") return { kind: "value", value: ["alpha", "beta"] };
        if (channel === "remote:bindChoices") return { kind: "forbidden" };
        if (channel === "test:blob") {
          uploadedBlobs.push(blob ?? new Uint8Array());
          return { kind: "value", value: { sha256: sha256Hex(blob ?? new Uint8Array()) } };
        }
        return { kind: "unknown-channel" };
      },
      policies: TEST_POLICIES,
      // Only ("test:stream", "pane-1") is ever authorised — the flood test's
      // "pane-2" subscription is accepted by the sub frame's own bounds
      // (Task 3) but never granted, so no push for it can ever be delivered.
      authorizeKey: (channel, key) => channel === "test:stream" && key === "pane-1",
      // Only "test:blob" ever accepts a blob, capped at 1 MiB — every other
      // channel is refused unknown-channel, same as M4-M7's blanket refusal.
      blobLimit: (channel) => (channel === "test:blob" ? 1_048_576 : undefined),
      errorText: (code) => ({ text: `err:${code}`, language: "en" }),
      auditPolicy: () => "never",
      enforceFileModes: ENFORCE_FILE_MODES,
      log: (line) => {
        logLines.push(line);
      },
      onDeviceDisconnected: () => {},
      onStatus(status: RemoteStatus) {
        statusLog.push(status);
        // The second human step, played automatically: a real confirmation
        // prompt is Settings' job, not this test's.
        if (status.pairing.kind === "confirming") {
          bridge.decidePairing(status.pairing.requestId, true);
        }
      },
    });

    await bridge.apply({
      enabled: true,
      bindAddress: "127.0.0.1",
      port: 0,
      sidecarProxy: false,
      tls: {},
    });
  });

  afterAll(async () => {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("zero devices: status().listening is undefined", () => {
    expect(bridge.status().listening).toBeUndefined();
  });

  it("openPairing opens the listener on 127.0.0.1", async () => {
    const result = await bridge.openPairing();
    expect(result).toBe("opened");
    expect(bridge.status().listening?.host).toBe("127.0.0.1");

    const pairingStatus = bridge.status().pairing;
    if (pairingStatus.kind !== "open") {
      throw new Error(`expected an open pairing window, got ${pairingStatus.kind}`);
    }
    const parsed = parsePairingUri(pairingStatus.uri);
    if (parsed === undefined) throw new Error("pairing URI failed to parse");
    link = parsed;
  });

  it("[bite-proof: TLS 1.3 only] a TLS 1.2 client is refused", async () => {
    await expect(
      openPinned(socketUrl(link, "/rpc"), link.fingerprint, { maxVersion: "TLSv1.2" }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("a wrong pin is refused with a fingerprint mismatch", async () => {
    await expect(openPinned(socketUrl(link, "/rpc"), "0".repeat(64))).rejects.toThrow(
      /fingerprint/,
    );
  });

  it("an unknown upgrade path is refused", async () => {
    const url = `wss://${link.host}:${link.port}/other`;
    await expect(openPinned(url, link.fingerprint)).rejects.toBeInstanceOf(Error);
  });

  it("garbage bytes after the TLS handshake get zero bytes back and the socket closes", async () => {
    const result = await probeUnauthenticated(link.host, link.port, "NOT AN HTTP REQUEST\r\n\r\n");
    expect(result).toEqual({ received: 0, closed: true });
  });

  it("an Expect: 100-continue request gets zero bytes back, not a 100 Continue, and closes", async () => {
    const request =
      "GET /rpc HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n";
    const result = await probeUnauthenticated(link.host, link.port, request);
    expect(result).toEqual({ received: 0, closed: true });
  });

  it("a malformed upgrade on /rpc gets zero bytes back, not ws's own 400/426, and closes", async () => {
    const request = [
      "GET /rpc HTTP/1.1",
      "Host: x",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      // Not the base64 of 16 bytes — malformed, not merely absent.
      "Sec-WebSocket-Key: not-a-valid-key",
      "\r\n",
    ].join("\r\n");
    const result = await probeUnauthenticated(link.host, link.port, request);
    expect(result).toEqual({ received: 0, closed: true });
  });

  it("pairDevice mints a credential, shows confirming, and touches only 0600/0700 files", async () => {
    credential = await pairDevice(link, "Integration probe");
    expect(credential.deviceId).toMatch(/^[0-9a-f]{32}$/);

    const confirming = statusLog.find(
      (status) =>
        status.pairing.kind === "confirming" && status.pairing.deviceName === "Integration probe",
    );
    expect(confirming).toBeDefined();

    const devicesText = await readFile(join(dir, "devices.json"), "utf8");
    expect(devicesText).toContain("Integration probe");

    if (ENFORCE_FILE_MODES) {
      expect(await modeOf(dir)).toBe(0o700);
      expect(await modeOf(join(dir, "devices.json"))).toBe(0o600);
      expect(await modeOf(join(dir, "key.pem"))).toBe(0o600);
      expect(await modeOf(join(dir, "cert.pem"))).toBe(0o600);
      expect(await modeOf(join(dir, "audit.log"))).toBe(0o600);
    }

    const auditText = await readFile(join(dir, "audit.log"), "utf8");
    expect(auditText).not.toContain(credential.token);
    expect(auditText).not.toContain(link.secret);
  });

  it("[bite-proof: reused secret] replaying the pairing secret is refused with 4401", async () => {
    await expect(pairDevice(link, "Replay")).rejects.toMatchObject({
      code: CLOSE.unauthorized,
    });
    // That refusal counts as a real auth failure against this source (the
    // real per-source backoff, `limits.ts`), which would otherwise close
    // the very next connection with 4429 before it ever gets a hello in —
    // real time is the only clock this one real-network test has, so it
    // waits the real 1s backoff out rather than racing it.
    await delay(1_100);
  });

  it("connectDevice welcomes with the subscribable capabilities and calls/pushes round-trip", async () => {
    session = await connectDevice(link, credential);
    expect(session.welcome.capabilities).toEqual(["metrics:update", "test:stream"]);

    const res = await session.call("projects:list");
    expect(res).toMatchObject({ t: "res", v: ["alpha", "beta"] });

    session.subscribe(["metrics:update"]);
    // A round-tripped call, to prove the connection is still live after
    // subscribing before the push below is trusted to mean anything.
    await session.call("projects:list");

    bridge.push("metrics:update", { cpuPercent: 7 });
    const pushed = await session.nextPush("metrics:update", 5_000);
    expect(pushed.p).toEqual({ cpuPercent: 7 });
  });

  it("[bite-proof: remove the per-key cap in outbox.ts; the dropped row fails or the test times out] " +
    "a paused client under a 64 MiB flood gets a bounded, contiguous pane-1 stream and never sees pane-2", async () => {
    session.subscribe([
      { ch: "test:stream", key: "pane-1" },
      { ch: "test:stream", key: "pane-2" },
    ]);
    // Round-tripped so the sub above is applied before the flood starts.
    await session.call("projects:list");

    const CHUNK_BYTES = 16 * 1024;
    const TOTAL_BYTES = 64 * 1024 * 1024;
    const CHUNK_COUNT = TOTAL_BYTES / CHUNK_BYTES;
    const YIELD_EVERY = 64;
    const WAIT_TIMEOUT_MS = 10_000;
    const chunkText = "a".repeat(CHUNK_BYTES);

    session.pauseReading();
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const offset = i * CHUNK_BYTES;
      bridge.push("test:stream", { key: "pane-1", chunk: chunkText, offset });
      bridge.push("test:stream", { key: "pane-2", chunk: chunkText, offset });
      if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToLoop();
    }
    // Task 6 rule 6: dwell paused for a few real outbox ticks before
    // resuming, so the pause itself is *observed* — nothing decoded
    // client-side while genuinely paused — rather than only inferred
    // afterward from the dropped-byte assertions below. `ws.pause()`
    // (session.pauseReading) stops this process's socket from emitting
    // `message` events at all, so `pushes()` staying empty here is direct
    // evidence the pause held through several of the server's own 50ms
    // outbox ticks, not just that resuming eventually produced a dropped
    // row.
    await delay(3 * OUTBOX_TICK_MS);
    expect(session.pushes("test:stream")).toHaveLength(0);
    session.resumeReading();

    let sumChunkBytes = 0;
    let sumDropped = 0;
    let sawDropped = false;
    let complete = false;
    let frameCount = 0;
    while (!complete) {
      const push = await session.nextPush("test:stream", WAIT_TIMEOUT_MS);
      frameCount++;
      const payload = push.p as StreamPayload;
      expect(payload.key).toBe("pane-1"); // pane-2 is never authorised — see below
      sumChunkBytes += utf8Bytes(payload.chunk);
      const dropped = typeof push.dropped === "number" ? push.dropped : 0;
      sumDropped += dropped;
      if (dropped > 0) sawDropped = true;
      const offset = payload.offset ?? 0;
      if (offset + payload.chunk.length === TOTAL_BYTES) complete = true;
    }
    // The flood's duration used to be console.log-ed here for the task
    // brief; that is test noise on every run (final-review Minor 7). The
    // measured duration lives in final-fix-report.md instead of stdout —
    // no assertion pins it down, since a timing assertion here would only
    // ever be a sanity ceiling (global constraints), never a bite-proof.

    expect(sumChunkBytes + sumDropped).toBe(TOTAL_BYTES);
    expect(sawDropped).toBe(true);
    // Task 6 rule 6, "structural piece bound": CHUNK_COUNT (4096) pushes
    // were sent for pane-1 alone, but the outbox coalesces same-key
    // contiguous chunks into far fewer frames per flush — this is a
    // structural bound on frame count, not just the byte-level ceiling
    // `sumChunkBytes + sumDropped` already proves.
    expect(frameCount).toBeLessThan(CHUNK_COUNT / 4);

    const pane2Pushes = session.pushes("test:stream").filter((entry) => {
      const payload = entry.p as StreamPayload;
      return payload.key === "pane-2";
    });
    expect(pane2Pushes).toHaveLength(0);

    const res = await session.call("projects:list");
    expect(res).toMatchObject({ t: "res" });
  }, 30_000);

  it("[bite-proof: wrong token dispatches nothing] a flipped token is refused with 4401 and never reaches handle", async () => {
    const before = handleCalls;
    const flipped = {
      deviceId: credential.deviceId,
      token: `${credential.token.slice(0, -1)}${credential.token.endsWith("a") ? "b" : "a"}`,
    };
    await expect(connectDevice(link, flipped)).rejects.toMatchObject({ code: CLOSE.unauthorized });
    expect(handleCalls).toBe(before);
  });

  it("[bite-proof: denied channel] remote:bindChoices is forbidden", async () => {
    const res = await session.call("remote:bindChoices");
    expect(res).toMatchObject({ t: "err", code: "forbidden" });
  });

  it("upload('test:blob', ['x'], <600 KiB random>) resolves res, and the handler's bytes share the same SHA-256", async () => {
    const bytes = randomBytes(600 * 1024);
    const before = uploadedBlobs.length;

    const res = await session.upload("test:blob", ["x"], bytes);

    expect(res).toMatchObject({ t: "res" });
    expect(uploadedBlobs).toHaveLength(before + 1);
    const received = uploadedBlobs[before] as Uint8Array;
    expect(sha256Hex(received)).toBe(sha256Hex(bytes));
    expect((res as { v?: { sha256?: unknown } }).v?.sha256).toBe(sha256Hex(bytes));
  });

  it("upload('nope:ch', [], <10 KiB>) answers err unknown-channel, and a following call still answers", async () => {
    const bytes = randomBytes(10 * 1024);

    const res = await session.upload("nope:ch", [], bytes);
    expect(res).toMatchObject({ t: "err", code: "unknown-channel" });

    const followUp = await session.call("projects:list");
    expect(followUp).toMatchObject({ t: "res", v: ["alpha", "beta"] });
  });

  it("[bite-proof: the binary cap is enforced twice] a single 1.1 MiB binary frame closes the socket 1009", async () => {
    // A raw pinned socket, not connectDevice: ws's own `maxPayload` (server.ts)
    // must refuse this before connection.ts ever sees a `blob` header at
    // all — welcoming it first (below) just proves the socket is otherwise
    // healthy, so the close that follows is really this cap and not some
    // other handshake failure.
    // The previous test's flipped token counts as a real auth failure
    // against this source (the real per-source backoff, limits.ts), which
    // would otherwise refuse this connection's hello with 4429 before it
    // ever reaches the check this test is after — the same wait the
    // "reused secret" test above needs for the same reason.
    await delay(1_100);

    const ws = await openPinned(socketUrl(link, "/rpc"), link.fingerprint);
    const welcomed = new Promise<void>((resolve) => {
      ws.on("message", (data: Buffer) => {
        const parsed = JSON.parse(data.toString("utf8")) as { t?: string };
        if (parsed.t === "welcome") resolve();
      });
    });
    ws.send(
      encodeMessage({
        t: "hello",
        v: PROTOCOL_VERSION,
        deviceId: credential.deviceId,
        token: credential.token,
        client: "test/1.0",
      }),
    );
    await welcomed;

    const closedCode = new Promise<number>((resolve) => {
      ws.once("close", (code: number) => resolve(code));
    });
    const oversized = Buffer.alloc(Math.floor(1.1 * 1024 * 1024), 7);
    ws.send(oversized, { binary: true });

    expect(await closedCode).toBe(1009);
  }, 10_000);

  it("[bite-proof: revocation] revoke closes the live session with 4410 and closes the listener", async () => {
    const deviceId = lastDeviceId ?? credential.deviceId;
    const revoked = await bridge.revoke(deviceId);
    expect(revoked).toBe(true);

    const code = await session.closed;
    expect(code).toBe(CLOSE.revoked);

    expect(bridge.status().listening).toBeUndefined();

    await expect(
      openPinned(socketUrl(link, "/rpc"), link.fingerprint, { timeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(Error);
  });
});
