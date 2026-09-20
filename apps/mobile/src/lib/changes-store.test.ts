import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import {
  createChangesStore,
  MUTATION_OFFLINE_NOTICE,
  MUTATION_SESSION_CHANGED_NOTICE,
} from "./changes-store";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import { MALFORMED_REPLY_NOTICE } from "./workspace-results";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };

function createEnv(capabilities = ["git:counts", "sessions:update"]) {
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
  client.connect(ENDPOINT, CREDENTIAL);
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return { client, transport, clock, logs, socket };
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function frames(socket: FakeSocket): Array<{ t: string; id?: number; ch?: string; a?: unknown[] }> {
  return socket.sent.map((text) => JSON.parse(text));
}

function reqs(socket: FakeSocket, ch?: string) {
  return frames(socket).filter(
    (frame) => frame.t === "req" && (ch === undefined || frame.ch === ch),
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function answer(socket: FakeSocket, id: number, value: unknown): Promise<void> {
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id, v: value }) });
  await flush();
}

async function fail(socket: FakeSocket, id: number, text: string): Promise<void> {
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "err", id, code: "internal", text, language: "en" }),
  });
  await flush();
}

// M12 Task 8: `git:changes`/`git:diff` answer with a domain-level
// `GitViewResult<T>` inside the RPC `res` (packages/desktop/src/ipc.ts) —
// `parseGitViewResult` now refuses anything that isn't already enveloped
// as `{ok:true,value}`/`{ok:false,text,language}`, so these fixtures wrap
// their payload the same way the real wire does, rather than the bare
// value the removed fallback used to tolerate.
function changes(id = "s1", overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      session: {
        id,
        project: "jarvis",
        projectPath: "/repo",
        agentId: "codex",
        lastActivityAt: 10,
        endedAt: undefined,
      },
      changes: {
        repoPath: "/repo",
        branch: "main",
        detached: false,
        files: [
          { path: "src/واجهة.ts", status: "M", insertions: 2, deletions: 1, staged: false },
          { path: "src/index.ts", status: "M", insertions: 1, deletions: 0, staged: true },
        ],
        insertions: 3,
        deletions: 1,
      },
      ...overrides,
    },
  };
}

function diff(path: string, text = "new") {
  return {
    ok: true,
    value: {
      path,
      binary: false,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [{ kind: "added", text, beforeLine: undefined, afterLine: 1 }],
        },
      ],
    },
  };
}

describe("createChangesStore", () => {
  it("opens a session, subscribes visible update channels, loads changes, then selects the first file diff", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });

    store.open("s1");
    expect(frames(socket).filter((frame) => frame.t === "sub")).toEqual([
      { t: "sub", add: ["git:counts"] },
      { t: "sub", add: ["sessions:update"] },
    ]);
    expect(reqs(socket, "git:changes")[0]).toMatchObject({ ch: "git:changes", a: ["s1"] });

    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());
    expect(reqs(socket, "git:diff")[0]).toMatchObject({
      ch: "git:diff",
      a: ["s1", "src/واجهة.ts"],
    });

    await answer(socket, reqs(socket, "git:diff")[0]?.id as number, diff("src/واجهة.ts"));
    expect(store.get()).toMatchObject({
      sessionId: "s1",
      phase: "ready",
      stale: false,
      busy: false,
      uncertain: false,
      diff: { path: "src/واجهة.ts" },
    });
  });

  it(
    "a bare (non-enveloped) git:changes reply — a real ChangesView-shaped object " +
      "with no ok/value wrapper — is a parse failure, never treated as a bare " +
      "success value [bite-proof: keep parseGitViewResult's old bare-value " +
      "fallback and this is treated as ok]",
    async () => {
      const { client, socket } = createEnv();
      const store = createChangesStore({ client });

      store.open("s1");
      // `changes().value` is exactly what a well-formed enveloped reply's
      // `value` field holds — sent bare (no `{ok:true,value:...}` wrapper),
      // it still shapes up as a valid ChangesView on its own, which is
      // precisely how the removed fallback slipped through undetected.
      await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes().value);

      expect(store.get().phase).toBe("failed");
      expect(store.get().stale).toBe(true);
      expect(store.get().notice).toBe(MALFORMED_REPLY_NOTICE);
      expect(store.get().changes).toBeUndefined();
    },
  );

  it("shows ended-session warning while rendering current working tree changes", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });

    store.open("s1");
    await answer(
      socket,
      reqs(socket, "git:changes")[0]?.id as number,
      changes("s1", {
        session: {
          id: "s1",
          project: "jarvis",
          projectPath: "/repo",
          agentId: "codex",
          lastActivityAt: 10,
          endedAt: 99,
        },
      }),
    );

    expect(store.get().notice).toBe("ended-session-current-tree");
  });

  it("coalesces refresh pushes to one in-flight request plus one pending refresh", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });

    store.open("s1");
    const initial = reqs(socket, "git:changes")[0]?.id as number;

    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "psh", ch: "git:counts", seq: 1, p: [] }),
    });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "psh", ch: "sessions:update", seq: 2, p: [] }),
    });
    expect(reqs(socket, "git:changes")).toHaveLength(1);

    await answer(socket, initial, changes());
    await flush();
    expect(reqs(socket, "git:changes")).toHaveLength(2);
  });

  it("ignores late diffs for a previous selection", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });

    store.open("s1");
    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());
    const firstDiffId = reqs(socket, "git:diff")[0]?.id as number;

    store.selectFile("src/index.ts");
    const secondDiffId = reqs(socket, "git:diff")[1]?.id as number;
    await answer(socket, secondDiffId, diff("src/index.ts", "index"));
    await answer(socket, firstDiffId, diff("src/واجهة.ts", "late"));

    expect(store.get().diff?.path).toBe("src/index.ts");
    expect(store.get().diff?.hunks[0]?.lines[0]?.text).toBe("index");
  });

  it("sends explicit staged true/false for index (stage) and worktree (unstage) toggling", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });
    store.open("s1");
    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());

    const staging = store.setStaged("src/واجهة.ts", true);
    await flush();
    expect(reqs(socket, "git:setStaged")[0]).toMatchObject({
      ch: "git:setStaged",
      a: ["s1", "src/واجهة.ts", true],
    });
    await answer(socket, reqs(socket, "git:setStaged")[0]?.id as number, null);
    await staging;

    const unstaging = store.setStaged("src/واجهة.ts", false);
    await flush();
    expect(reqs(socket, "git:setStaged")[1]).toMatchObject({
      ch: "git:setStaged",
      a: ["s1", "src/واجهة.ts", false],
    });
    await answer(socket, reqs(socket, "git:setStaged")[1]?.id as number, null);
    await unstaging;
  });

  it("passes a commit conflict failure text through verbatim, distinct from nothing-staged", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });
    store.open("s1");
    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());

    const commit = store.commit("رسالة الحفظ");
    await flush();
    await fail(socket, reqs(socket, "git:commit")[0]?.id as number, "conflict: merge in progress");
    await commit;

    expect(store.get()).toMatchObject({
      busy: false,
      notice: "conflict: merge in progress",
      uncertain: false,
    });
  });

  it("requires an open connection for mutations and does not queue offline", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });
    store.open("s1");
    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());

    socket.emit({ kind: "close", code: 1006, reason: "drop" });
    await store.setStaged("src/واجهة.ts", true);
    await store.commit("رسالة الحفظ");

    expect(reqs(socket, "git:setStaged")).toHaveLength(0);
    expect(reqs(socket, "git:commit")).toHaveLength(0);
    expect(store.get()).toMatchObject({ uncertain: false, stale: true });
  });

  // Fix round 1 (Important 1) bite-proof: the store must give the offline
  // refusal a notice, not just `stale: true` — the screen's draft-retention
  // decision (changes-screen.ts's `shouldClearDraft`) depends on `notice`
  // being set here.
  it("gives an offline mutation refusal a distinct notice so the caller can tell it apart from success", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });
    store.open("s1");
    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());

    socket.emit({ kind: "close", code: 1006, reason: "drop" });
    await store.commit("رسالة الحفظ");

    expect(store.get().notice).toBe(MUTATION_OFFLINE_NOTICE);
  });

  // Fix round 1 (Minor) bite-proof: a mutation queued while session A was
  // open must not fire against session B just because the user switched
  // chips before it got its turn.
  it("drops a queued mutation whose session changed before it ran, instead of sending it against the new one", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });
    store.open("s1");
    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());

    const queued = store.setStaged("src/واجهة.ts", true);
    store.open("s2");
    await answer(socket, reqs(socket, "git:changes")[1]?.id as number, changes("s2"));
    await queued;

    expect(reqs(socket, "git:setStaged")).toHaveLength(0);
  });

  // Fix round 2 (New Breakage 2) bite-proof: a session-switch drop must
  // not claim the connection dropped — it didn't — and must not leave
  // `stale` stuck (its own `refresh()` call, coalesced behind the
  // in-flight `git:changes` from `store.open("s2")`, eventually clears it).
  it(
    "gives a session-switch drop its own notice, distinct from the offline one, and does not " +
      "leave stale stuck",
    async () => {
      const { client, socket } = createEnv();
      const store = createChangesStore({ client });
      store.open("s1");
      await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());

      const queued = store.setStaged("src/واجهة.ts", true);
      store.open("s2"); // sends git:changes[1], left unanswered for now
      await queued;

      expect(store.get().notice).toBe(MUTATION_SESSION_CHANGED_NOTICE);
      expect(store.get().notice).not.toBe(MUTATION_OFFLINE_NOTICE);
      expect(store.get().stale).toBe(true);

      // The drop's own refresh() coalesced behind the in-flight
      // git:changes[1] (refreshInFlight was still true); answering it
      // fires the pending follow-up refresh, which clears stale.
      await answer(socket, reqs(socket, "git:changes")[1]?.id as number, changes("s2"));
      expect(reqs(socket, "git:changes")).toHaveLength(3);
      await answer(socket, reqs(socket, "git:changes")[2]?.id as number, changes("s2"));
      expect(store.get().stale).toBe(false);
    },
  );

  it("gates Commit/Stage on a session having been chosen at all, silently", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });

    await store.commit("رسالة الحفظ");

    expect(reqs(socket, "git:commit")).toHaveLength(0);
    expect(store.get().notice).toBeUndefined();
    expect(store.get().stale).toBe(false);
  });

  it("serializes duplicate mutation taps and refreshes after a failed commit without clearing the draft externally", async () => {
    const { client, socket } = createEnv();
    const store = createChangesStore({ client });
    store.open("s1");
    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());

    const first = store.setStaged("src/واجهة.ts", true);
    const duplicate = store.setStaged("src/واجهة.ts", false);
    await flush();
    expect(reqs(socket, "git:setStaged")).toHaveLength(1);
    await answer(socket, reqs(socket, "git:setStaged")[0]?.id as number, null);
    await first;
    await flush();
    expect(reqs(socket, "git:setStaged")).toHaveLength(2);
    await answer(socket, reqs(socket, "git:setStaged")[1]?.id as number, null);
    await duplicate;
    expect(reqs(socket, "git:setStaged")).toHaveLength(2);

    const commit = store.commit("رسالة الحفظ");
    await flush();
    await fail(socket, reqs(socket, "git:commit")[0]?.id as number, "nothing staged");
    await commit;
    expect(store.get()).toMatchObject({ busy: false, notice: "nothing staged", uncertain: false });
    expect(reqs(socket, "git:changes").length).toBeGreaterThanOrEqual(2);
  });

  it("marks timeout mutations uncertain and starts an authoritative refresh", async () => {
    const { client, socket, clock } = createEnv();
    const store = createChangesStore({ client });
    store.open("s1");
    await answer(socket, reqs(socket, "git:changes")[0]?.id as number, changes());

    const pending = store.commit("رسالة الحفظ");
    await flush();
    clock.advance(30_000);
    await pending;

    expect(store.get().uncertain).toBe(true);
    expect(reqs(socket, "git:changes").length).toBeGreaterThanOrEqual(2);
  });
});
