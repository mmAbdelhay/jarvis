// The daemon's end of the local control transport (Phase 2, task 2.4): the
// desktop app and the jarvisd CLI reach the core through here, and
// desktop-only channels are reachable only through here, never through the
// remote bridge. Access is proven with a secret the daemon rewrites at every
// start into a file only its user can read (0600 in a 0700 directory; the
// user-profile ACL on Windows) — proven, never sent: see handshake.ts. The
// secret is never logged.
//
// Start-up order (review I2/I3 rulings): run-dir check → pid lock → the new
// secret (and Windows pipe name) published atomically → listen → connect to
// ourselves to confirm the endpoint reaches this server. A client that dials
// the moment the endpoint appears therefore always reads the right secret.
//
// Per connection: the handshake must finish within HANDSHAKE_TIMEOUT_MS, with
// frames no bigger than MAX_HELLO_FRAME_BYTES and at most
// MAX_PENDING_HANDSHAKES connections mid-handshake at once. A bad frame or a
// wrong proof closes the connection without a reply, so an unauthenticated
// peer learns nothing, not even the build. A client that proves itself but
// runs another build or protocol version is told restart-required, so an
// updated app can restart an old daemon. After the welcome, frames are
// @jarvis/wire req/blob in and res/err/psh out; the handlers apply the desktop
// origin themselves.
import type { Server, Socket } from "node:net";
import { HANDSHAKE_TIMEOUT_MS, isValidBlobShape, MAX_BLOB_CHUNK_BYTES } from "@jarvis/wire";
import type { ControlDeps } from "./deps.js";
import { controlPaths } from "./endpoint.js";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeJsonFrame,
  type Frame,
  FrameDecoder,
  FrameError,
  MAX_CONTROL_FRAME_BYTES,
  MAX_HELLO_FRAME_BYTES,
} from "./frames.js";
import { clientProof, NONCE_BYTES, proofMatches, serverProof } from "./handshake.js";
import { acquireDaemonLock } from "./lock.js";
import {
  ControlRequestError,
  type ControlServerMessage,
  parseAuth,
  parseClientMessage,
  parseOpening,
} from "./messages.js";
import { ensureRunDirectory, tempName, writePrivateFile } from "./run-dir.js";

const SECRET_BYTES = 32;
/** A client that stops reading is dropped rather than buffered for without bound. */
const MAX_OUTBOUND_BYTES = 4 * MAX_CONTROL_FRAME_BYTES;
const MAX_INFLIGHT_REQUESTS = 256;
/** Unauthenticated connections held at once; on Windows any local user can open one. */
export const MAX_PENDING_HANDSHAKES = 16;

export interface ControlHandlers {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  upload(channel: string, args: unknown[], bytes: Uint8Array): Promise<unknown>;
}

export interface ControlServer {
  /** The socket path (Unix) or the pipe name chosen at this start (Windows). */
  readonly endpoint: string;
  /** Sends a push to every authenticated client, in call order. */
  push(channel: string, payload: unknown): void;
  /** Called after each client's welcome, e.g. to flush pushes queued while none was connected. */
  onConnect(listener: () => void): () => void;
  readonly connectionCount: number;
  close(): Promise<void>;
}

export interface CreateControlServerOptions {
  platform: NodeJS.Platform;
  runDirectory: string;
  build: string;
  handlers: ControlHandlers;
  deps: ControlDeps;
}

export type ControlServerStart = { kind: "started"; server: ControlServer } | { kind: "busy" };

type Client = { send(message: ControlServerMessage): void; seq: number };

export async function createControlServer(
  options: CreateControlServerOptions,
): Promise<ControlServerStart> {
  const { deps, platform, build, handlers } = options;
  const unix = platform !== "win32";
  const paths = controlPaths(platform, options.runDirectory);
  const secret = Buffer.from(deps.randomBytes(SECRET_BYTES));
  const sockets = new Set<Socket>();
  const clients = new Set<Client>();
  const connectListeners = new Set<() => void>();
  let pendingHandshakes = 0;
  const selfCheck = {
    token: Buffer.from(deps.randomBytes(32)),
    arrived: undefined as (() => void) | undefined,
  };

  await ensureRunDirectory(platform, options.runDirectory, deps);

  function attach(socket: Socket): void {
    socket.on("error", () => {
      // "close" follows; nothing about a local peer's socket error is worth logging.
    });
    if (pendingHandshakes >= MAX_PENDING_HANDSHAKES) {
      socket.destroy();
      return;
    }
    pendingHandshakes++;
    sockets.add(socket);
    let phase: "hello" | "auth" | "open" | "closing" = "hello";
    let nonces: { client: Buffer; server: Buffer } | undefined;
    const leaveHandshake = () => {
      if (phase === "hello" || phase === "auth") pendingHandshakes--;
    };
    let inflight = 0;
    let blob:
      | {
          id: number;
          ch: string;
          a: unknown[];
          bytes: number;
          chunks: number;
          parts: Buffer[];
          received: number;
        }
      | undefined;
    const decoder = new FrameDecoder(MAX_HELLO_FRAME_BYTES);
    const fail = () => {
      leaveHandshake();
      phase = "closing";
      socket.destroy();
    };
    const timer = deps.clock.setTimeout(fail, HANDSHAKE_TIMEOUT_MS);

    const send = (message: ControlServerMessage) => {
      if (socket.destroyed || !socket.writable) return;
      socket.write(encodeJsonFrame(message));
      if (socket.writableLength > MAX_OUTBOUND_BYTES) fail();
    };
    const client: Client = { send, seq: 0 };

    const respond = (id: number, run: () => Promise<unknown>) => {
      if (inflight >= MAX_INFLIGHT_REQUESTS) {
        send({ t: "err", id, code: "rate-limited", text: "Too many requests", language: "en" });
        return;
      }
      inflight++;
      Promise.resolve()
        .then(run)
        .then(
          (v) => {
            try {
              send({ t: "res", id, v });
            } catch (error) {
              // Over 16 MiB (FrameError) or not JSON-serialisable (a cycle,
              // a BigInt): the caller still gets an answer, and nothing is
              // left as an unhandled rejection in the daemon.
              const text =
                error instanceof FrameError ? "Response too large" : "Response not encodable";
              send({ t: "err", id, code: "internal", text, language: "en" });
            }
          },
          (error: unknown) => {
            const code = error instanceof ControlRequestError ? error.code : "internal";
            const text = error instanceof Error ? error.message : "Internal error";
            send({ t: "err", id, code, text, language: "en" });
          },
        )
        .finally(() => {
          inflight--;
        });
    };

    const onOpening = (frame: Frame) => {
      const opening = frame.kind === "json" ? parseOpening(frame.value) : undefined;
      if (opening === undefined) return fail();
      if (opening.t === "probe") {
        if (selfCheck.arrived !== undefined && proofMatches(selfCheck.token, opening.token)) {
          selfCheck.arrived();
        }
        return fail();
      }
      nonces = {
        client: Buffer.from(opening.nonceC, "hex"),
        server: Buffer.from(deps.randomBytes(NONCE_BYTES)),
      };
      const hello = opening;
      phase = "auth";
      send({
        t: "challenge",
        nonceS: nonces.server.toString("hex"),
        proof: serverProof(secret, nonces.client, nonces.server).toString("hex"),
      });
      // Kept for the version/build check once the client has proven itself.
      onAuthenticated = () => {
        deps.clock.clearTimeout(timer);
        leaveHandshake();
        if (hello.v !== CONTROL_PROTOCOL_VERSION || hello.build !== build) {
          phase = "closing";
          socket.end(encodeJsonFrame({ t: "restart-required", build }));
          return;
        }
        phase = "open";
        decoder.maxBytes = MAX_CONTROL_FRAME_BYTES;
        send({ t: "welcome", v: CONTROL_PROTOCOL_VERSION, capabilities: [] });
        clients.add(client);
        for (const listener of connectListeners) listener();
      };
    };
    let onAuthenticated: () => void = fail;

    const onAuth = (frame: Frame) => {
      const auth = frame.kind === "json" ? parseAuth(frame.value) : undefined;
      if (auth === undefined || nonces === undefined) return fail();
      if (!proofMatches(clientProof(secret, nonces.server, nonces.client), auth.proof)) {
        return fail();
      }
      onAuthenticated();
    };

    const onFrame = (frame: Frame) => {
      if (phase === "hello") return onOpening(frame);
      if (phase === "auth") return onAuth(frame);
      if (blob !== undefined) {
        if (frame.kind !== "binary") return fail();
        const size = frame.bytes.byteLength;
        if (size === 0 || size > MAX_BLOB_CHUNK_BYTES || blob.received + size > blob.bytes) {
          return fail();
        }
        blob.parts.push(frame.bytes);
        blob.received += size;
        if (blob.parts.length < blob.chunks) return;
        if (blob.received !== blob.bytes) return fail();
        const done = blob;
        blob = undefined;
        return respond(done.id, () =>
          handlers.upload(done.ch, done.a, Buffer.concat(done.parts, done.bytes)),
        );
      }
      const message = frame.kind === "json" ? parseClientMessage(frame.value) : undefined;
      if (message === undefined) return fail();
      if (message.t === "req")
        return respond(message.id, () => handlers.invoke(message.ch, message.a));
      if (!isValidBlobShape(message.bytes, message.chunks)) return fail();
      blob = { ...message, parts: [], received: 0 };
    };

    socket.on("close", () => {
      deps.clock.clearTimeout(timer);
      leaveHandshake();
      phase = "closing";
      sockets.delete(socket);
      clients.delete(client);
    });
    socket.on("data", (chunk: Buffer) => {
      if (phase === "closing") return;
      decoder.push(chunk);
      try {
        for (let frame = decoder.next(); frame !== undefined; frame = decoder.next()) {
          onFrame(frame);
          if (socket.destroyed || socket.writableEnded) return;
        }
      } catch {
        fail();
      }
    });
  }

  const lock = await acquireDaemonLock({
    platform,
    runDirectory: options.runDirectory,
    deps,
    onConnection: attach,
    async publish(endpoint) {
      // The secret first: once a client can see a new pipe name, the secret
      // beside it is already the one this daemon holds.
      await writePrivateFile(paths.secretPath, secret.toString("hex"), deps);
      if (!unix) await writePrivateFile(paths.endpointPath, endpoint, deps);
    },
  });
  if (lock.kind === "busy") return { kind: "busy" };
  const listener: Server = lock.server;
  const endpoint = lock.endpoint;

  const stopListening = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      if (!listener.listening) return resolve();
      listener.close(() => resolve());
    });
  const close = async () => {
    await stopListening();
    await lock.release();
  };

  let owned: boolean;
  try {
    if (unix) await deps.fs.chmod(endpoint, 0o600);
    owned = await reachesThisServer(endpoint);
  } catch (error) {
    await close();
    throw error;
  }
  if (!owned) {
    // Another process bound the path after we did. Closing unlinks the path
    // (libuv does, for a Unix socket), which would take the winner's socket
    // with it — so keep a second name for it across the close.
    if (unix) {
      const keep = tempName(endpoint, deps, "keep");
      await deps.fs.link(endpoint, keep);
      await stopListening();
      await deps.fs.rename(keep, endpoint);
    } else {
      await stopListening();
    }
    await lock.release();
    return { kind: "busy" };
  }

  /** Connects once and waits for the probe to arrive at this server's own attach(). */
  function reachesThisServer(target: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = deps.net.connect(target);
      const done = (result: boolean) => {
        selfCheck.arrived = undefined;
        deps.clock.clearTimeout(timeout);
        probe.destroy();
        resolve(result);
      };
      const timeout = deps.clock.setTimeout(() => done(false), HANDSHAKE_TIMEOUT_MS);
      selfCheck.arrived = () => done(true);
      probe.on("error", () => done(false));
      probe.on("connect", () => {
        probe.write(encodeJsonFrame({ t: "probe", token: selfCheck.token.toString("hex") }));
      });
    });
  }

  return {
    kind: "started",
    server: {
      endpoint,
      push(channel, payload) {
        for (const client of clients) {
          client.seq += 1;
          client.send({ t: "psh", ch: channel, p: payload, seq: client.seq });
        }
      },
      onConnect(listener) {
        connectListeners.add(listener);
        return () => connectListeners.delete(listener);
      },
      get connectionCount() {
        return clients.size;
      },
      close,
    },
  };
}
