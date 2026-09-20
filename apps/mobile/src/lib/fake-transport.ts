// The test double for `Transport` (Task 4 exercises it; no tests live in
// this file itself). Every socket a fake transport opens is recorded on
// `sockets` in open order, and each socket exposes `emit` so a test can
// drive its `onEvent` callback directly — no real network, ever.
//
// M11: records `trust` (the whole `Trust` value `open` was called with)
// rather than a bare `fingerprint` — a fake socket opened under system
// trust has no fingerprint at all.

import type { Transport, TransportEvent, TransportSocket, Trust } from "./transport";

export type FakeSocket = TransportSocket & {
  url: string;
  trust: Trust;
  // `sent` keeps its M6 meaning: text frames only, in order.
  sent: string[];
  // Every `send`/`sendBinary` call, text and binary, in the exact order
  // they were made — the only way a test can assert that a `blob` header
  // frame was immediately followed by its binary frames with nothing else
  // interleaved.
  sentBinary: string[];
  frames: Array<{ kind: "text"; text: string } | { kind: "binary"; base64: string }>;
  closedWith?: { code: number; reason?: string };
  emit(event: TransportEvent): void;
};

export function createFakeTransport(): Transport & { sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];

  const open: Transport["open"] = (url, trust, onEvent) => {
    const socket: FakeSocket = {
      url,
      trust,
      sent: [],
      sentBinary: [],
      frames: [],
      closedWith: undefined,
      send(text: string): void {
        socket.sent.push(text);
        socket.frames.push({ kind: "text", text });
      },
      sendBinary(base64: string): void {
        socket.sentBinary.push(base64);
        socket.frames.push({ kind: "binary", base64 });
      },
      close(code: number, reason?: string): void {
        socket.closedWith = { code, reason };
      },
      emit(event: TransportEvent): void {
        onEvent(event);
      },
    };
    sockets.push(socket);
    return socket;
  };

  return { open, sockets };
}
