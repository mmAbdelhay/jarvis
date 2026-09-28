// The app's (and the jarvisd CLI's) end of the local control transport. It
// will back the CoreClient socket adapter, so its surface is the generic
// channel + args → result shape: invoke, upload (the blob lane), onPush.
// The secret is read from the daemon's 0600 file at connect time and never
// sent, logged or put in an error message: the client proves it knows it only
// after the server has proven the same (handshake.ts), so whatever answers on
// the endpoint without being the daemon gets nothing but a nonce.
import { MAX_BLOB_BYTES, MAX_BLOB_CHUNK_BYTES, HANDSHAKE_TIMEOUT_MS } from "@jarvis/wire";
import type { ControlDeps } from "./deps.js";
import { controlPaths, endpointFor } from "./endpoint.js";
import {
  CONTROL_PROTOCOL_VERSION,
  encodeBinaryFrame,
  encodeJsonFrame,
  type Frame,
  FrameDecoder,
  MAX_CONTROL_FRAME_BYTES,
  MAX_HELLO_FRAME_BYTES,
} from "./frames.js";
import { clientProof, HEX32_PATTERN, NONCE_BYTES, proofMatches, serverProof } from "./handshake.js";
import {
  type ControlAuth,
  type ControlClientMessage,
  type ControlHello,
  ControlRequestError,
  parseServerMessage,
} from "./messages.js";

export { ControlRequestError };

/** The daemon runs another build (or protocol version) and must be restarted. */
export class ControlRestartRequired extends Error {
  constructor(readonly build: string) {
    super("The Jarvis daemon runs a different build and must be restarted");
  }
}

export interface ControlClient {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  upload(channel: string, args: unknown[], bytes: Uint8Array): Promise<unknown>;
  onPush(listener: (channel: string, payload: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface ConnectControlOptions {
  platform: NodeJS.Platform;
  runDirectory: string;
  build: string;
  deps: Pick<ControlDeps, "fs" | "net" | "clock" | "randomBytes">;
}

class ProtocolError extends Error {}

export async function connectControl(options: ConnectControlOptions): Promise<ControlClient> {
  const { deps } = options;
  const endpoint = await endpointFor({
    platform: options.platform,
    runDirectory: options.runDirectory,
    fs: deps.fs,
  });
  const secretText = (
    await deps.fs.readFile(controlPaths(options.platform, options.runDirectory).secretPath, "utf8")
  ).trim();
  if (!HEX32_PATTERN.test(secretText)) throw new Error("The control secret file is malformed");
  const secret = Buffer.from(secretText, "hex");
  const nonceC = Buffer.from(deps.randomBytes(NONCE_BYTES));
  const socket = deps.net.connect(endpoint);

  return new Promise<ControlClient>((resolve, reject) => {
    let phase: "hello" | "auth" | "open" | "closed" = "hello";
    let failure: Error | undefined;
    let nextId = 1;
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    const pushListeners = new Set<(channel: string, payload: unknown) => void>();
    const closeListeners = new Set<() => void>();
    // Hello-sized until the welcome, as on the server: a peer that has not
    // proven itself cannot make the client buffer more than that.
    const decoder = new FrameDecoder(MAX_HELLO_FRAME_BYTES);
    const timer = deps.clock.setTimeout(() => {
      failure ??= new Error("The Jarvis daemon did not answer the control handshake");
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);

    const request = (message: ControlClientMessage, chunks: Uint8Array[] = []) =>
      new Promise<unknown>((resolveRequest, rejectRequest) => {
        if (phase !== "open") return rejectRequest(new Error("The control connection is closed"));
        const frame = encodeJsonFrame(message);
        pending.set(message.id, { resolve: resolveRequest, reject: rejectRequest });
        socket.write(frame);
        for (const chunk of chunks) for (const part of encodeBinaryFrame(chunk)) socket.write(part);
      });

    const client: ControlClient = {
      invoke(channel, args) {
        return request({ t: "req", id: nextId++, ch: channel, a: args });
      },
      upload(channel, args, bytes) {
        if (bytes.byteLength < 1 || bytes.byteLength > MAX_BLOB_BYTES) {
          return Promise.reject(new RangeError("Upload size is out of range"));
        }
        const chunks: Uint8Array[] = [];
        for (let offset = 0; offset < bytes.byteLength; offset += MAX_BLOB_CHUNK_BYTES) {
          chunks.push(bytes.subarray(offset, offset + MAX_BLOB_CHUNK_BYTES));
        }
        const header = {
          t: "blob" as const,
          id: nextId++,
          ch: channel,
          a: args,
          bytes: bytes.byteLength,
          chunks: chunks.length,
        };
        return request(header, chunks);
      },
      onPush(listener) {
        pushListeners.add(listener);
        return () => pushListeners.delete(listener);
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close() {
        socket.destroy();
      },
    };

    const onFrame = (frame: Frame) => {
      const message = frame.kind === "json" ? parseServerMessage(frame.value) : undefined;
      if (message === undefined) throw new ProtocolError("Malformed control frame");
      if (phase === "hello") {
        if (message.t !== "challenge") throw new ProtocolError("Expected a control challenge");
        const nonceS = Buffer.from(message.nonceS, "hex");
        if (!proofMatches(serverProof(secret, nonceC, nonceS), message.proof)) {
          // Not the daemon (or not this start of it): leave without proving anything.
          failure = new Error("The control endpoint did not prove it is the Jarvis daemon");
          return socket.destroy();
        }
        phase = "auth";
        const auth: ControlAuth = {
          t: "auth",
          proof: clientProof(secret, nonceS, nonceC).toString("hex"),
        };
        socket.write(encodeJsonFrame(auth));
        return;
      }
      if (phase === "auth") {
        if (message.t === "welcome") {
          deps.clock.clearTimeout(timer);
          phase = "open";
          decoder.maxBytes = MAX_CONTROL_FRAME_BYTES;
          return resolve(client);
        }
        if (message.t === "restart-required") {
          failure = new ControlRestartRequired(message.build);
          return socket.destroy();
        }
        throw new ProtocolError("Unexpected control frame before welcome");
      }
      if (message.t === "psh") {
        for (const listener of pushListeners) listener(message.ch, message.p);
        return;
      }
      if (message.t !== "res" && message.t !== "err") {
        throw new ProtocolError("Unexpected control frame");
      }
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.t === "res") waiter.resolve(message.v);
      else waiter.reject(new ControlRequestError(message.code, message.text));
    };

    socket.on("connect", () => {
      const hello: ControlHello = {
        t: "hello",
        v: CONTROL_PROTOCOL_VERSION,
        build: options.build,
        nonceC: nonceC.toString("hex"),
      };
      socket.write(encodeJsonFrame(hello));
    });
    socket.on("error", (error) => {
      failure ??= error;
    });
    socket.on("data", (chunk: Buffer) => {
      if (phase === "closed") return;
      decoder.push(chunk);
      try {
        for (let frame = decoder.next(); frame !== undefined; frame = decoder.next()) {
          onFrame(frame);
          if (socket.destroyed) return;
        }
      } catch (error) {
        failure ??= error instanceof Error ? error : new ProtocolError("Bad control frame");
        socket.destroy();
      }
    });
    socket.on("close", () => {
      deps.clock.clearTimeout(timer);
      const wasOpen = phase === "open";
      phase = "closed";
      if (!wasOpen) {
        reject(failure ?? new Error("The Jarvis daemon closed the control connection"));
        return;
      }
      for (const waiter of pending.values()) {
        waiter.reject(new Error("The control connection closed"));
      }
      pending.clear();
      for (const listener of closeListeners) listener();
    });
  });
}
