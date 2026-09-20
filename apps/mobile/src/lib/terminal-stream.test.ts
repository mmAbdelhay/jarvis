// Tests for the Workspace terminal pane stream (M9 Task 7): the same
// attach/re-attach/gap-marker machinery session-stream.test.ts exhaustively
// covers via `createAttachStream`, exercised here only for the wiring that
// differs — the `terminal:data`/`terminal:snapshot` channel names, the
// `paneKey` key field, and the `terminal-stream:` log prefix. See
// session-stream.test.ts for the cursor/replay/retry edge cases this reuses
// unchanged.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import type { TerminalSink } from "./session-stream";
import { createTerminalStream, matchesPaneExit, watchTerminalExit } from "./terminal-stream";

const HERE = dirname(fileURLToPath(import.meta.url));

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const PANE_KEY = "tab-1:p1";

function createEnv() {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const logs: string[] = [];
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: "jarvis-mobile-test",
    log: (line) => logs.push(line),
  });
  return { transport, clock, logs, client };
}

function createStream(
  client: ReturnType<typeof createRpcClient>,
  clock: ReturnType<typeof createFakeClock>,
  log: (line: string) => void = () => {},
) {
  return createTerminalStream({ client, paneKey: PANE_KEY, log, clock });
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function completeHandshake(
  transport: ReturnType<typeof createFakeTransport>,
  capabilities: string[] = ["terminal:data"],
): FakeSocket {
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return socket;
}

type ParsedFrame = { t: string; [key: string]: unknown };

function parsedFrames(socket: FakeSocket): ParsedFrame[] {
  return socket.sent.map((s) => JSON.parse(s) as ParsedFrame);
}

function createRecordingSink(): TerminalSink & { writes: string[]; resets: number } {
  const writes: string[] = [];
  let resets = 0;
  return {
    writes,
    get resets() {
      return resets;
    },
    write(data: string) {
      writes.push(data);
    },
    reset() {
      resets += 1;
    },
  };
}

function pushFrame(socket: FakeSocket, ch: string, seq: number, payload: unknown): void {
  socket.emit({ kind: "message", text: encodeMessage({ t: "psh", ch, p: payload, seq }) });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function answerSnapshot(socket: FakeSocket, id: number, value: unknown): Promise<void> {
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id, v: value }) });
  await flush();
}

function lastReqId(socket: FakeSocket): number {
  const req = parsedFrames(socket)
    .filter((f) => f.t === "req")
    .at(-1);
  if (req === undefined) throw new Error("no req frame sent");
  return req.id as number;
}

describe("createTerminalStream: wiring", () => {
  it("subscribes to terminal:data (keyed by the pane) then calls terminal:snapshot", () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);

    stream.open(createRecordingSink());

    const frames = parsedFrames(socket);
    const sub = frames.find((f) => f.t === "sub");
    const req = frames.find((f) => f.t === "req");
    expect(sub?.add).toEqual([{ ch: "terminal:data", key: PANE_KEY }]);
    expect(req?.ch).toBe("terminal:snapshot");
    expect(req?.a).toEqual([PANE_KEY]);
  });

  // [bite-proof] "keyed-subscription release on blur": the terminal screen's
  // cleanup calls stream.close() — this is what actually drops the keyed
  // terminal:data subscription on the wire, the same way leaving the
  // screen must.
  it("close() sends a sub drop for the pane's keyed subscription", () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    stream.open(createRecordingSink());

    stream.close();

    const drop = parsedFrames(socket).find((f) => f.t === "sub" && f.drop !== undefined);
    expect(drop?.drop).toEqual([{ ch: "terminal:data", key: PANE_KEY }]);
  });

  it("writes the initial snapshot, then a push that races ahead of it", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink = createRecordingSink();

    stream.open(sink);
    const id = lastReqId(socket);
    // A push for this exact pane, delivered before the snapshot answer —
    // buffered while "attaching", then drained once the snapshot lands.
    pushFrame(socket, "terminal:data", 1, { paneKey: PANE_KEY, chunk: " world", offset: 5 });
    await answerSnapshot(socket, id, { text: "hello", end: 5 });

    expect(sink.writes).toEqual(["hello", " world"]);
  });

  it("ignores a push on the session:output channel entirely", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["terminal:data", "session:output"]);
    const stream = createStream(client, clock);
    const sink = createRecordingSink();
    stream.open(sink);
    const id = lastReqId(socket);
    await answerSnapshot(socket, id, { text: "", end: 0 });

    pushFrame(socket, "session:output", 1, { sessionId: "s1", chunk: "nope", offset: 0 });

    expect(sink.writes).toEqual([]);
    expect(stream.get().ignoredCount).toBe(0); // never reached handlePush at all
  });

  it("counts, but does not write, a push for a different pane on the same channel", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink = createRecordingSink();
    stream.open(sink);
    const id = lastReqId(socket);
    await answerSnapshot(socket, id, { text: "", end: 0 });

    pushFrame(socket, "terminal:data", 1, {
      paneKey: "tab-1:p2",
      chunk: "someone else's split",
      offset: 0,
    });

    expect(sink.writes).toEqual([]);
    expect(stream.get().ignoredCount).toBe(1);
  });

  // A surrogate pair split across an offset boundary: the low half is
  // skipped (a gap), never rendered as a corrupt lone code unit. Mirrors
  // stream-cursor.test.ts's own `applyChunk(1, 0, "😀x")` case: `rendered=1`
  // already covers the high surrogate, so slicing the next chunk at
  // `rendered-offset=1` would otherwise land on the low surrogate.
  it("marks a gap rather than splitting a surrogate pair", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink = createRecordingSink();
    stream.open(sink);
    const id = lastReqId(socket);
    // A lone high surrogate as the whole snapshot — synthetic, but the
    // cursor has to stay defensive against it regardless of how it arose.
    await answerSnapshot(socket, id, { text: "\uD83D", end: 1 });

    pushFrame(socket, "terminal:data", 1, {
      paneKey: PANE_KEY,
      chunk: "😀x",
      offset: 0,
    });

    expect(stream.get().gapCount).toBe(1);
    const written = sink.writes.join("");
    expect(written).not.toContain("\uDE00x");
    expect(written).toContain("x");
  });

  it("never logs pane text — only phase, id and counts", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const logs: string[] = [];
    const stream = createStream(client, clock, (line) => logs.push(line));
    const sink = createRecordingSink();
    stream.open(sink);
    const id = lastReqId(socket);
    const secret = "super-secret-command-output";
    await answerSnapshot(socket, id, { text: secret, end: secret.length });

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((line) => line.startsWith("terminal-stream: "))).toBe(true);
    for (const line of logs) expect(line).not.toContain(secret);
  });

  it("restart() re-snapshots from offset 0, replacing the sink", async () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport);
    const stream = createStream(client, clock);
    const sink1 = createRecordingSink();
    stream.open(sink1);
    const id1 = lastReqId(socket);
    await answerSnapshot(socket, id1, { text: "first", end: 5 });

    const sink2 = createRecordingSink();
    stream.restart(sink2);
    const id2 = lastReqId(socket);
    await answerSnapshot(socket, id2, { text: "second", end: 6 });

    expect(sink2.writes).toEqual(["second"]);
    expect(sink1.writes).toEqual(["first"]);
  });
});

describe("matchesPaneExit", () => {
  it("matches an exit payload naming this exact pane", () => {
    expect(matchesPaneExit({ paneKey: PANE_KEY, code: 130 }, PANE_KEY)).toBe(true);
  });

  it("does not match another pane's exit payload", () => {
    expect(matchesPaneExit({ paneKey: "tab-1:p2", code: 0 }, PANE_KEY)).toBe(false);
  });

  it("does not match a malformed payload", () => {
    expect(matchesPaneExit(undefined, PANE_KEY)).toBe(false);
    expect(matchesPaneExit(null, PANE_KEY)).toBe(false);
    expect(matchesPaneExit("nope", PANE_KEY)).toBe(false);
    expect(matchesPaneExit([], PANE_KEY)).toBe(false);
    expect(matchesPaneExit({}, PANE_KEY)).toBe(false);
  });
});

describe("watchTerminalExit: wiring (Fix round 1, Important 1)", () => {
  it("subscribes to terminal:exit keyed by the pane, beside terminal:data", () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["terminal:data", "terminal:exit"]);
    const stream = createStream(client, clock);
    stream.open(createRecordingSink());

    watchTerminalExit({ client, paneKey: PANE_KEY, onExit: () => {} });

    const subs = parsedFrames(socket)
      .filter((f) => f.t === "sub")
      .flatMap((f) => (f.add as unknown[] | undefined) ?? []);
    expect(subs).toContainEqual({ ch: "terminal:data", key: PANE_KEY });
    expect(subs).toContainEqual({ ch: "terminal:exit", key: PANE_KEY });
  });

  it("calls onExit exactly once for a terminal:exit push naming this pane", () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["terminal:exit"]);
    let exits = 0;
    watchTerminalExit({ client, paneKey: PANE_KEY, onExit: () => (exits += 1) });

    pushFrame(socket, "terminal:exit", 1, { paneKey: PANE_KEY, code: 130 });
    pushFrame(socket, "terminal:exit", 2, { paneKey: PANE_KEY, code: 130 }); // a duplicate, or another listener's retry

    expect(exits).toBe(1);
  });

  it("ignores a terminal:exit push for a different pane on the same channel", () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["terminal:exit"]);
    let exits = 0;
    watchTerminalExit({ client, paneKey: PANE_KEY, onExit: () => (exits += 1) });

    pushFrame(socket, "terminal:exit", 1, { paneKey: "tab-1:p2", code: 0 });

    expect(exits).toBe(0);
  });

  it("close() sends a sub drop for the pane's terminal:exit keyed subscription", () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["terminal:exit"]);
    const watcher = watchTerminalExit({ client, paneKey: PANE_KEY, onExit: () => {} });

    watcher.close();

    const drop = parsedFrames(socket).find((f) => f.t === "sub" && f.drop !== undefined);
    expect(drop?.drop).toEqual([{ ch: "terminal:exit", key: PANE_KEY }]);
  });

  it("never calls onExit once closed", () => {
    const { client, transport } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["terminal:exit"]);
    let exits = 0;
    const watcher = watchTerminalExit({ client, paneKey: PANE_KEY, onExit: () => (exits += 1) });
    watcher.close();

    pushFrame(socket, "terminal:exit", 1, { paneKey: PANE_KEY, code: 130 });

    expect(exits).toBe(0);
  });

  // [bite-proof: stand-in for a screen-level test proving
  // [paneKey].tsx's own cleanup releases both keyed subscriptions —
  // apps/mobile/vitest.config.mts only collects `src/**/*.test.ts`, so
  // app/terminal/[paneKey].tsx's own effect cleanup can't be exercised by
  // a render here. This proves the underlying wire behavior the screen's
  // cleanup relies on: closing the stream and the exit watcher together
  // (exactly the order [paneKey].tsx's own cleanup calls them in) drops
  // both terminal:data and terminal:exit keyed subscriptions, never only
  // one. If the screen ever stopped calling one of these two `close()`s,
  // this test would keep passing (it drives both directly) — what it
  // guards is that dropping both together really does clear both
  // subscriptions on the wire, not that the screen remembers to call both.]
  it("releasing a pane's stream and exit watcher together drops both keyed subscriptions", () => {
    const { client, transport, clock } = createEnv();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["terminal:data", "terminal:exit"]);
    const stream = createStream(client, clock);
    const watcher = watchTerminalExit({ client, paneKey: PANE_KEY, onExit: () => {} });
    stream.open(createRecordingSink());

    // The screen's own cleanup order: stream.close() then
    // exitWatcher.close() — see app/terminal/[paneKey].tsx.
    stream.close();
    watcher.close();

    const dropped = parsedFrames(socket)
      .filter((f) => f.t === "sub" && f.drop !== undefined)
      .flatMap((f) => (f.drop as unknown[] | undefined) ?? []);
    expect(dropped).toContainEqual({ ch: "terminal:data", key: PANE_KEY });
    expect(dropped).toContainEqual({ ch: "terminal:exit", key: PANE_KEY });
  });
});

// task-7-brief.md's test list names two cases the original round (8781445)
// never added: "Arabic labels with LTR terminal content" and "repeated
// ready cannot flood snapshots" for the pane screen. Both are source scans
// of app/terminal/[paneKey].tsx, in the same style as
// changes-screen.test.ts's own "diff block stays LTR under the Arabic UI"
// describe block and voice-screen.test.ts's "source scan" describe blocks
// — there is no rendered-screen test here for the same reason the
// cleanup bite-proof above stands in for one (vitest only collects
// `src/**/*.test.ts`).
describe("source scan: app/terminal/[paneKey].tsx (task-7-brief.md's test list)", () => {
  const screenSource = readFileSync(
    join(HERE, "..", "..", "app", "terminal", "[paneKey].tsx"),
    "utf8",
  );

  describe(
    "Arabic labels with LTR terminal content " +
      "[bite-proof: add a writingDirection/direction prop to the KeyBar or " +
      "TerminalWebView element here and this fails]",
    () => {
      it("renders the shared, always-LTR TerminalWebView and KeyBar components, not a local re-implementation", () => {
        expect(screenSource).toContain('from "@/components/TerminalWebView"');
        expect(screenSource).toContain('from "@/components/KeyBar"');
        expect(screenSource).toMatch(/<TerminalWebView\b/);
        expect(screenSource).toMatch(/<KeyBar\b/);
      });

      it("never overrides either element with a writingDirection/direction prop of its own", () => {
        const keyBarTag = screenSource.match(/<KeyBar\b[\s\S]*?\/>/)?.[0] ?? "";
        const webViewStart = screenSource.indexOf("<TerminalWebView");
        const webViewEnd = screenSource.indexOf("/>", webViewStart);
        const webViewTag = screenSource.slice(webViewStart, webViewEnd);
        expect(keyBarTag).not.toMatch(/writingDirection|direction=/);
        expect(webViewTag).not.toMatch(/writingDirection|direction=/);
      });

      it("still localizes the screen's own labels (title/notFound/exited) through t(language, ...)", () => {
        expect(screenSource).toMatch(/t\(language,\s*"terminal\.notFound"\)/);
        expect(screenSource).toMatch(/t\(language,\s*"terminal\.exited"\)/);
      });
    },
  );

  describe(
    "repeated ready cannot flood snapshots " +
      "[bite-proof: move `streamRef.current?.restart(sink)` from onNeedsReplay " +
      "into onReady here and this fails]",
    () => {
      it("onReady never restarts the stream — only onNeedsReplay does", () => {
        const readyStart = screenSource.indexOf("onReady={");
        const resizeStart = screenSource.indexOf("onResize={", readyStart);
        const onReadyBlock = screenSource.slice(readyStart, resizeStart);
        expect(onReadyBlock.length).toBeGreaterThan(0);
        expect(onReadyBlock).not.toMatch(/restart\(/);
        expect(screenSource).toMatch(
          /onNeedsReplay=\{\(\)\s*=>\s*streamRef\.current\?\.restart\(sink\)\}/,
        );
      });
    },
  );
});
