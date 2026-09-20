// The transport-level contract every screen and the RPC client (Task 4)
// build on. `Transport` is deliberately narrow — open/send/close and one
// event callback — so a real socket (native-transport.ts, backed by the
// fingerprint-pinned native module) and a test double (fake-transport.ts)
// are interchangeable.
//
// `Trust` (M11, system-trust mode): a pairing whose link carried a DNS
// `name` dials it through the OS/App Transport Security trust store
// (system-transport.ts, over React Native's own `WebSocket`) instead of
// pinning a fingerprint natively — one mode per pairing, decided once at
// pairing time and never mixed for the same connection (rulings.md 1).

export type TransportEvent =
  | { kind: "open" }
  | { kind: "message"; text: string }
  | { kind: "close"; code: number; reason: string }
  // Contract every implementation must honour (relied on by rpc-client.ts,
  // which only logs `error` and reacts to the `close` that follows it): an
  // `error` is always followed by its own `close` event on the same
  // socket, carrying the real code and reason — `error` never fires on its
  // own. Not necessarily *immediately*: on iOS, a send failure is only
  // reported once the underlying task actually completes
  // (`didCompleteWithError`), not at the moment `send` was called — see
  // `PinnedSocketModule.swift`. `message` is free-form and diagnostic only; never a
  // routing signal (a fingerprint mismatch, for one, is identified by the
  // paired close's `reason: "fingerprint"`, not by this message's text).
  | { kind: "error"; message: string };

export type TransportSocket = {
  send(text: string): void;
  /**
   * Sends one binary WebSocket frame — the base64 payload is decoded
   * natively and never touches JSON (M8 ruling 1/2: the blob lane's binary
   * frames, always preceded by a `blob` header text frame the caller sends
   * separately via `send`).
   */
  sendBinary(base64: string): void;
  close(code: number, reason?: string): void;
};

export type Trust = { kind: "pin"; fingerprint: string } | { kind: "system" };

export type Transport = {
  open(url: string, trust: Trust, onEvent: (event: TransportEvent) => void): TransportSocket;
};

/**
 * Builds the `wss://` URL for a socket endpoint. An IPv6 host is bracketed
 * (`[::1]`); a zone id's `%` is percent-encoded to `%25` per RFC 6874,
 * because it now appears inside a URL rather than as a bare address
 * literal.
 */
export function socketUrl(host: string, port: number, path: "/pair" | "/rpc"): string {
  // Strip a caller-supplied bracket pair first so an already-bracketed
  // IPv6 host is not double-bracketed.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const isIPv6 = bare.includes(":");
  const encodedHost = isIPv6 ? `[${bare.replace("%", "%25")}]` : bare;
  return `wss://${encodedHost}:${port}${path}`;
}
