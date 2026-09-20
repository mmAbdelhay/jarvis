// System-trust mode (M11, rulings.md 1): a pairing link with a DNS `name`
// dials that name through React Native's own `WebSocket` — the OS/App
// Transport Security trust store — rather than the app's pinned native
// module. This transport only ever accepts a `trust.kind === "system"`
// call whose `url` is `wss://<a HOSTNAME_PATTERN match>:<port>/...`: no IP
// literal, ever (pinning is the IP path — native-transport.ts). Anything
// else gets the same refusal shape as the pinned transport's invalid
// fingerprint (task-5-brief.md behaviour rule 1): an `error` then a
// `close 1006`, via a microtask, and no real socket is ever constructed.
//
// `WebSocketLike`/`WebSocketFactory` exist so this can be unit tested with
// a scriptable fake — the mobile test suite runs with no RN renderer and
// no real network (global-constraints.md).

import { isHostname } from "@jarvis/wire";
import type { Transport, TransportSocket, Trust } from "./transport";

export type WebSocketLike = {
  readyState: number;
  // `sendBinary` (M8 Task 5) hands this a decoded `Uint8Array` for a real
  // binary WebSocket frame — RN's own `WebSocket`, like the browser one,
  // accepts an `ArrayBufferView` directly, no native decode step needed.
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

// The W3C/RFC 6455 `readyState` for an open socket — the only state `send`
// is allowed to actually forward data in.
const OPEN_READY_STATE = 1;
// RFC 6455's reserved "abnormal closure" code (see rpc-client.ts's own
// comment on the same constant): never sent on the wire, used locally both
// as the fallback for a close with no numeric code and as the synthesised
// code after an `error` with no real close.
const ABNORMAL_CLOSE = 1006;

/** The host segment of a `wss://<host>:<port>/...` URL, or `undefined` for
 * anything that doesn't have that shape — checked before ever constructing
 * a real socket, never after. */
function hostOf(url: string): string | undefined {
  if (!url.startsWith("wss://")) return undefined;
  const afterScheme = url.slice("wss://".length);
  const hostAndPort = afterScheme.split("/")[0] ?? "";
  const colonIndex = hostAndPort.lastIndexOf(":");
  if (colonIndex === -1) return undefined;
  return hostAndPort.slice(0, colonIndex);
}

function isSystemTarget(url: string, trust: Trust): boolean {
  if (trust.kind !== "system") return false;
  const host = hostOf(url);
  return host !== undefined && isHostname(host);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes a base64 string into raw bytes for `sendBinary` below. Written by
 * hand rather than reaching for `Buffer` (not guaranteed under Hermes) or
 * `atob` (not guaranteed under either Hermes or Vitest's Node env) — this
 * transport's only two runtimes. Assumes well-formed base64: the only
 * caller feeds it a chunk `base64-chunks.ts`'s `splitBase64` already sliced
 * from a payload `rpc-client.ts`'s `upload` validated with
 * `base64ByteLength` before ever reaching a transport.
 */
function decodeBase64(base64: string): Uint8Array {
  const clean = base64.endsWith("==")
    ? base64.slice(0, -2)
    : base64.endsWith("=")
      ? base64.slice(0, -1)
      : base64;
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 1) {
    bitBuffer = (bitBuffer << 6) | BASE64_ALPHABET.indexOf(clean[i] as string);
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[byteIndex] = (bitBuffer >> bitCount) & 0xff;
      byteIndex += 1;
    }
  }
  return bytes;
}

export function createSystemTransport(factory: WebSocketFactory): Transport {
  return {
    open(url, trust, onEvent): TransportSocket {
      if (!isSystemTarget(url, trust)) {
        // Bite-proof (rule 1): dropping the `isHostname` check here lets
        // an IP-literal host (or a `pin` trust, or a bare `ws://`) reach
        // `factory(url)` below instead of refusing.
        queueMicrotask(() => {
          onEvent({ kind: "error", message: "not a system-trust target" });
          onEvent({ kind: "close", code: ABNORMAL_CLOSE, reason: "trust" });
        });
        return {
          send(): void {
            // No socket was ever opened; nothing to send to.
          },
          sendBinary(): void {
            // No socket was ever opened; nothing to send to.
          },
          close(): void {
            // Already conceptually closed; nothing to close.
          },
        };
      }

      const ws = factory(url);
      let closed = false;
      let droppedNonStringFrames = 0;

      // One close per socket (the transport contract every caller relies
      // on — rpc-client.ts's `generation` bump on the first close would
      // otherwise mis-route a second one): whichever of the real `onclose`
      // and the error-triggered synthetic one arrives first wins; the
      // other is silently dropped.
      function emitClose(code: number, reason: string): void {
        if (closed) return;
        closed = true;
        onEvent({ kind: "close", code, reason });
      }

      ws.onopen = () => {
        onEvent({ kind: "open" });
      };
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") {
          droppedNonStringFrames += 1;
          console.warn(
            `system-transport: dropped non-string frame count=${droppedNonStringFrames}`,
          );
          return;
        }
        onEvent({ kind: "message", text: event.data });
      };
      ws.onclose = (event) => {
        const code = typeof event.code === "number" ? event.code : ABNORMAL_CLOSE;
        emitClose(code, event.reason ?? "");
      };
      ws.onerror = (event) => {
        onEvent({ kind: "error", message: event.message ?? "" });
        // Contract (rule 1): give the real `onclose` a chance to arrive
        // within this same tick + one microtask before synthesising one —
        // a real close (carrying the peer's actual code) always wins over
        // this fallback 1006.
        queueMicrotask(() => {
          emitClose(ABNORMAL_CLOSE, "");
        });
      };

      return {
        send(text: string): void {
          if (ws.readyState !== OPEN_READY_STATE) return;
          ws.send(text);
        },
        // Unlike `send`, never silently drops (M8 behaviour rule 4, via
        // rpc-client.ts's `upload`, which catches a throw here and resolves
        // the call `offline` rather than leaving it "in flight" forever): a
        // real binary WebSocket frame, decoded from base64 and handed to
        // the OS/browser socket directly — no native decode step exists on
        // this path.
        sendBinary(base64: string): void {
          if (ws.readyState !== OPEN_READY_STATE) {
            throw new Error("system-transport: socket not open");
          }
          ws.send(decodeBase64(base64));
        },
        close(code: number, reason = ""): void {
          ws.close(code, reason);
        },
      };
    },
  };
}

// The real transport: React Native's own global `WebSocket` (the OS trust
// store) — no pin, no native module, no per-socket bypass.
export const systemTransport: Transport = createSystemTransport(
  (url) => new globalThis.WebSocket(url) as unknown as WebSocketLike,
);
