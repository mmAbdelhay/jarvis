// The daemon's end of the local control transport (Phase 2, task 2.4): the
// desktop app and the jarvisd CLI reach the core through here, and
// desktop-only channels are reachable only through here, never through the
// remote bridge. Access is proven by reading a secret the daemon rewrites at
// every start into a file only its user can read (0600 in a 0700 directory;
// the user-profile ACL on Windows). The secret is never logged.
//
// Per connection: the first frame must be a hello within HANDSHAKE_TIMEOUT_MS
// and no bigger than MAX_HELLO_FRAME_BYTES. A wrong secret — or any other
// first frame — closes the connection without a reply, so an unauthenticated
// peer learns nothing, not even the build. A right secret with a different
// build or protocol version is told restart-required, so an updated app can
// restart an old daemon. After the welcome, frames are @jarvis/wire req/blob
// in and res/err/psh out; the handlers apply the desktop origin themselves.
import { timingSafeEqual } from "node:crypto";
import { posix, win32 } from "node:path";
import type { Server, Socket } from "node:net";
import { HANDSHAKE_TIMEOUT_MS, isValidBlobShape, MAX_BLOB_CHUNK_BYTES } from "@jarvis/wire";
import type { ControlDeps } from "./deps.js";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeJsonFrame,
  type Frame,
  FrameDecoder,
  FrameError,
  MAX_CONTROL_FRAME_BYTES,
  MAX_HELLO_FRAME_BYTES,
} from "./frames.js";
import { acquireDaemonLock } from "./lock.js";
import {
  CONTROL_SECRET_PATTERN,
  ControlRequestError,
  type ControlServerMessage,
  parseClientMessage,
  parseHello,
} from "./messages.js";

const SECRET_BYTES = 32;
/** A client that stops reading is dropped rather than buffered for without bound. */
const MAX_OUTBOUND_BYTES = 4 * MAX_CONTROL_FRAME_BYTES;
const MAX_INFLIGHT_REQUESTS = 256;

export interface ControlHandlers {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  upload(channel: string, args: unknown[], bytes: Uint8Array): Promise<unknown>;
}

export interface ControlServer {
  /** Sends a push to every authenticated client, in call order. */
  push(channel: string, payload: unknown): void;
  /** Called after each client's welcome, e.g. to flush pushes queued while none was connected. */
  onConnect(listener: () => void): () => void;
  readonly connectionCount: number;
  close(): Promise<void>;
}

export interface CreateControlServerOptions {
  endpoint: string;
  platform: NodeJS.Platform;
  secretPath: string;
  build: string;
  handlers: ControlHandlers;
  deps: ControlDeps;
}

export type ControlServerStart = { kind: "started"; server: ControlServer } | { kind: "busy" };

type Client = { send(message: ControlServerMessage): void; seq: number };

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export async function createControlServer(
  options: CreateControlServerOptions,
): Promise<ControlServerStart> {
  const { deps, platform, build, handlers } = options;
  const unix = platform !== "win32";
  const path = unix ? posix : win32;
  const secret = Buffer.from(deps.randomBytes(SECRET_BYTES));
  const sockets = new Set<Socket>();
  const clients = new Set<Client>();
  const connectListeners = new Set<() => void>();

  const directories = new Set([path.dirname(options.secretPath)]);
  if (unix) directories.add(path.dirname(options.endpoint));
  for (const directory of directories) {
    await deps.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only to a directory it creates.
    if (unix) await deps.fs.chmod(directory, 0o700);
  }

  function secretMatches(given: string): boolean {
    if (!CONTROL_SECRET_PATTERN.test(given)) return false;
    return timingSafeEqual(Buffer.from(given, "hex"), secret);
  }

  function attach(socket: Socket): void {
    sockets.add(socket);
    let phase: "hello" | "open" | "closing" = "hello";
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
    const timer = deps.clock.setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);

    const fail = () => {
      phase = "closing";
      socket.destroy();
    };

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

    const onHello = (frame: Frame) => {
      const hello = frame.kind === "json" ? parseHello(frame.value) : undefined;
      if (hello === undefined || !secretMatches(hello.secret)) return fail();
      deps.clock.clearTimeout(timer);
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

    const onFrame = (frame: Frame) => {
      if (phase === "hello") return onHello(frame);
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

    socket.on("error", () => {
      // "close" follows; nothing about a local peer's socket error is worth logging.
    });
    socket.on("close", () => {
      deps.clock.clearTimeout(timer);
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
    endpoint: options.endpoint,
    platform,
    deps,
    onConnection: attach,
  });
  if (lock.kind === "busy") return { kind: "busy" };
  const listener: Server = lock.server;

  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      if (!listener.listening) return resolve();
      listener.close(() => resolve());
    });

  try {
    if (unix) await deps.fs.chmod(options.endpoint, 0o600);
    // Unlink first: writeFile's mode applies only to a file it creates, and
    // "wx" refuses to write through anything left at the path.
    try {
      await deps.fs.unlink(options.secretPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await deps.fs.writeFile(options.secretPath, secret.toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    await close();
    throw error;
  }

  return {
    kind: "started",
    server: {
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
