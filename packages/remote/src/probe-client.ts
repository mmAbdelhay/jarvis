// A pinned `ws` client for the bridge — the one piece of this package that
// plays the *phone's* side of the protocol rather than the laptop's. Two
// callers: `bridge.integration.test.ts` (the only real-network test in this
// package) and `scripts/remote-probe.mjs` (a manual-pass CLI). Neither is
// reachable from `@jarvis/remote`'s main entry — only `listen.ts` and this
// file's own direct importers ever load it.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { isIpLiteral, isLoopback, renderChunk } from "@jarvis/wire";
import { WebSocket } from "ws";
import { isSubscriptionKey, utf8Bytes } from "./policy.js";
import type { PairingLink, SubTarget } from "./protocol.js";
import {
  encodeMessage,
  MAX_BLOB_CHUNK_BYTES,
  parsePairingUri,
  PROTOCOL_VERSION,
} from "./protocol.js";

// Re-exported for probe-client.test.ts and any other caller that imported
// these from this module before they moved to @jarvis/wire (M6 ruling 4).
export { isIpLiteral, isLoopback, renderChunk };

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_PAIR_TIMEOUT_MS = 90_000; // a human approves
const DEFAULT_PUSH_TIMEOUT_MS = 5_000;
const DEFAULT_WELCOME_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const TERMINAL_LOG_INTERVAL_MS = 1_000;
const TERMINAL_POLL_MS = 25;
/**
 * M5 Minor 5 (Task 6): `pushLog` and `pushQueues` (below, inside
 * `connectDevice`) never forgot a push either had ever received — fine for
 * the M4 checks' handful of frames, but a `--terminal` pass can run for as
 * long as a pane stays open, and `runTerminalProbe`'s poll loop calls
 * `pushes()` (a copy of `pushLog`) every `TERMINAL_POLL_MS` regardless
 * while never draining `pushQueues` at all (it reads through `pushes()`,
 * not `nextPush()`). Left unbounded, both grow with the session's whole
 * lifetime instead of staying a small, constant-size window — retaining
 * only the most recent `PROBE_PUSH_WINDOW` pushes per channel (oldest
 * evicted) in *both* structures is what keeps a long session bounded
 * rather than an ever-growing full history. This applies to **every**
 * `connectDevice` session, not only a `--terminal` one — an M4-only caller
 * that never accumulates anywhere near this many pushes per channel simply
 * never notices the cap.
 */
export const PROBE_PUSH_WINDOW = 1_000;
const TERMINAL_USAGE =
  "usage: remote-probe.mjs <uri> [--host ADDR] [--name NAME] [--terminal PANEKEY] [--allow-non-loopback] [--hold]";

export type Credential = { deviceId: string; token: string };

export class ProbeClosedError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`the socket closed with code ${code}`);
    this.name = "ProbeClosedError";
    this.code = code;
  }
}

/** A `TLSSocket`'s one field this module reads — the peer certificate `openPinned` pins against. */
type PeerCertSocket = { getPeerCertificate?(): { raw?: Buffer } | undefined };

/** Brackets an IPv6 literal for a URL authority (`[::1]`), percent-encoding a zone id's `%` as `%25`. IPv4 passes through unchanged. */
function bracketHost(host: string): string {
  if (!host.includes(":")) return host;
  const percentAt = host.indexOf("%");
  if (percentAt === -1) return `[${host}]`;
  return `[${host.slice(0, percentAt)}%25${host.slice(percentAt + 1)}]`;
}

export function socketUrl(
  link: Pick<PairingLink, "host" | "port">,
  path: "/rpc" | "/pair",
): string {
  return `wss://${bracketHost(link.host)}:${link.port}${path}`;
}

/**
 * Opens a `wss://` socket that trusts nothing but `fingerprint` (ruling 24):
 * TLS verification itself is off (`rejectUnauthorized: false` — a
 * self-signed certificate never passes it), so the only thing standing
 * between this client and an impostor is the SHA-256 pin checked on
 * `upgrade`, before any frame is ever sent. A mismatch terminates the
 * socket and rejects with a message matching `/fingerprint/`; the promise
 * resolves on `open` only once the pin has already matched.
 */
export function openPinned(
  url: string,
  fingerprint: string,
  options: { timeoutMs?: number; maxVersion?: "TLSv1.2" | "TLSv1.3" } = {},
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pinned = false;

    function settleReject(error: Error): void {
      if (settled) return;
      settled = true;
      reject(error);
    }

    // By default the client speaks only TLS 1.3, same as the server. A
    // caller proving the server's "TLS 1.3 only" guard (ruling: minVersion
    // TLSv1.3) passes `maxVersion: "TLSv1.2"` to get a client that *only*
    // speaks up to 1.2 — min and max pinned to the same ceiling, not just
    // the max, or a client whose own minVersion stayed at 1.3 would refuse
    // to negotiate anything at all regardless of what the server allows,
    // and the bite-proof would prove nothing about the server's guard.
    const version = options.maxVersion ?? "TLSv1.3";
    const ws = new WebSocket(url, {
      rejectUnauthorized: false,
      minVersion: version,
      maxVersion: version,
      perMessageDeflate: false,
      handshakeTimeout: options.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    });

    ws.once("upgrade", (request: IncomingMessage) => {
      const socket = request.socket as unknown as PeerCertSocket;
      const raw = socket.getPeerCertificate?.()?.raw;
      const actual = raw !== undefined ? createHash("sha256").update(raw).digest("hex") : "";
      if (actual === fingerprint) {
        pinned = true;
        return;
      }
      ws.terminate();
      // The one place this module's rejection text says "fingerprint" —
      // every other pre-open failure below is a TLS/connection problem
      // that never got far enough to check a certificate at all, and must
      // not be mistaken for a pin mismatch by a caller matching on that word.
      settleReject(new Error(`fingerprint mismatch: expected ${fingerprint}, got ${actual}`));
    });

    ws.once("open", () => {
      if (!pinned || settled) return;
      settled = true;
      // The listener above is a `.once` — spent the instant it fires, if it
      // ever does. A persistent no-op safety net here is what stops a later
      // error on this now-caller-owned socket (pairDevice/connectDevice
      // hang on to it for a while) from crashing the process for want of
      // any `error` listener at all.
      ws.on("error", () => {});
      resolve(ws);
    });

    ws.once("error", (error: Error) => {
      if (pinned) {
        settleReject(error);
        return;
      }
      settleReject(new Error(`connection failed before open: ${error.message}`));
    });

    ws.once("close", (code: number) => {
      settleReject(new Error(`connection failed before open: socket closed (${code})`));
    });
  });
}

/**
 * Pins `/pair`, sends the one pairing frame, and waits for either the
 * `paired` frame (ruling: 90s default — a human approves) or a close,
 * which always means `ProbeClosedError`.
 */
export function pairDevice(
  link: PairingLink,
  deviceName: string,
  options: { timeoutMs?: number } = {},
): Promise<Credential> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS;
  return openPinned(socketUrl(link, "/pair"), link.fingerprint).then(
    (ws) =>
      new Promise<Credential>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.terminate();
          reject(new Error("pairDevice timed out waiting for approval"));
        }, timeoutMs);
        timer.unref?.();

        ws.once("close", (code: number) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          reject(new ProbeClosedError(code));
        });

        ws.on("message", (data: Buffer) => {
          if (settled) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString("utf8"));
          } catch {
            return;
          }
          const obj = parsed as Record<string, unknown>;
          if (
            obj.t === "paired" &&
            typeof obj.deviceId === "string" &&
            typeof obj.token === "string"
          ) {
            clearTimeout(timer);
            settled = true;
            ws.removeAllListeners("close");
            // The server closes this socket itself right after `paired`,
            // but a caller must not depend on that timing — close it from
            // this side too rather than leaving a socket this function is
            // done with lingering on whichever side gets there first.
            ws.close(1000, "paired");
            resolve({ deviceId: obj.deviceId, token: obj.token });
          }
        });

        ws.send(
          encodeMessage({
            t: "pair",
            v: PROTOCOL_VERSION,
            secret: link.secret,
            deviceName,
            client: "jarvis-probe",
          }),
        );
      }),
  );
}

export type DeviceSession = {
  welcome: { capabilities: string[] };
  closed: Promise<number>;
  call(channel: string, ...args: unknown[]): Promise<Record<string, unknown>>;
  /**
   * Sends a `blob` header for `bytes.length` bytes, then `bytes` split into
   * `chunkBytes`-sized binary frames (default `MAX_BLOB_CHUNK_BYTES`),
   * resolving on the matching `res`/`err` exactly like `call`.
   */
  upload(
    channel: string,
    args: unknown[],
    bytes: Uint8Array,
    chunkBytes?: number,
  ): Promise<Record<string, unknown>>;
  subscribe(targets: SubTarget[]): void;
  unsubscribe(targets: SubTarget[]): void;
  nextPush(channel: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Every push received so far for `channel`, in order — a copy, never consumed by `nextPush`. */
  pushes(channel: string): Record<string, unknown>[];
  /** `ws.pause()` — stops reading incoming frames, the client half of a real-socket backpressure test. */
  pauseReading(): void;
  /** `ws.resume()` — the counterpart to `pauseReading`. */
  resumeReading(): void;
  bye(): Promise<number>;
};

type PendingCall = { resolve(value: Record<string, unknown>): void; reject(error: unknown): void };
type PushWaiter = { resolve(value: Record<string, unknown>): void; reject(error: unknown): void };

/**
 * Pins `/rpc`, sends the hello, and resolves once `welcome` arrives (ruling:
 * a close before `welcome` is always `ProbeClosedError`). The resolved
 * session answers every `ping` with a `pong` on its own, correlates
 * `res`/`err` frames by id, and queues `psh` frames per channel so
 * `nextPush` can arrive either before or after a push already landed.
 */
export function connectDevice(
  link: PairingLink,
  credential: Credential,
  options: { timeoutMs?: number } = {},
): Promise<DeviceSession> {
  return openPinned(socketUrl(link, "/rpc"), link.fingerprint, {
    timeoutMs: options.timeoutMs,
  }).then(
    (ws) =>
      new Promise<DeviceSession>((resolve, reject) => {
        let welcomed = false;
        let nextId = 1;
        const pending = new Map<number, PendingCall>();
        const pushQueues = new Map<string, Record<string, unknown>[]>();
        const pushWaiters = new Map<string, PushWaiter[]>();
        // Every push ever received, per channel, never drained by
        // `nextPush` — `pushes()` returns a copy of this log.
        const pushLog = new Map<string, Record<string, unknown>[]>();

        let resolveClosed!: (code: number) => void;
        const closed = new Promise<number>((res) => {
          resolveClosed = res;
        });

        // A server that never answers the hello at all (not even a close)
        // must not hang this promise forever.
        const welcomeTimer = setTimeout(() => {
          if (welcomed) return;
          welcomed = true;
          ws.terminate();
          reject(new Error(`connectDevice timed out waiting for welcome`));
        }, options.timeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS);
        welcomeTimer.unref?.();

        ws.once("close", (code: number) => {
          clearTimeout(welcomeTimer);
          resolveClosed(code);
          if (!welcomed) {
            welcomed = true;
            reject(new ProbeClosedError(code));
          }
          for (const waiter of pending.values()) waiter.reject(new ProbeClosedError(code));
          pending.clear();
          // Same closed-error shape as pending calls: without this, a
          // close mid-`nextPush` left its waiter to fail only by its own
          // timeout, well after the close was already known.
          for (const waiters of pushWaiters.values()) {
            for (const waiter of waiters) waiter.reject(new ProbeClosedError(code));
          }
          pushWaiters.clear();
        });

        ws.on("message", (data: Buffer) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString("utf8"));
          } catch {
            return;
          }
          const obj = parsed as Record<string, unknown>;
          switch (obj.t) {
            case "welcome": {
              if (welcomed) return;
              welcomed = true;
              clearTimeout(welcomeTimer);
              const capabilities = Array.isArray(obj.capabilities)
                ? (obj.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
                : [];
              resolve(makeSession(capabilities));
              return;
            }
            case "ping": {
              const seq = typeof obj.seq === "number" ? obj.seq : 0;
              ws.send(encodeMessage({ t: "pong", seq }));
              return;
            }
            case "res":
            case "err": {
              const id = obj.id;
              if (typeof id !== "number") return;
              const waiter = pending.get(id);
              pending.delete(id);
              waiter?.resolve(obj);
              return;
            }
            case "psh": {
              const channel = obj.ch;
              if (typeof channel !== "string") return;
              const log = pushLog.get(channel) ?? [];
              log.push(obj);
              // Oldest evicted, one at a time — PROBE_PUSH_WINDOW is only
              // ever exceeded by exactly one entry per message received.
              if (log.length > PROBE_PUSH_WINDOW) log.shift();
              pushLog.set(channel, log);
              const waiters = pushWaiters.get(channel);
              const waiter = waiters?.shift();
              if (waiter !== undefined) {
                waiter.resolve(obj);
                return;
              }
              const queue = pushQueues.get(channel) ?? [];
              queue.push(obj);
              // Task 6 fix round 1 (review I1): `pushQueues` backs
              // `nextPush()` — for a caller that drains it regularly, this
              // never gets close to firing. A `--terminal` session never
              // calls `nextPush("terminal:data")` at all (it reads through
              // `pushes()` instead), so without a cap every push for that
              // channel would sit here forever, un-drained, for as long as
              // the pane stays open. Same oldest-evicted rule as
              // `pushLog`'s own PROBE_PUSH_WINDOW cap above.
              if (queue.length > PROBE_PUSH_WINDOW) queue.shift();
              pushQueues.set(channel, queue);
              return;
            }
            default:
              return;
          }
        });

        function makeSession(capabilities: string[]): DeviceSession {
          function call(channel: string, ...args: unknown[]): Promise<Record<string, unknown>> {
            const id = nextId++;
            return new Promise((res, rej) => {
              const timer = setTimeout(() => {
                pending.delete(id);
                rej(new Error(`call(${channel}) timed out after ${DEFAULT_CALL_TIMEOUT_MS}ms`));
              }, DEFAULT_CALL_TIMEOUT_MS);
              timer.unref?.();
              pending.set(id, {
                resolve(value) {
                  clearTimeout(timer);
                  res(value);
                },
                reject(error) {
                  clearTimeout(timer);
                  rej(error);
                },
              });
              ws.send(encodeMessage({ t: "req", id, ch: channel, a: args }));
            });
          }

          function upload(
            channel: string,
            args: unknown[],
            bytes: Uint8Array,
            chunkBytes: number = MAX_BLOB_CHUNK_BYTES,
          ): Promise<Record<string, unknown>> {
            // A non-integer, non-positive or over-ceiling chunkBytes would
            // otherwise reach the loop below: 0 or negative never advances
            // `offset` (an infinite loop, synchronous — no timeout can
            // rescue it), and NaN/Infinity/fractional values produce a
            // nonsensical frame split. Validated before touching `nextId`,
            // the pending map or the socket at all, so an invalid call sends
            // no header and no frame.
            if (
              !Number.isSafeInteger(chunkBytes) ||
              chunkBytes < 1 ||
              chunkBytes > MAX_BLOB_CHUNK_BYTES
            ) {
              return Promise.reject(
                new Error(
                  `upload(${channel}): invalid chunkBytes ${String(chunkBytes)} (must be a safe integer in [1, ${MAX_BLOB_CHUNK_BYTES}])`,
                ),
              );
            }
            const id = nextId++;
            const chunks = Math.max(1, Math.ceil(bytes.length / chunkBytes));
            return new Promise((res, rej) => {
              const timer = setTimeout(() => {
                pending.delete(id);
                rej(new Error(`upload(${channel}) timed out after ${DEFAULT_CALL_TIMEOUT_MS}ms`));
              }, DEFAULT_CALL_TIMEOUT_MS);
              timer.unref?.();
              pending.set(id, {
                resolve(value) {
                  clearTimeout(timer);
                  res(value);
                },
                reject(error) {
                  clearTimeout(timer);
                  rej(error);
                },
              });
              ws.send(
                encodeMessage({ t: "blob", id, ch: channel, a: args, bytes: bytes.length, chunks }),
              );
              for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
                const end = Math.min(offset + chunkBytes, bytes.length);
                ws.send(bytes.subarray(offset, end), { binary: true });
              }
            });
          }

          function subscribe(targets: SubTarget[]): void {
            ws.send(encodeMessage({ t: "sub", add: targets }));
          }

          function unsubscribe(targets: SubTarget[]): void {
            ws.send(encodeMessage({ t: "sub", drop: targets }));
          }

          function pushes(channel: string): Record<string, unknown>[] {
            return [...(pushLog.get(channel) ?? [])];
          }

          function pauseReading(): void {
            ws.pause();
          }

          function resumeReading(): void {
            ws.resume();
          }

          function nextPush(
            channel: string,
            timeoutMs = DEFAULT_PUSH_TIMEOUT_MS,
          ): Promise<Record<string, unknown>> {
            const queue = pushQueues.get(channel);
            const queued = queue?.shift();
            if (queued !== undefined) return Promise.resolve(queued);

            return new Promise((res, rej) => {
              const waiter: PushWaiter = {
                resolve(value) {
                  clearTimeout(timer);
                  res(value);
                },
                reject(error) {
                  clearTimeout(timer);
                  rej(error);
                },
              };
              const timer = setTimeout(() => {
                const list = pushWaiters.get(channel);
                if (list !== undefined) {
                  const index = list.indexOf(waiter);
                  if (index !== -1) list.splice(index, 1);
                }
                rej(new Error(`nextPush(${channel}) timed out after ${timeoutMs}ms`));
              }, timeoutMs);
              timer.unref?.();
              const list = pushWaiters.get(channel) ?? [];
              list.push(waiter);
              pushWaiters.set(channel, list);
            });
          }

          function bye(): Promise<number> {
            ws.send(encodeMessage({ t: "bye" }));
            ws.close();
            return closed;
          }

          return {
            welcome: { capabilities },
            closed,
            call,
            upload,
            subscribe,
            unsubscribe,
            nextPush,
            pushes,
            pauseReading,
            resumeReading,
            bye,
          };
        }

        ws.send(
          encodeMessage({
            t: "hello",
            v: PROTOCOL_VERSION,
            deviceId: credential.deviceId,
            token: credential.token,
            client: "jarvis-probe",
          }),
        );
      }),
  );
}

/** Flips the last character of a token to a different one still valid in `SECRET_PATTERN`'s alphabet — a minimal, deliberate corruption for the negative-auth check. */
function flipLastChar(token: string): string {
  const last = token.at(-1) ?? "a";
  const flipped = last === "a" ? "b" : "a";
  return `${token.slice(0, -1)}${flipped}`;
}

/**
 * `runProbe`'s `--terminal` path: subscribes to one pane's data/exit
 * streams plus `metrics:update`, snapshots it, then only ever counts what
 * arrives — never prints terminal content (a pane can hold anything a user
 * typed or saw, secrets included). Polls `pushes()` rather than racing
 * `nextPush` across channels, so no waiter is ever left dangling on a
 * channel this loop didn't pick.
 *
 * Exported for unit testing against a fake `DeviceSession` — no real socket
 * needed, since the interface is plain functions and promises.
 */
export async function runTerminalProbe(
  session: DeviceSession,
  key: string,
  log: (line: string) => void,
): Promise<void> {
  session.subscribe([{ ch: "terminal:data", key }, { ch: "terminal:exit", key }, "metrics:update"]);

  const snapshotRes = await session.call("terminal:snapshot", key);
  if (snapshotRes.t !== "res") {
    // A forbidden/unknown-channel `err` reply must fail loudly here rather
    // than be read as an empty snapshot: the poll loop below would then run
    // forever waiting for a `terminal:exit` that can never arrive (same
    // hang class as not observing `session.closed`, below).
    throw new Error(`terminal:snapshot failed: ${JSON.stringify(snapshotRes)}`);
  }
  const snapshot = (snapshotRes as { v?: unknown }).v as
    | { text?: unknown; end?: unknown }
    | undefined;
  const text = typeof snapshot?.text === "string" ? snapshot.text : "";
  let end = typeof snapshot?.end === "number" ? snapshot.end : 0;
  log(`snapshot end=${end} chars=${text.length}`);

  // The server can close this socket at any time (revocation, congestion,
  // bridge stop) while the pane is still live; `terminal:exit` never comes
  // in that case. Without this, the poll loop below would spin forever.
  let closedCode: number | undefined;
  session.closed.then((code) => {
    closedCode = code;
  });

  let renderedBytes = 0;
  let droppedBytes = 0;
  // Task 6 fix round 1 (review I1): `pushes()` returns the *retained*
  // window (PROBE_PUSH_WINDOW, oldest evicted) — once a long `--terminal`
  // session outlives that window, every earlier absolute array index this
  // loop had already reached (`dataSeen`) permanently overshoots the
  // now-shorter array, so `dataSeen < dataPushes.length` never holds again
  // and processing silently freezes forever. `seq` (the server's own
  // monotonic per-connection push sequence number) survives eviction:
  // tracking "highest seq processed" instead of "how many array slots
  // consumed" means a push is skipped only once it's actually been seen,
  // never because the array it once lived in shrank out from under an
  // index.
  let lastSeq = 0;
  let lastLoggedAt = 0;

  for (;;) {
    const dataPushes = session.pushes("terminal:data");
    for (const push of dataPushes) {
      const seq = typeof push.seq === "number" ? push.seq : undefined;
      if (seq === undefined || seq <= lastSeq) continue;
      lastSeq = seq;
      const payload = push.p as { chunk?: unknown; offset?: unknown } | undefined;
      const chunk = typeof payload?.chunk === "string" ? payload.chunk : "";
      const offset = typeof payload?.offset === "number" ? payload.offset : end;
      renderedBytes += utf8Bytes(renderChunk(end, offset, chunk));
      end = Math.max(end, offset + chunk.length);
      const dropped = push.dropped;
      if (typeof dropped === "number") droppedBytes += dropped;
    }

    const metricsCount = session.pushes("metrics:update").length;

    const now = Date.now();
    if (now - lastLoggedAt >= TERMINAL_LOG_INTERVAL_MS) {
      log(
        `terminal: rendered=${renderedBytes} dropped=${droppedBytes} lastOffset=${end} metrics=${metricsCount}`,
      );
      lastLoggedAt = now;
    }

    const exitPush = session.pushes("terminal:exit")[0];
    if (exitPush !== undefined) {
      const exitPayload = exitPush.p as { code?: unknown } | undefined;
      const code = typeof exitPayload?.code === "number" ? exitPayload.code : -1;
      log(`terminal exited code=${code}`);
      await session.bye();
      return;
    }

    if (closedCode !== undefined) {
      log(`closed: ${closedCode}`);
      return;
    }

    await delay(TERMINAL_POLL_MS);
  }
}

/**
 * The M4 negative-auth check: connects again with a corrupted token and
 * asserts the server refuses it with close code 4401. Extracted from
 * `runConnectedProbe` purely so that function's *ordering* can be unit
 * tested against a fake `DeviceSession` without a real socket — this one
 * piece still needs one (a second `connectDevice`), so tests inject a
 * stand-in instead of calling this directly.
 */
async function checkBadTokenRejected(link: PairingLink, credential: Credential): Promise<number> {
  try {
    await connectDevice(link, {
      deviceId: credential.deviceId,
      token: flipLastChar(credential.token),
    });
    throw new Error("expected a hello with a flipped token to be refused");
  } catch (error) {
    if (!(error instanceof ProbeClosedError)) throw error;
    if (error.code !== 4401) {
      throw new Error(`expected close 4401 for a bad token, got ${String(error.code)}`);
    }
    return error.code;
  }
}

/**
 * Everything `runProbe` does once a session is live: the M4 checks
 * (`projects:list`, the `metrics:update` push, the forbidden
 * `remote:bindChoices` call, the flipped-token 4401 check), unconditionally
 * — then, only on top of that sequence, `--terminal`'s probe, or `hold`, or
 * a plain `bye`. `--terminal` must never *replace* the M4 checks: a manual
 * pass against a terminal pane still has to prove those invariants hold.
 *
 * Exported for unit testing against a fake `DeviceSession`; `checkBadToken`
 * defaults to the real (network-touching) check and is overridden in tests.
 */
export async function runConnectedProbe(
  session: DeviceSession,
  link: PairingLink,
  credential: Credential,
  runtime: { hold: boolean; terminal?: string },
  log: (line: string) => void,
  checkBadToken: (
    link: PairingLink,
    credential: Credential,
  ) => Promise<number> = checkBadTokenRejected,
): Promise<void> {
  const projects = await session.call("projects:list");
  log(`projects:list -> ${JSON.stringify(projects)}`);

  session.subscribe(["metrics:update"]);
  const pushed = await session.nextPush("metrics:update", 10_000);
  log(`metrics:update -> ${JSON.stringify(pushed)}`);

  const denied = await session.call("remote:bindChoices");
  if (denied.t !== "err" || denied.code !== "forbidden") {
    throw new Error(`expected remote:bindChoices to be forbidden, got ${JSON.stringify(denied)}`);
  }

  await checkBadToken(link, credential);
  log("negative checks passed");

  if (runtime.terminal !== undefined) {
    await runTerminalProbe(session, runtime.terminal, log);
    return;
  }

  if (runtime.hold) {
    log("holding; revoke it in Settings");
    const code = await session.closed;
    log(`closed: ${code}`);
    return;
  }

  const code = await session.bye();
  log(`closed: ${code}`);
}

export async function runProbe(options: {
  uri: string;
  hostOverride?: string;
  deviceName: string;
  allowNonLoopback: boolean;
  hold: boolean;
  terminal?: string;
  log(line: string): void;
}): Promise<void> {
  const { uri, hostOverride, deviceName, allowNonLoopback, hold, terminal, log } = options;

  const parsed = parsePairingUri(uri);
  // Never echo `uri` itself: it carries the pairing secret in its query
  // string, and a URI that fails only on, say, its host is still a URI
  // whose secret this error would otherwise hand straight to a log line.
  if (parsed === undefined) throw new Error("invalid pairing URI");

  if (hostOverride !== undefined && !isIpLiteral(hostOverride)) {
    throw new Error("the --host override must be an IP literal, not a hostname");
  }
  const link: PairingLink = hostOverride === undefined ? parsed : { ...parsed, host: hostOverride };

  if (!allowNonLoopback && !isLoopback(link.host)) {
    throw new Error(
      `refusing to reach ${link.host}: not a loopback address; pass --allow-non-loopback to override`,
    );
  }

  // Validated before ever touching the network, same as the host checks
  // above — a malformed pane key is a usage error, not something worth a
  // round trip to find out about.
  if (terminal !== undefined && !isSubscriptionKey(terminal)) {
    throw new Error(`invalid --terminal value ${JSON.stringify(terminal)}\n${TERMINAL_USAGE}`);
  }

  log(`Approve '${deviceName}' in the Jarvis window`);
  const credential = await pairDevice(link, deviceName);
  log(`paired as device ${credential.deviceId}`);
  log("token: held in memory only");

  const session = await connectDevice(link, credential);

  await runConnectedProbe(session, link, credential, { hold, terminal }, log);
}
