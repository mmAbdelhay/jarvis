// A fake SocketLike for tests: every `send` is recorded as the parsed JSON
// object it encoded (never the raw text), `close` records the exact
// code/reason it was given, and `terminate`/`bufferedAmount` are exposed so
// a test can assert on precisely what a session wrote to (or did to) the
// wire, without a real socket. Reused by pair-session.test.ts and, later,
// Task 6's hub tests.

import type { SocketLike } from "./io.js";

export class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | undefined = undefined;
  terminated = false;
  bufferedAmount = 0;

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  terminate(): void {
    this.terminated = true;
  }
}
