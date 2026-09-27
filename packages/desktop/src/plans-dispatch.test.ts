// Task 5: the plans:* dispatch handlers — routing to Tasks 3/4's own
// PlanFiles/PlanCommentStore fakes, the remote-caller defence
// (isAllowed re-checked at the handler boundary), and plans:send's own
// bracketed-paste write into a fake shell. dispatch.test.ts's own
// `fakeDeps` already seeds a `plans` fake (files/comments/isDirectory);
// this file only overrides what each test cares about, the same pattern
// remote-workspace.integration.test.ts already follows for a different
// channel group.
import type { PlanBlock } from "@jarvis/core";
import { describe, expect, it, vi } from "vitest";
import { CHANNEL_POLICY, REMOTE_EFFECT } from "./remote-policy.js";
import { createDispatchTable, DESKTOP_ORIGIN, type Origin } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";

const REMOTE_ORIGIN: Origin = { kind: "remote", deviceId: "d1", deviceName: "Phone" };

const callAs = (
  table: ReturnType<typeof createDispatchTable>,
  origin: Origin,
  channel: string,
  ...args: unknown[]
) =>
  (table as Record<string, (a: readonly unknown[], o: Origin) => unknown>)[channel]!(args, origin);

const call = (table: ReturnType<typeof createDispatchTable>, channel: string, ...args: unknown[]) =>
  callAs(table, DESKTOP_ORIGIN, channel, ...args);

const BLOCK: PlanBlock = {
  id: "b1",
  kind: "paragraph",
  start: 0,
  end: 1,
  source: "Do the thing.",
  html: "<p>Do the thing.</p>",
};

const PLAN_DOC = { path: "/plans/x.md", mtimeMs: 100, blocks: [BLOCK] };

describe("plans:* dispatch: routing", () => {
  it("plans:list uses the given cwd when it equals the pane's own start directory", async () => {
    const list = vi.fn(async () => ({ session: undefined, planMode: [], repo: [] }));
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        files: { ...fakeDeps().plans.files, list },
        isDirectory: vi.fn(async (path: string) => path === "/repo"),
      },
      terminal: { ...fakeDeps().terminal, paneStartDir: vi.fn(() => "/repo") },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:list", "pane-1", "/repo");

    expect(list).toHaveBeenCalledWith("/repo");
    expect(result).toEqual({ session: undefined, planMode: [], repo: [] });
  });

  it("plans:list uses the given cwd when it is inside a configured project root", async () => {
    const list = vi.fn(async () => ({ session: undefined, planMode: [], repo: [] }));
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        files: { ...fakeDeps().plans.files, list },
        isDirectory: vi.fn(async () => true),
        projectRoots: vi.fn(() => ["/home/user/project"]),
      },
    });
    const table = createDispatchTable(deps);

    await call(table, "plans:list", "pane-1", "/home/user/project/packages/desktop");

    expect(list).toHaveBeenCalledWith("/home/user/project/packages/desktop");
  });

  it("plans:list falls back to the pane's own recorded start directory when cwd does not exist", async () => {
    const list = vi.fn(async () => ({ session: undefined, planMode: [], repo: [] }));
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        files: { ...fakeDeps().plans.files, list },
        isDirectory: vi.fn(async () => false),
      },
      terminal: { ...fakeDeps().terminal, paneStartDir: vi.fn(() => "/pane/start") },
    });
    const table = createDispatchTable(deps);

    await call(table, "plans:list", "pane-1", "/does/not/exist");

    expect(list).toHaveBeenCalledWith("/pane/start");
  });

  it("plans:list refuses a cwd outside both the pane's start dir and every project root, even if it exists (stops remote directory probing)", async () => {
    const list = vi.fn(async () => ({ session: undefined, planMode: [], repo: [] }));
    const isDirectory = vi.fn(async () => true);
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        files: { ...fakeDeps().plans.files, list },
        isDirectory,
        projectRoots: vi.fn(() => ["/home/user/project"]),
      },
      terminal: { ...fakeDeps().terminal, paneStartDir: vi.fn(() => "/pane/start") },
    });
    const table = createDispatchTable(deps);

    await callAs(table, REMOTE_ORIGIN, "plans:list", "pane-1", "/etc");

    // Never even reaches the filesystem check for the out-of-bounds
    // candidate — the containment check runs first.
    expect(isDirectory).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith("/pane/start");
  });

  it("plans:read returns PlanFiles.read's own value for an allowed path", async () => {
    const read = vi.fn(async () => ({ ok: true as const, value: PLAN_DOC }));
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, files: { ...fakeDeps().plans.files, read } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:read", "/plans/x.md");

    expect(read).toHaveBeenCalledWith("/plans/x.md");
    expect(result).toEqual({ ok: true, value: PLAN_DOC });
  });

  it("plans:writeBlock forwards to PlanFiles.writeBlock for an allowed path", async () => {
    const writeBlock = vi.fn(async () => ({ ok: true as const, value: PLAN_DOC }));
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, files: { ...fakeDeps().plans.files, writeBlock } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:writeBlock", "/plans/x.md", "b1", "New text.", 100);

    expect(writeBlock).toHaveBeenCalledWith("/plans/x.md", "b1", "New text.", 100);
    expect(result).toEqual({ ok: true, value: PLAN_DOC });
  });

  it("plans:writeBlock rejects an oversized source before ever reaching PlanFiles", async () => {
    const writeBlock = vi.fn(async () => ({ ok: true as const, value: PLAN_DOC }));
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, files: { ...fakeDeps().plans.files, writeBlock } },
    });
    const table = createDispatchTable(deps);

    const result = await call(
      table,
      "plans:writeBlock",
      "/plans/x.md",
      "b1",
      "x".repeat(1024 * 1024 + 1),
      100,
    );

    expect(writeBlock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "too-large" });
  });

  it("plans:comments anchors PlanCommentStore's own comments against a fresh read", async () => {
    const comment = {
      id: "c1",
      path: "/plans/x.md",
      blockId: "b1",
      quote: "",
      body: "looks good",
      createdAt: 1,
    };
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        comments: { ...fakeDeps().plans.comments, list: vi.fn(async () => [comment]) },
        files: {
          ...fakeDeps().plans.files,
          read: vi.fn(async () => ({ ok: true as const, value: PLAN_DOC })),
        },
      },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:comments", "/plans/x.md");

    expect(result).toEqual([
      { ...comment, number: 1, anchor: { kind: "block", blockId: "b1", text: "Do the thing." } },
    ]);
  });

  it("plans:comments orphans every stored comment when the file can no longer be read", async () => {
    const comment = {
      id: "c1",
      path: "/plans/x.md",
      blockId: "b1",
      quote: "",
      body: "looks good",
      createdAt: 1,
    };
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        comments: { ...fakeDeps().plans.comments, list: vi.fn(async () => [comment]) },
        files: {
          ...fakeDeps().plans.files,
          read: vi.fn(async () => ({ ok: false as const, reason: "forbidden" as const })),
        },
      },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:comments", "/plans/x.md");

    expect(result).toEqual([{ ...comment, number: 1, anchor: { kind: "orphaned" } }]);
  });

  it("plans:addComment forwards to PlanCommentStore.add", async () => {
    const created = {
      id: "c2",
      path: "/plans/x.md",
      blockId: "b1",
      quote: "Do",
      body: "note",
      createdAt: 5,
    };
    const add = vi.fn(async () => created);
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, comments: { ...fakeDeps().plans.comments, add } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:addComment", "/plans/x.md", "b1", "Do", "note");

    expect(add).toHaveBeenCalledWith({
      path: "/plans/x.md",
      blockId: "b1",
      quote: "Do",
      body: "note",
    });
    expect(result).toBe(created);
  });

  it("plans:updateComment forwards to PlanCommentStore.update", async () => {
    const update = vi.fn(async () => undefined);
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, comments: { ...fakeDeps().plans.comments, update } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:updateComment", "c1", "edited");

    expect(update).toHaveBeenCalledWith("c1", "edited");
    expect(result).toBeUndefined();
  });

  it("plans:deleteComment forwards to PlanCommentStore.remove", async () => {
    const remove = vi.fn(async () => true);
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, comments: { ...fakeDeps().plans.comments, remove } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:deleteComment", "c1");

    expect(remove).toHaveBeenCalledWith("c1");
    expect(result).toBe(true);
  });
});

describe("plans:* dispatch: the remote-caller path defence", () => {
  it("rejects a forbidden path with plans:read, remote origin included", async () => {
    const isAllowed = vi.fn(async () => false);
    const read = vi.fn(async () => ({ ok: true as const, value: PLAN_DOC }));
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, files: { ...fakeDeps().plans.files, isAllowed, read } },
    });
    const table = createDispatchTable(deps);

    const result = await callAs(table, REMOTE_ORIGIN, "plans:read", "/etc/passwd");

    expect(isAllowed).toHaveBeenCalledWith("/etc/passwd");
    expect(read).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("rejects a forbidden path with plans:writeBlock too", async () => {
    const isAllowed = vi.fn(async () => false);
    const writeBlock = vi.fn(async () => ({ ok: true as const, value: PLAN_DOC }));
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, files: { ...fakeDeps().plans.files, isAllowed, writeBlock } },
    });
    const table = createDispatchTable(deps);

    const result = await callAs(
      table,
      REMOTE_ORIGIN,
      "plans:writeBlock",
      "/etc/passwd",
      "b1",
      "x",
      1,
    );

    expect(writeBlock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("plans:send refuses a forbidden path before ever touching the comment store or the pane", async () => {
    const isAllowed = vi.fn(async () => false);
    const list = vi.fn(async () => []);
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        files: { ...fakeDeps().plans.files, isAllowed },
        comments: { ...fakeDeps().plans.comments, list },
      },
    });
    const table = createDispatchTable(deps);

    const result = await callAs(table, REMOTE_ORIGIN, "plans:send", "pane-1", "/etc/passwd", [
      "c1",
    ]);

    expect(list).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  // Fix round 1: plans:addComment and plans:comments had skipped this
  // re-check entirely.
  it("plans:addComment rejects a disallowed path, the same rejection style as its other guards", async () => {
    const isAllowed = vi.fn(async () => false);
    const add = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        files: { ...fakeDeps().plans.files, isAllowed },
        comments: { ...fakeDeps().plans.comments, add },
      },
    });
    const table = createDispatchTable(deps);

    await expect(
      callAs(table, REMOTE_ORIGIN, "plans:addComment", "/etc/passwd", "b1", "quote", "body"),
    ).rejects.toThrow();

    expect(isAllowed).toHaveBeenCalledWith("/etc/passwd");
    expect(add).not.toHaveBeenCalled();
  });

  it("plans:comments returns [] for a disallowed path, never the comments stored under it", async () => {
    const isAllowed = vi.fn(async () => false);
    const list = vi.fn(async () => [
      {
        id: "c1",
        path: "/etc/passwd",
        blockId: "b1",
        quote: "",
        body: "should never surface",
        createdAt: 1,
      },
    ]);
    const deps = fakeDeps({
      plans: {
        ...fakeDeps().plans,
        files: { ...fakeDeps().plans.files, isAllowed },
        comments: { ...fakeDeps().plans.comments, list },
      },
    });
    const table = createDispatchTable(deps);

    const result = await callAs(table, REMOTE_ORIGIN, "plans:comments", "/etc/passwd");

    expect(isAllowed).toHaveBeenCalledWith("/etc/passwd");
    expect(list).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe("plans:* dispatch: argument caps", () => {
  const OVER_CAP = "x".repeat(4097);

  it.each([
    ["plans:read", ["/plans/x.md"]] as const,
    ["plans:writeBlock", ["/plans/x.md", "b1", "src", 1]] as const,
    ["plans:comments", ["/plans/x.md"]] as const,
    ["plans:addComment", ["/plans/x.md", "b1", "q", "body"]] as const,
  ])("%s refuses a non-string path", async (channel, args) => {
    const deps = fakeDeps();
    const table = createDispatchTable(deps);
    const badArgs = [123, ...args.slice(1)];

    if (channel === "plans:addComment") {
      await expect(call(table, channel, ...badArgs)).rejects.toThrow();
    } else {
      const result = await call(table, channel, ...badArgs);
      expect(result).toMatchObject(channel === "plans:comments" ? [] : { ok: false });
    }
  });

  it("plans:read refuses a path over 4096 characters", async () => {
    const isAllowed = vi.fn(async () => true);
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, files: { ...fakeDeps().plans.files, isAllowed } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:read", OVER_CAP);

    expect(isAllowed).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, reason: "forbidden" });
  });

  it("plans:comments refuses a path over 4096 characters", async () => {
    const isAllowed = vi.fn(async () => true);
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, files: { ...fakeDeps().plans.files, isAllowed } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:comments", OVER_CAP);

    expect(isAllowed).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("plans:updateComment refuses a non-string id and one over 4096 characters", async () => {
    const update = vi.fn(async () => undefined);
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, comments: { ...fakeDeps().plans.comments, update } },
    });
    const table = createDispatchTable(deps);

    expect(await call(table, "plans:updateComment", 123, "body")).toBeUndefined();
    expect(await call(table, "plans:updateComment", OVER_CAP, "body")).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it("plans:deleteComment refuses a non-string id and one over 4096 characters", async () => {
    const remove = vi.fn(async () => true);
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, comments: { ...fakeDeps().plans.comments, remove } },
    });
    const table = createDispatchTable(deps);

    expect(await call(table, "plans:deleteComment", 123)).toBe(false);
    expect(await call(table, "plans:deleteComment", OVER_CAP)).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("plans:* dispatch: store failures never crash the handler", () => {
  it("plans:updateComment maps a store throw onto undefined", async () => {
    const update = vi.fn(async () => {
      throw new Error("invalid body");
    });
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, comments: { ...fakeDeps().plans.comments, update } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:updateComment", "c1", "x".repeat(5000));

    expect(result).toBeUndefined();
  });

  it("plans:deleteComment maps a store throw onto false", async () => {
    const remove = vi.fn(async () => {
      throw new Error("io error");
    });
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, comments: { ...fakeDeps().plans.comments, remove } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:deleteComment", "c1");

    expect(result).toBe(false);
  });

  it("plans:comments maps a comment-store throw onto []", async () => {
    const list = vi.fn(async () => {
      throw new Error("corrupt file");
    });
    const deps = fakeDeps({
      plans: { ...fakeDeps().plans, comments: { ...fakeDeps().plans.comments, list } },
    });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:comments", "/plans/x.md");

    expect(result).toEqual([]);
  });
});

describe("plans:send", () => {
  const comment = {
    id: "c1",
    path: "/plans/x.md",
    blockId: "b1",
    quote: "",
    body: "looks good",
    createdAt: 1,
  };

  function sendDeps(overrides: { list?: (typeof comment)[]; paneExited?: boolean } = {}) {
    const write = vi.fn();
    const markSent = vi.fn(async () => undefined);
    const deps = fakeDeps({
      shells: {
        log: vi.fn(() => ""),
        snapshot: vi.fn(() => ({ text: "", end: 0 })),
        // "pane-1" is what every test in this block calls plans:send
        // with, except the dedicated "unknown pane" test below, which
        // uses a paneKey ("ghost-pane") that never appears here at all.
        panes: vi.fn(() => [{ paneKey: "pane-1", exited: overrides.paneExited ?? false }]),
        write,
      },
      plans: {
        ...fakeDeps().plans,
        files: {
          ...fakeDeps().plans.files,
          isAllowed: vi.fn(async () => true),
          read: vi.fn(async () => ({ ok: true as const, value: PLAN_DOC })),
        },
        comments: {
          ...fakeDeps().plans.comments,
          list: vi.fn(async () => overrides.list ?? [comment]),
          markSent,
        },
      },
    });
    return { deps, write, markSent };
  }

  it("writes exactly the bracketed-paste bytes to the fake shell and marks the comment sent", async () => {
    const { deps, write, markSent } = sendDeps();
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:send", "pane-1", "/plans/x.md", ["c1"]);

    expect(result).toEqual({ ok: true, sent: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    const [paneKey, bytes] = write.mock.calls[0] as [string, string];
    expect(paneKey).toBe("pane-1");
    expect(bytes.startsWith("\u001b[200~")).toBe(true);
    expect(bytes.endsWith("\u001b[201~\r")).toBe(true);
    expect(bytes).toBe(
      `\u001b[200~Comments on /plans/x.md:\n\n1. On the section "Do the thing.": looks good\n\nPlease update the plan to address these.\u001b[201~\r`,
    );
    expect(markSent).toHaveBeenCalledWith(["c1"]);
  });

  it("returns no-comments and never touches the pane when no ids match", async () => {
    const { deps, write, markSent } = sendDeps({ list: [] });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:send", "pane-1", "/plans/x.md", ["unknown-id"]);

    expect(result).toEqual({ ok: false, reason: "no-comments" });
    expect(write).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });

  it("returns no-pane for an unknown pane once there is something to send", async () => {
    const { deps, write } = sendDeps();
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:send", "ghost-pane", "/plans/x.md", ["c1"]);

    expect(result).toEqual({ ok: false, reason: "no-pane" });
    expect(write).not.toHaveBeenCalled();
  });

  // Fix round 1: ShellManager keeps a pane's retained log around after its
  // shell exits (ruling 12), so it is still "known" — write must not be
  // attempted, and the comment must not be marked sent, for a pane that is
  // known but exited.
  it("returns no-pane for an exited-but-retained pane, and never marks the comment sent", async () => {
    const { deps, write, markSent } = sendDeps({ paneExited: true });
    const table = createDispatchTable(deps);

    const result = await call(table, "plans:send", "pane-1", "/plans/x.md", ["c1"]);

    expect(result).toEqual({ ok: false, reason: "no-pane" });
    expect(write).not.toHaveBeenCalled();
    expect(markSent).not.toHaveBeenCalled();
  });
});

describe("plans:* remote policy", () => {
  const PLAN_CHANNELS = [
    "plans:list",
    "plans:read",
    "plans:writeBlock",
    "plans:comments",
    "plans:addComment",
    "plans:updateComment",
    "plans:deleteComment",
    "plans:send",
  ] as const;

  it("marks all eight plans:* channels remote-legal", () => {
    // tsc: CHANNEL_POLICY is `satisfies Record<InvokeChannel, ChannelAccess>`
    // (remote-policy.ts), so a channel spelled wrong here would already be
    // a compile error at that `satisfies` clause. This is the runtime half
    // — every one of the eight is actually "remote", not merely present.
    expect(PLAN_CHANNELS).toHaveLength(8);
    for (const channel of PLAN_CHANNELS) {
      expect(CHANNEL_POLICY[channel], channel).toBe("remote");
    }
  });

  it("classifies all eight plans:* channels' own audit effect correctly", () => {
    // tsc: REMOTE_EFFECT is `satisfies Record<RemoteChannel, "read" | "mutate" | "input">`
    // (remote-policy.ts) — a channel missing from it is already a compile
    // error there. This is the runtime half: the *value* each one holds.
    const expected: Record<(typeof PLAN_CHANNELS)[number], "read" | "mutate" | "input"> = {
      "plans:list": "read",
      "plans:read": "read",
      "plans:comments": "read",
      "plans:writeBlock": "mutate",
      "plans:addComment": "mutate",
      "plans:updateComment": "mutate",
      "plans:deleteComment": "mutate",
      "plans:send": "input",
    };
    for (const channel of PLAN_CHANNELS) {
      expect(REMOTE_EFFECT[channel], channel).toBe(expected[channel]);
    }
  });
});
