// M9 Task 8: the phone-side end-to-end scenarios for the Workspace/Changes/
// Docker/API/history surfaces T1-T7 each cover in isolation, in the style
// of e2e.test.ts/e2e-session.test.ts/e2e-voice.test.ts — a real
// `createRpcClient` over a `FakeTransport` and a fake clock, wired to the
// real store each screen actually uses (workspace-store.ts, terminal-
// stream.ts/terminal-input.ts, changes-store.ts, docker-store.ts/docker-
// log-stream.ts, history-store.ts, api-store.ts, file-upload-controller.ts).
// Nothing here opens a real socket, and no test reaches the installed app.
import { CLOSE, FILE_UPLOAD_CHANNEL, PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./lib/clock";
import type { FakeSocket } from "./lib/fake-transport";
import { createFakeTransport } from "./lib/fake-transport";
import type { FilePicker } from "./lib/file-picker";
import type { UploadFiles } from "./lib/file-upload-controller";
import { createFileUploadController } from "./lib/file-upload-controller";
import { createApiStore } from "./lib/api-store";
import { MUTATION_OFFLINE_NOTICE, createChangesStore } from "./lib/changes-store";
import { DOCKER_LOG_GAP_MARKER, createDockerLogStream } from "./lib/docker-log-stream";
import { createHistoryStore } from "./lib/history-store";
import type { Credential, Endpoint } from "./lib/rpc-client";
import { createRpcClient } from "./lib/rpc-client";
import { createTerminalInput } from "./lib/terminal-input";
import { createTerminalStream } from "./lib/terminal-stream";
import { createWorkspaceStore, resolvePane } from "./lib/workspace-store";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const CLIENT_STRING = "jarvis-mobile/1.0.0/ios";
const CAPS = [
  "workspace:update",
  "terminal:data",
  "terminal:exit",
  "git:counts",
  "sessions:update",
  "docker:log",
];

type Frame = {
  t: string;
  id?: number;
  ch?: string;
  a?: unknown[];
  add?: unknown[];
  drop?: unknown[];
};

function frames(socket: FakeSocket): Frame[] {
  return socket.sent.map((text) => JSON.parse(text) as Frame);
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function lastMatching(socket: FakeSocket, predicate: (f: Frame) => boolean): Frame {
  const found = frames(socket).filter(predicate).at(-1);
  if (found === undefined) throw new Error("no matching frame found");
  return found;
}

function reqChannels(socket: FakeSocket): string[] {
  return frames(socket)
    .filter((f) => f.t === "req")
    .map((f) => f.ch as string);
}

/** Answers the *most recently sent* `req` for `ch` — safe even when `ch`
 *  has been called before on this socket, since a test always answers one
 *  call before triggering the next to the same channel (the same
 *  discipline e2e-voice.test.ts's own `answer`/`lastMatching` rely on). */
function answerCh(socket: FakeSocket, ch: string, value: unknown): void {
  const req = lastMatching(socket, (f) => f.t === "req" && f.ch === ch);
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "res", id: req.id as number, v: value }),
  });
}

function pushCh(socket: FakeSocket, ch: string, seq: number, payload: unknown): void {
  socket.emit({ kind: "message", text: encodeMessage({ t: "psh", ch, seq, p: payload }) });
}

function latestBlob(socket: FakeSocket): { id: number; ch: string; a: unknown[] } {
  const blob = lastMatching(socket, (f) => f.t === "blob");
  return blob as { id: number; ch: string; a: unknown[] };
}

function answerBlob(socket: FakeSocket, value: unknown): void {
  const blob = latestBlob(socket);
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: blob.id, v: value }) });
}

// No Buffer (apps/mobile has no @types/node): the same minimal base64
// encoder base64-chunks.test.ts uses, built on the DOM `btoa` global.
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

/** Connects, opens the socket, and answers the handshake with `welcome` —
 *  the same three steps every scenario below starts from. Returns the
 *  socket the client is now speaking on. */
function connectAndWelcome(
  transport: ReturnType<typeof createFakeTransport>,
  client: ReturnType<typeof createRpcClient>,
  caps: string[] = CAPS,
): FakeSocket {
  client.connect(ENDPOINT, CREDENTIAL);
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: caps }),
  });
  return socket;
}

function buildHarness(): {
  transport: ReturnType<typeof createFakeTransport>;
  clock: ReturnType<typeof createFakeClock>;
  client: ReturnType<typeof createRpcClient>;
  logs: string[];
} {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const logs: string[] = [];
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: CLIENT_STRING,
    log: (line) => logs.push(line),
  });
  return { transport, clock, client, logs };
}

describe("workspace.e2e: Workspace panes, Changes, uploads/Postman import, api:send, Docker follow and history — over the real client and stores", () => {
  it("workspace: initial snapshot -> pane subscribe/snapshot -> exact input, and never a laptop tab mutation", async () => {
    const { transport, clock, client, logs } = buildHarness();
    const socket = connectAndWelcome(transport, client);
    expect(client.state()).toBe("open");

    const workspaceStore = createWorkspaceStore({ client });
    workspaceStore.open();
    await flush();
    answerCh(socket, "projects:list", ["acme"]);
    answerCh(socket, "workspace:snapshot", {
      tabs: [
        {
          id: "tab-1",
          project: "acme",
          url: "",
          kind: "terminal",
          title: "Terminal",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
        },
      ],
      activeTabId: "tab-1",
    });
    await flush();
    expect(workspaceStore.get().projects).toEqual([
      { name: "acme", tabs: [expect.objectContaining({ id: "tab-1" })] },
    ]);

    workspaceStore.readPanes("tab-1");
    await flush();
    const panesReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "terminal:panes");
    expect(panesReq.a).toEqual(["tab-1"]);
    answerCh(socket, "terminal:panes", [{ paneKey: "tab-1", exited: false }]);
    await flush();
    expect(workspaceStore.get().panes).toEqual([{ paneKey: "tab-1", exited: false }]);
    expect(resolvePane(workspaceStore.get().panes, "tab-1")).toEqual({
      paneKey: "tab-1",
      exited: false,
    });
    // Rule 6/controller ruling (g): a paneKey the inventory does not carry
    // never resolves — the caller must not attach to it.
    expect(resolvePane(workspaceStore.get().panes, "no-such-pane")).toBeUndefined();

    // Attach the pane's own stream: subscribes terminal:data first (M7
    // ruling 10), then requests a snapshot.
    const written: string[] = [];
    const sink = {
      write: (data: string) => written.push(data),
      reset: () => {},
    };
    const stream = createTerminalStream({
      client,
      paneKey: "tab-1",
      log: (line) => logs.push(line),
      clock,
    });
    stream.open(sink);
    await flush();
    const subFrame = lastMatching(socket, (f) => f.t === "sub");
    expect(subFrame.add).toEqual([{ ch: "terminal:data", key: "tab-1" }]);
    answerCh(socket, "terminal:snapshot", { text: "", end: 0 });
    await flush();
    expect(stream.get().phase).toBe("live");

    pushCh(socket, "terminal:data", 1, { paneKey: "tab-1", chunk: "hello\n", offset: 0 });
    await flush();
    expect(written).toEqual(["hello\n"]);

    // Exact input: the phone never appends Enter on its own (global
    // constraint 6) — the text lands on the wire exactly as typed.
    const input = createTerminalInput({
      client,
      paneKey: "tab-1",
      clock,
      log: (line) => logs.push(line),
    });
    const sendPromise = input.sendText("ls -la");
    await flush();
    const inputReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "terminal:input");
    expect(inputReq.a).toEqual(["tab-1", "ls -la"]);
    answerCh(socket, "terminal:input", "ok");
    await expect(sendPromise).resolves.toEqual({ kind: "sent" });

    // No laptop view/tab activation: neither the store, the stream nor the
    // input ever sends a tab/pane-mutating channel.
    const sentChannels = reqChannels(socket);
    for (const forbidden of [
      "workspace:open",
      "workspace:close",
      "workspace:activate",
      "workspace:navigate",
      "terminal:open",
      "terminal:split",
      "terminal:closePane",
    ]) {
      expect(sentChannels).not.toContain(forbidden);
    }

    // No credentials/content in logs: terminal-stream.ts's and
    // terminal-input.ts's own logging discipline carries only phase/id/
    // length, never the bytes themselves — the pane's actual output and
    // the actual keystrokes sent must never appear in a log line.
    const joinedLogs = logs.join("\n");
    expect(joinedLogs).not.toContain("hello\n");
    expect(joinedLogs).not.toContain("ls -la");

    stream.close();
    workspaceStore.close();
  });

  it("changes: stage/commit reach the wire with exact args, git:counts drives an authoritative refresh, and an offline mutation is refused rather than queued", async () => {
    const { transport, clock, client } = buildHarness();
    const socket = connectAndWelcome(transport, client);

    function changesPayload(staged: boolean) {
      return {
        ok: true,
        value: {
          session: {
            id: "session-1",
            project: "acme",
            projectPath: "/p/acme",
            agentId: "claude",
            lastActivityAt: 1,
            endedAt: undefined,
          },
          changes: {
            repoPath: "/p/acme",
            branch: "main",
            detached: false,
            insertions: 1,
            deletions: 0,
            files: [{ path: "a.ts", status: "M", insertions: 1, deletions: 0, staged }],
          },
        },
      };
    }

    const changesStore = createChangesStore({ client });
    changesStore.open("session-1");
    await flush();
    answerCh(socket, "git:changes", changesPayload(false));
    await flush();
    expect(changesStore.get().changes?.changes.files[0]?.staged).toBe(false);
    const changesCallsAfterOpen = reqChannels(socket).filter((ch) => ch === "git:changes").length;

    // Stage: exact args, and the store re-reads authoritatively afterward
    // rather than trusting the mutation's own bare success.
    const stagePromise = changesStore.setStaged("a.ts", true);
    await flush();
    const stageReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "git:setStaged");
    expect(stageReq.a).toEqual(["session-1", "a.ts", true]);
    answerCh(socket, "git:setStaged", { ok: true, value: null });
    await flush();
    answerCh(socket, "git:changes", changesPayload(true));
    await stagePromise;
    await flush();
    expect(changesStore.get().changes?.changes.files[0]?.staged).toBe(true);
    expect(reqChannels(socket).filter((ch) => ch === "git:changes").length).toBeGreaterThan(
      changesCallsAfterOpen,
    );

    // Commit: exact args.
    const commitPromise = changesStore.commit("fix: a");
    await flush();
    const commitReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "git:commit");
    expect(commitReq.a).toEqual(["session-1", "fix: a"]);
    answerCh(socket, "git:commit", { ok: true, value: null });
    await flush();
    answerCh(socket, "git:changes", changesPayload(false));
    await commitPromise;
    await flush();

    // Authoritative refresh via a live git:counts push — not merely the
    // mutation's own follow-up — proves the store never sits on stale
    // state between mutations either.
    const beforePush = reqChannels(socket).filter((ch) => ch === "git:changes").length;
    pushCh(socket, "git:counts", 1, {});
    await flush();
    answerCh(socket, "git:changes", changesPayload(false));
    await flush();
    expect(reqChannels(socket).filter((ch) => ch === "git:changes").length).toBeGreaterThan(
      beforePush,
    );

    // Drop the socket: a mutation attempted while disconnected is refused
    // locally and never reaches the wire at all — global constraint 5,
    // "no mutation queued for reconnect".
    socket.emit({ kind: "close", code: 1006, reason: "drop" });
    await flush();
    expect(client.state()).toBe("reconnecting");
    const offlineStage = changesStore.setStaged("a.ts", false);
    await flush();
    expect(changesStore.get().notice).toBe(MUTATION_OFFLINE_NOTICE);

    clock.advance(1000);
    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    socket2.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    await flush();
    expect(reqChannels(socket2)).not.toContain("git:setStaged");
    await offlineStage;
  });

  it("upload -> bounded Postman import: pick, stage, read the JSON back by id (never a path), then import", async () => {
    const { transport, client, logs } = buildHarness();
    const socket = connectAndWelcome(transport, client);

    const secretMarker = "collection-marker-9F3A";
    const collection = {
      info: {
        name: `demo-${secretMarker}`,
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/",
      },
      item: [{ name: "GET /health", request: { method: "GET", url: "https://x/health" } }],
    };
    const collectionBytes = new TextEncoder().encode(JSON.stringify(collection));
    const base64 = encodeBase64(collectionBytes);

    const removed: string[] = [];
    const picker: FilePicker = {
      pick: async () => ({
        uri: "file:///picked/c.json",
        name: "c.json",
        contentType: "application/json",
        bytes: collectionBytes.length,
      }),
    };
    const files: UploadFiles = {
      readBase64: async (uri) => {
        expect(uri).toBe("file:///picked/c.json"); // only the file the OS picker returned is ever read
        return base64;
      },
      size: () => collectionBytes.length,
      remove: (uri) => removed.push(uri),
    };
    const controller = createFileUploadController({ client, files, picker });

    const uploadPromise = controller.pickAndUpload();
    await flush();
    const blob = latestBlob(socket);
    expect(blob.ch).toBe(FILE_UPLOAD_CHANNEL);
    expect(blob.a).toEqual([{ name: "c.json", contentType: "application/json" }]);
    const fileId = "1".repeat(32);
    answerBlob(socket, {
      fileId,
      name: "c.json",
      contentType: "application/json",
      bytes: collectionBytes.length,
      expiresAt: Date.now() + 3_600_000,
    });
    const uploadResult = await uploadPromise;
    expect(uploadResult.kind).toBe("ok");
    expect(removed).toEqual(["file:///picked/c.json"]); // the app-local picker copy is always cleaned up

    const readPromise = client.call("remote:readJsonUpload", [fileId]);
    await flush();
    const readReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "remote:readJsonUpload");
    expect(readReq.a).toEqual([fileId]); // never a filesystem path — only the opaque staged id
    answerCh(socket, "remote:readJsonUpload", { ok: true, value: collection });
    const readResult = await readPromise;
    expect(readResult).toEqual({ ok: true, value: { ok: true, value: collection } });

    const apiStore = createApiStore({ client });
    apiStore.open("acme");
    await flush();
    answerCh(socket, "api:collections", { ok: true, value: [] });
    await flush();

    const invokePromise = apiStore.invoke({ kind: "importPostman", name: "demo", collection });
    await flush();
    const importReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "api:importPostman");
    expect(importReq.a).toEqual(["acme", "demo", collection]);
    answerCh(socket, "api:importPostman", { ok: true, value: "acme/demo.bru" });
    await flush();
    answerCh(socket, "api:collections", {
      ok: true,
      value: [{ name: "demo", path: "acme/demo.bru" }],
    });
    await invokePromise;
    await flush();
    expect(apiStore.get().collections).toEqual([{ name: "demo", path: "acme/demo.bru" }]);

    // No credentials/content in logs: the collection's own content never
    // reaches the client's log lines, even while it rode the wire.
    expect(logs.join("\n")).not.toContain(secretMarker);
    apiStore.close();
  });

  it("api:send carries an uploadId multipart attachment and a draft's own script field verbatim to the wire; the answer applies without ever fabricating a scripts block", async () => {
    const { transport, client } = buildHarness();
    const socket = connectAndWelcome(transport, client);

    const apiStore = createApiStore({ client });
    apiStore.open("acme");
    await flush();
    answerCh(socket, "api:collections", { ok: true, value: [] });
    await flush();

    const draft = {
      meta: { name: "send" },
      http: { method: "post", url: "https://x/upload", body: "multipartForm" },
      body: {
        multipartForm: [{ name: "file", type: "file", value: [{ uploadId: "1".repeat(32) }] }],
      },
      // A phone-authored script is part of the draft object like any other
      // field — this file's own remote-workspace.integration.test.ts is
      // where the server-side stripping (M9 Task 4's whole point) is
      // proven; this test only pins that the phone sends its draft as-is
      // and never fabricates a `scripts` result the server didn't send.
      script: { req: "malicious()" },
    };
    apiStore.setDraft(draft);

    const sendPromise = apiStore.invoke({ kind: "send" });
    await flush();
    const sendReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "api:send");
    expect(sendReq.a).toEqual(["acme", draft, {}]);

    answerCh(socket, "api:send", {
      ok: true,
      value: {
        response: {
          status: 200,
          statusText: "OK",
          headers: {},
          body: "{}",
          timeMs: 1,
          bytes: 2,
          unresolved: [],
        },
        assertions: [],
        history: [],
        cookies: [],
        // No `scripts` field at all — the shape a remote send always
        // answers with once the server strips it.
      },
    });
    await sendPromise;
    await flush();

    expect(apiStore.get().busy).toBe(false);
    expect(apiStore.get().lastResponse?.scripts).toBeUndefined();
    apiStore.close();
  });

  it("docker: follow, a live chunk, a reconnect gap marker, and unmount unfollows", async () => {
    const { transport, clock, client } = buildHarness();
    const socket = connectAndWelcome(transport, client);

    let nextId = 0;
    const stream = createDockerLogStream({
      client,
      randomId: () => `remote-${(nextId++).toString(16).padStart(32, "0")}`,
    });

    const followPromise = stream.follow("acme", "web");
    await flush();
    const followReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "docker:follow");
    const followId = (followReq.a as [string, string, string])[0];
    expect(followReq.a).toEqual([followId, "acme", "web"]);
    answerCh(socket, "docker:follow", { ok: true, value: null });
    await followPromise;
    await flush();
    expect(stream.get().phase).toBe("following");
    const subFrame = lastMatching(socket, (f) => f.t === "sub");
    expect(subFrame.add).toEqual([{ ch: "docker:log", key: followId }]);

    pushCh(socket, "docker:log", 1, { tabId: followId, chunk: "log line 1\n" });
    await flush();
    expect(stream.get().text).toBe("log line 1\n");

    // Reconnect: a gap marker is inserted for whatever the drop missed,
    // never pretended away as continuous history (M5 ruling: live logs are
    // not durable).
    socket.emit({ kind: "close", code: 1006, reason: "" });
    await flush();
    expect(stream.get().phase).toBe("waiting");
    clock.advance(1000);
    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    socket2.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    await flush();
    answerCh(socket2, "docker:follow", { ok: true, value: null });
    await flush();
    expect(stream.get().phase).toBe("following");
    expect(stream.get().text).toContain(DOCKER_LOG_GAP_MARKER);

    // Unmount: close() best-effort unfollows the live id and drops the
    // local keyed subscription.
    stream.close();
    await flush();
    const unfollowReq = lastMatching(socket2, (f) => f.t === "req" && f.ch === "docker:unfollow");
    expect(unfollowReq).toBeDefined();
    expect(stream.get().phase).toBe("idle");
  });

  it("history and transcript reads are the only channels this screen ever sends — never session:resume/session:input", async () => {
    const { transport, client } = buildHarness();
    const socket = connectAndWelcome(transport, client);

    const historyStore = createHistoryStore({ client });
    historyStore.open();
    await flush();
    const historyReq = lastMatching(socket, (f) => f.t === "req" && f.ch === "history:list");
    expect(historyReq.a).toEqual([]);
    answerCh(socket, "history:list", [
      {
        id: "s1",
        project: "acme",
        projectPath: "/p/acme",
        agentId: "claude",
        state: "done",
        summary: "did x",
        startedAt: 1,
        lastActivityAt: 2,
      },
    ]);
    await flush();
    expect(historyStore.get().sessions).toHaveLength(1);

    historyStore.select("s1");
    await flush();
    const transcriptReq = lastMatching(
      socket,
      (f) => f.t === "req" && f.ch === "session:transcript",
    );
    expect(transcriptReq.a).toEqual(["s1"]);
    answerCh(socket, "session:transcript", [{ role: "user", text: "hi", tools: [] }]);
    await flush();
    expect(historyStore.get().transcript).toEqual([{ role: "user", text: "hi", tools: [] }]);

    const sentChannels = reqChannels(socket);
    expect(sentChannels).not.toContain("session:resume");
    expect(sentChannels).not.toContain("session:input");
    historyStore.close();
  });

  it("revocation mid-upload resolves the pending upload offline, the client goes unpaired with no auto-reconnect, and nothing is queued or logged", async () => {
    const { transport, client, logs } = buildHarness();
    const socket = connectAndWelcome(transport, client);

    const picker: FilePicker = {
      pick: async () => ({
        uri: "file:///picked/c.json",
        name: "c.json",
        contentType: "application/json",
        bytes: 2,
      }),
    };
    const files: UploadFiles = {
      readBase64: async () => "e30=", // "{}"
      size: () => 2,
      remove: () => {},
    };
    const controller = createFileUploadController({ client, files, picker });

    const uploadPromise = controller.pickAndUpload();
    await flush();
    expect(latestBlob(socket).ch).toBe(FILE_UPLOAD_CHANNEL);

    // The laptop revokes this device mid-upload — a 4410 close arrives
    // before any res/err for the blob.
    socket.emit({ kind: "close", code: CLOSE.revoked, reason: "" });
    await flush();
    const result = await uploadPromise;
    expect(result.kind).toBe("offline");
    expect(client.state()).toBe("unpaired");

    // Terminal/unpaired (ruling I5): a later call is refused immediately —
    // never queued for a future reconnect under a different pairing — and
    // no automatic reconnect happens at all.
    const laterCall = client.call("api:send", ["acme", {}, {}], { whenNotOpen: "reject" });
    await expect(laterCall).resolves.toEqual({ ok: false, error: { kind: "offline" } });
    expect(transport.sockets).toHaveLength(1);

    // The token never appears in a log line anywhere across this run.
    expect(logs.join("\n")).not.toContain(CREDENTIAL.token);
  });
});
