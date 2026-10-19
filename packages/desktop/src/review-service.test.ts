import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEWS_CONFIG,
  reviewCommentKey,
  type AgentConfig,
  type PrKey,
  type PullRequest,
  type QueuedComment,
  type ReviewComment,
  type ReviewsConfig,
  type ReviewsGh,
  type ReviewsStore,
} from "@jarvis/core";
import type { ExternalAgentProcess, ShellOutput } from "@jarvis/platform";
import {
  createReviewService,
  type ReviewNotify,
  type ReviewPollerEvent,
  type ReviewPollerOptions,
  type ReviewServiceDeps,
} from "./review-service.js";

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~\r";

const RULE = "─".repeat(40);
const IDLE_TAIL = [
  "⏺ All tests pass.",
  "",
  "✻ Worked for 18s",
  "",
  RULE,
  "> ",
  RULE,
  "  ? for shortcuts",
].join("\n");
const BUSY_TAIL = [
  "⏺ Bash(pnpm test)",
  "  ⎿  Running…",
  "",
  "✶ Percolating… (12s · esc to interrupt)",
  "",
  RULE,
  "> ",
  RULE,
].join("\n");
const APPROVAL_TAIL = [
  "│ Do you want to proceed?        │",
  "│ ❯ 1. Yes                       │",
  "│   2. No, and tell Claude (esc) │",
].join("\n");
const BARE_SHELL_TAIL = "user@mac app % ";

const PR: PullRequest = {
  repo: "Acme/App",
  number: 18,
  title: "Fix it",
  headRef: "feat/x",
  author: "me",
  url: "https://github.com/Acme/App/pull/18",
  isDraft: false,
  role: "mine",
};
const PR_KEY: PrKey = "Acme/App#18";
const PANE = "tab-1";

const AGENTS: AgentConfig[] = [
  { id: "claude-mm", command: "claude-mm", vendor: "anthropic" },
  { id: "codex", command: "codex", vendor: "openai" },
  { id: "copilot", command: "copilot", vendor: "github" },
];

function agentIn(paneKey: string, agentId = "claude-mm"): ExternalAgentProcess {
  return {
    pid: 42,
    agentId,
    command: agentId,
    cwd: "/p/app",
    startedAt: 0,
    terminalPaneKey: paneKey,
  };
}

function comment(id: string, createdAt: number, body = `body ${id}`): ReviewComment {
  return { id, kind: "issue", author: "alice", isBot: false, body, createdAt };
}

/** In-memory ReviewsStore, shared across service instances for restarts. */
function memoryStore(): ReviewsStore & {
  entries: Map<string, QueuedComment>;
  notified: Set<string>;
} {
  const entries = new Map<string, QueuedComment>();
  const manual = new Map<PrKey, string | null>();
  const paused = new Set<string>();
  const notified = new Set<string>();
  return {
    entries,
    notified,
    cursor: async () => undefined,
    setCursor: async () => {},
    isFirstRun: async () => false,
    markSeeded: async () => {},
    async upsertComments(prKey, comments, state) {
      for (const c of comments) {
        const key = reviewCommentKey(prKey, c.kind, c.id);
        if (!entries.has(key)) entries.set(key, { prKey, comment: c, state });
      }
    },
    async markDelivered(ids, paneKey, at) {
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry?.state === "queued") {
          entries.set(id, { ...entry, state: "delivered", deliveredTo: paneKey, deliveredAt: at });
        }
      }
    },
    async markOwn(prKey, c) {
      entries.set(reviewCommentKey(prKey, c.kind, c.id), { prKey, comment: c, state: "own" });
    },
    async listQueued(prKey) {
      return [...entries.values()].filter(
        (e) => e.state === "queued" && (prKey === undefined || e.prKey === prKey),
      );
    },
    async requeue(key) {
      const entry = entries.get(key);
      if (entry?.state !== "history") return false;
      entries.set(key, { ...entry, state: "queued" });
      return true;
    },
    async thread(prKey) {
      return [...entries.values()].filter((e) => e.prKey === prKey);
    },
    manualLinks: async () => new Map(manual),
    async setManualLink(prKey, paneKey) {
      manual.set(prKey, paneKey);
    },
    paused: async () => new Set(paused),
    async setPaused(paneKey, on) {
      if (on) paused.add(paneKey);
      else paused.delete(paneKey);
    },
    async forgetPanes(isGone) {
      for (const [k, v] of manual) if (v !== null && isGone(v)) manual.delete(k);
      for (const k of paused) if (isGone(k)) paused.delete(k);
    },
    wasNotified: async (key) => notified.has(key),
    async markNotified(key) {
      notified.add(key);
    },
  };
}

type Harness = ReturnType<typeof harness>;

function harness(
  opts: {
    store?: ReturnType<typeof memoryStore>;
    start?: number;
    panes?: { paneKey: string; exited: boolean }[];
    repoOf?: ReviewsGh["repoOf"];
  } = {},
) {
  let now = opts.start ?? 1_000_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const store = opts.store ?? memoryStore();
  const writes: { paneKey: string; data: string }[] = [];
  const logs = new Map<string, string>([[PANE, IDLE_TAIL]]);
  const screens = new Map<string, string>();
  const panes = opts.panes ?? [{ paneKey: PANE, exited: false }];
  const outputListeners: ((o: ShellOutput) => void)[] = [];
  const exitListeners: ((e: { paneKey: string; code: number }) => void)[] = [];
  const cwds = new Map<string, string>();
  const projectDirs: string[] = ["/p/app"];
  let pollNows = 0;
  const keystrokes = new Map<string, number>();
  let agents: ExternalAgentProcess[] = [agentIn(PANE)];
  let scans = 0;
  let scanGate: Promise<void> | undefined;
  const notifies: ReviewNotify[] = [];
  let pollerOptions: ReviewPollerOptions | undefined;
  const config: ReviewsConfig = { ...DEFAULT_REVIEWS_CONFIG, batchSeconds: 30 };

  const gh: ReviewsGh = {
    status: async () => ({ kind: "ok", login: "me" }),
    repoOf: opts.repoOf ?? (async () => "acme/app"),
    listPrs: async () => [],
    listComments: async () => ({ kind: "unchanged" }),
    postComment: async (_pr, body) => comment("own-1", now, body),
    replyToReviewComment: async (_pr, _id, body) => comment("own-2", now, body),
  };

  const deps: ReviewServiceDeps = {
    shells: {
      panes: () => panes,
      log: (key) => logs.get(key) ?? "",
      write: (paneKey, data) => {
        writes.push({ paneKey, data });
      },
      onOutput: (listener) => {
        outputListeners.push(listener);
        return () => {};
      },
      onShellExit: (listener) => {
        exitListeners.push(listener);
        return () => {};
      },
    },
    screenText: (key) => screens.get(key),
    terminal: {
      paneCwd: (key) => cwds.get(key) ?? "/p/app",
      lastKeystrokeAt: (key) => keystrokes.get(key),
    },
    branchOf: async () => "feat/x",
    gh,
    store,
    scanAgents: async () => {
      scans++;
      if (scanGate !== undefined) await scanGate;
      return agents;
    },
    agents: () => AGENTS,
    config: () => config,
    projectDirs: () => projectDirs,
    createPoller: (options) => {
      pollerOptions = options;
      return {
        start: () => {},
        stop: () => {},
        pollNow: async () => {
          pollNows++;
          options.repos();
        },
      };
    },
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };

  const service = createReviewService(deps);
  service.onNotify((e) => notifies.push(e));

  return {
    service,
    store,
    writes,
    logs,
    screens,
    panes,
    keystrokes,
    notifies,
    config,
    gh,
    cwds,
    projectDirs,
    get pollNows() {
      return pollNows;
    },
    /** The repositories the poller would poll right now. */
    pollRepos(): string[] {
      return pollerOptions?.repos() ?? [];
    },
    exit(paneKey: string) {
      for (const pane of panes) if (pane.paneKey === paneKey) pane.exited = true;
      for (const l of exitListeners) l({ paneKey, code: 0 });
    },
    get scans() {
      return scans;
    },
    /** Holds every process scan until the returned release is called. */
    holdScans(): () => void {
      let release = () => {};
      scanGate = new Promise<void>((resolve) => {
        release = () => {
          scanGate = undefined;
          resolve();
        };
      });
      return release;
    },
    setAgents(next: ExternalAgentProcess[]) {
      agents = next;
    },
    get now() {
      return now;
    },
    emit(event: ReviewPollerEvent) {
      pollerOptions?.onEvent(event);
    },
    output(paneKey: string, chunk: string) {
      for (const l of outputListeners) l({ paneKey, chunk, offset: 0 });
    },
    /** Moves the clock, firing due timers in order, then lets the service settle. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        now = due.at;
        due.fn();
        await service.whenIdle();
      }
      now = until;
      await service.whenIdle();
    },
  };
}

/** Knows the PR and has one comment queued long enough ago to clear batching. */
async function withQueued(h: Harness, ids: string[] = ["c1"]): Promise<void> {
  h.emit({ kind: "prs", prs: [PR] });
  await h.store.upsertComments(
    PR_KEY,
    ids.map((id) => comment(id, h.now - 60_000)),
    "queued",
  );
  h.emit({ kind: "comments", prKey: PR_KEY, added: ids.length });
  await h.service.whenIdle();
}

describe("review service delivery", () => {
  it("writes once, in a bracketed paste, when linked, idle, agent present, quiet and not typing", async () => {
    const h = harness();
    await withQueued(h, ["c1", "c2"]);
    await h.advance(10_000);

    expect(h.writes).toHaveLength(1);
    const { paneKey, data } = h.writes[0] ?? { paneKey: "", data: "" };
    expect(paneKey).toBe(PANE);
    expect(data.startsWith(PASTE_START)).toBe(true);
    expect(data.endsWith(PASTE_END)).toBe(true);
    expect(data).toContain("New review comments on PR #18");
    expect(data).toContain("body c1");
    expect(data).toContain("body c2");
    expect(await h.store.listQueued()).toEqual([]);
    const delivered = [...h.store.entries.values()];
    expect(delivered.every((e) => e.state === "delivered" && e.deliveredTo === PANE)).toBe(true);
  });

  it("writes nothing when the agent left the pane before the write (bare shell)", async () => {
    const h = harness();
    h.logs.set(PANE, BUSY_TAIL);
    await withQueued(h);
    await h.advance(6_000);
    expect(h.writes).toHaveLength(0);

    // The agent exits: the pane is a bare shell again.
    h.setAgents([]);
    h.logs.set(PANE, BARE_SHELL_TAIL);
    await h.advance(30_000);

    expect(h.writes).toHaveLength(0);
    const [item] = await h.service.list();
    expect(item?.waitReason).toBe("no-agent");
    expect(item?.queued).toBe(1);
  });

  it("waits while busy, then writes once after an idle tail and 2 s of quiet", async () => {
    const h = harness();
    h.logs.set(PANE, BUSY_TAIL);
    await withQueued(h);
    await h.advance(6_000);
    expect(h.writes).toHaveLength(0);
    expect((await h.service.list())[0]?.waitReason).toBe("busy");

    h.logs.set(PANE, IDLE_TAIL);
    h.output(PANE, "redraw");
    await h.advance(1_000);
    expect(h.writes).toHaveLength(0);
    await h.advance(1_500);
    expect(h.writes).toHaveLength(1);
    await h.advance(30_000);
    expect(h.writes).toHaveLength(1);
  });

  it("does not write when the user typed into the pane 3 s ago", async () => {
    const h = harness();
    h.keystrokes.set(PANE, h.now + 2_000);
    await withQueued(h);
    await h.advance(5_000);
    expect(h.writes).toHaveLength(0);
    expect((await h.service.list())[0]?.waitReason).toBe("typing");
  });

  it("never re-delivers after a restart on the same store", async () => {
    const first = harness();
    await withQueued(first);
    await first.advance(10_000);
    expect(first.writes).toHaveLength(1);
    first.service.dispose();

    const second = harness({ store: first.store, start: first.now });
    second.emit({ kind: "prs", prs: [PR] });
    await second.advance(60_000);
    await second.service.deliverNow(PR_KEY);
    expect(second.writes).toHaveLength(0);
  });

  it("deliverNow writes while the agent is busy", async () => {
    const h = harness();
    h.logs.set(PANE, BUSY_TAIL);
    await withQueued(h);
    const outcome = await h.service.deliverNow(PR_KEY);
    expect(outcome).toEqual({ sent: true });
    expect(h.writes).toHaveLength(1);
  });

  it("deliverNow never writes into an approval prompt", async () => {
    const h = harness();
    h.logs.set(PANE, APPROVAL_TAIL);
    await withQueued(h);
    const outcome = await h.service.deliverNow(PR_KEY);
    expect(outcome).toEqual({ sent: false, wait: "approval-prompt" });
    expect(h.writes).toHaveLength(0);
  });

  it("scans for the agent afresh before every write", async () => {
    const h = harness();
    await withQueued(h);
    const before = h.scans;
    await h.service.deliverNow(PR_KEY);
    expect(h.scans).toBeGreaterThan(before);
  });

  it("reports paused pane keys and every watched repository without requiring a PR", async () => {
    const h = harness();
    await h.service.whenIdle();
    h.config.repos["me/empty"] = true;
    await h.store.setPaused("other:p1", true);
    expect(await h.service.status()).toMatchObject({
      paused: ["other:p1"],
      repos: expect.arrayContaining(["me/empty"]),
    });
    await h.service.pause("other:p1", false);
    expect((await h.service.status()).paused).toEqual([]);
  });

  it("treats an agent with an unknown vendor as never pasteable, even for deliverNow", async () => {
    const h = harness();
    h.setAgents([agentIn(PANE, "copilot")]);
    await withQueued(h);
    const outcome = await h.service.deliverNow(PR_KEY);
    expect(outcome).toEqual({ sent: false, wait: "unsupported" });
    expect((await h.service.list())[0]?.waitReason).toBe("unsupported");
    expect(h.writes).toHaveLength(0);
  });

  it("exposes process presence separately from unsupported idle markers", async () => {
    const h = harness();
    h.setAgents([agentIn(PANE, "copilot")]);
    expect(await h.service.paneStateOf(PANE)).toMatchObject({
      hasAgent: true,
      agentPresent: true,
      unsupported: true,
      idleSupported: false,
    });
    h.setAgents([]);
    expect(await h.service.paneStateOf(PANE)).toMatchObject({
      hasAgent: false,
      agentPresent: false,
    });
    h.service.dispose();
  });

  it("holds review delivery after an external plan paste until fresh output", async () => {
    const h = harness();
    await h.advance(3000);
    h.service.notePaste(PANE);
    await withQueued(h);
    await h.advance(3000);
    expect(h.writes).toHaveLength(0);
    expect((await h.service.paneStateOf(PANE)).input).toBe("busy");
    h.output(PANE, IDLE_TAIL);
    await h.advance(2000);
    expect(h.writes).toHaveLength(1);
    h.service.dispose();
  });

  it("reads Codex panes with the openai markers", async () => {
    const h = harness();
    h.setAgents([agentIn(PANE, "codex")]);
    h.logs.set(PANE, "• Worked for 1m 05s\n\n› Ask Codex to do anything\n");
    await withQueued(h);
    await h.advance(10_000);
    expect(h.writes).toHaveLength(1);
  });

  it("matches the PR to the pane's repo case-insensitively", async () => {
    const h = harness();
    await withQueued(h);
    await h.advance(10_000);
    expect((await h.service.list())[0]?.link).toEqual({
      kind: "linked",
      paneKey: PANE,
      how: "auto",
    });
  });

  it("pauses delivery for a paused pane", async () => {
    const h = harness();
    await h.service.pause(PANE, true);
    await withQueued(h);
    await h.advance(10_000);
    expect(h.writes).toHaveLength(0);
    expect((await h.service.list())[0]?.waitReason).toBe("paused");
  });

  it("does not deliver to an explicitly unlinked PR", async () => {
    const h = harness();
    await h.service.link(PR_KEY, null);
    await withQueued(h);
    await h.advance(10_000);
    expect(h.writes).toHaveLength(0);
    expect((await h.service.list())[0]?.waitReason).toBe("no-link");
  });
});

describe("review service notifications", () => {
  it("notifies review-queued once after 120 s with no link", async () => {
    const h = harness();
    await h.service.link(PR_KEY, null);
    await withQueued(h);
    await h.advance(100_000);
    expect(h.notifies.filter((n) => n.kind === "review-queued")).toEqual([]);
    await h.advance(30_000);
    await h.advance(120_000);
    expect(h.notifies.filter((n) => n.kind === "review-queued")).toEqual([
      { kind: "review-queued", pr: PR_KEY },
    ]);
  });

  it("notifies review-queued once after 120 s with an unsupported linked agent", async () => {
    const h = harness();
    h.setAgents([agentIn(PANE, "copilot")]);
    await withQueued(h);
    await h.advance(100_000);
    expect(h.notifies.filter((n) => n.kind === "review-queued")).toEqual([]);
    await h.advance(30_000);
    expect(h.notifies.filter((n) => n.kind === "review-queued")).toEqual([
      { kind: "review-queued", pr: PR_KEY },
    ]);
    await h.advance(120_000);
    expect(h.notifies.filter((n) => n.kind === "review-queued")).toHaveLength(1);
    expect(h.writes).toHaveLength(0);
  });

  it("forwards new comments and review requests as notifications", async () => {
    const h = harness();
    h.emit({ kind: "comments", prKey: PR_KEY, added: 2 });
    h.emit({ kind: "review-requested", pr: { ...PR, role: "review-requested" } });
    expect(h.notifies).toEqual([
      { kind: "review-comment", pr: PR_KEY },
      { kind: "review-requested", pr: PR_KEY },
    ]);
  });
});

describe("review service actions", () => {
  it("sendReview pastes the review instruction through the idle gate", async () => {
    const h = harness();
    h.emit({ kind: "prs", prs: [PR] });
    await h.advance(3_000);
    const outcome = await h.service.sendReview(PR_KEY, PANE);
    expect(outcome).toEqual({ sent: true });
    expect(h.writes[0]?.data).toContain("Review PR #18 (Acme/App)");
  });

  it("postSummary waits while busy and goes out once idle", async () => {
    const h = harness();
    h.logs.set(PANE, BUSY_TAIL);
    h.emit({ kind: "prs", prs: [PR] });
    await h.advance(3_000);
    expect(await h.service.postSummary(PR_KEY)).toEqual({ sent: false, wait: "busy" });
    expect(h.writes).toHaveLength(0);
    h.logs.set(PANE, IDLE_TAIL);
    await h.advance(6_000);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.data).toContain("summarising what changed");
  });

  it("requeue moves a history comment back to queued", async () => {
    const h = harness();
    h.emit({ kind: "prs", prs: [PR] });
    await h.store.upsertComments(PR_KEY, [comment("old", h.now - 999_000)], "history");
    expect(await h.service.requeue(PR_KEY, "old")).toBe(true);
    expect(await h.store.listQueued(PR_KEY)).toHaveLength(1);
  });

  it("reply posts as the user and records the comment as own", async () => {
    const h = harness();
    h.emit({ kind: "prs", prs: [PR] });
    await h.service.reply(PR_KEY, "thanks");
    const thread = await h.service.thread(PR_KEY);
    expect(thread?.comments.map((c) => c.state)).toEqual(["own"]);
  });

  it("paneStateOf reports the gate's view of a pane", async () => {
    const h = harness();
    await h.advance(3_000);
    const state = await h.service.paneStateOf(PANE);
    expect(state).toMatchObject({
      hasAgent: true,
      input: "idle-input",
      draft: false,
      paused: false,
    });
    h.setAgents([]);
    expect((await h.service.paneStateOf(PANE)).hasAgent).toBe(false);
  });
});

describe("review service fix round 1", () => {
  const PR2: PullRequest = { ...PR, number: 19, headRef: "feat/y", url: `${PR.url}9` };
  const PR2_KEY: PrKey = "Acme/App#19";

  it("pastes once per pane per pass: queued comments first, the pending instruction on a later idle pass", async () => {
    const h = harness();
    h.logs.set(PANE, BUSY_TAIL);
    await withQueued(h);
    expect(await h.service.sendReview(PR_KEY, PANE)).toEqual({ sent: false, wait: "busy" });
    h.logs.set(PANE, IDLE_TAIL);
    await h.advance(5_000);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.data).toContain("New review comments");

    // Still no new output from the pane: it must not read idle yet.
    await h.advance(10_000);
    expect(h.writes).toHaveLength(1);

    // The agent answers, then goes quiet at its prompt again.
    h.output(PANE, "agent reply");
    await h.advance(3_000);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]?.data).toContain("Review PR #18");
  });

  it("two PRs linked to one pane get one write per pass", async () => {
    const h = harness();
    h.emit({ kind: "prs", prs: [PR, PR2] });
    await h.service.link(PR_KEY, PANE);
    await h.service.link(PR2_KEY, PANE);
    await h.store.upsertComments(PR_KEY, [comment("a", h.now - 60_000)], "queued");
    await h.store.upsertComments(PR2_KEY, [comment("b", h.now - 60_000)], "queued");
    await h.advance(5_000);
    expect(h.writes).toHaveLength(1);
    h.output(PANE, "agent reply");
    await h.advance(3_000);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0]?.data).not.toEqual(h.writes[1]?.data);
  });

  it("never pastes the same comments twice when markDelivered fails after the write", async () => {
    const h = harness();
    h.store.markDelivered = async () => {
      throw new Error("disk full");
    };
    await withQueued(h);
    await h.advance(5_000);
    expect(h.writes).toHaveLength(1);
    h.output(PANE, "agent reply");
    await h.advance(30_000);
    await h.service.deliverNow(PR_KEY);
    expect(h.writes).toHaveLength(1);
  });

  it("writes nothing once disposed, even mid-evaluation", async () => {
    const h = harness();
    await withQueued(h);
    const release = h.holdScans();
    const outcome = h.service.deliverNow(PR_KEY);
    await Promise.resolve();
    h.service.dispose();
    release();
    await outcome;
    expect(h.writes).toHaveLength(0);
  });
});

/** Lets pending promise chains (repo lookups) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("review service final-review fixes", () => {
  const OTHER = "tab-2";

  it("prunes a saved manual link and pause to a pane that is not live at start", async () => {
    const store = memoryStore();
    await store.setManualLink(PR_KEY, OTHER);
    await store.setPaused(OTHER, true);
    const h = harness({ store });
    await h.service.whenIdle();
    expect(await store.manualLinks()).toEqual(new Map());
    expect(await store.paused()).toEqual(new Set());

    // A new, unrelated tab-2 opens in another repository with an idle agent.
    h.panes.push({ paneKey: OTHER, exited: false });
    h.cwds.set(OTHER, "/p/other");
    h.gh.repoOf = async (cwd) => (cwd === "/p/other" ? "acme/other" : "acme/app");
    h.logs.set(OTHER, IDLE_TAIL);
    h.setAgents([agentIn(PANE), agentIn(OTHER)]);
    await withQueued(h);
    await h.advance(10_000);
    expect(h.writes.map((w) => w.paneKey)).not.toContain(OTHER);
  });

  it("keeps explicit unlinks and links to live panes at start", async () => {
    const store = memoryStore();
    await store.setManualLink(PR_KEY, null);
    await store.setManualLink("Acme/App#19", PANE);
    const h = harness({ store });
    await h.service.whenIdle();
    expect(await store.manualLinks()).toEqual(
      new Map<PrKey, string | null>([
        [PR_KEY, null],
        ["Acme/App#19", PANE],
      ]),
    );
  });

  it("clears a pane's manual links and pause when it exits", async () => {
    const h = harness({
      panes: [
        { paneKey: PANE, exited: false },
        { paneKey: OTHER, exited: false },
      ],
    });
    await h.service.link(PR_KEY, OTHER);
    await h.service.link("Acme/App#19", null);
    await h.service.pause(OTHER, true);
    h.exit(OTHER);
    await h.service.whenIdle();
    expect(await h.store.manualLinks()).toEqual(
      new Map<PrKey, string | null>([["Acme/App#19", null]]),
    );
    expect(await h.store.paused()).toEqual(new Set());
  });

  it("keeps a repo's error and last PRs when it fails, clears the error once it lists", async () => {
    const h = harness();
    const OTHER_PR: PullRequest = { ...PR, repo: "Acme/Other", number: 3 };
    h.emit({ kind: "prs", prs: [PR, OTHER_PR] });
    await h.service.whenIdle();
    // One tick: Acme/Other fails, so its PRs are missing from the list.
    h.emit({ kind: "repo-error", repo: "Acme/Other", message: "boom" });
    h.emit({ kind: "prs", prs: [PR] });
    await h.service.whenIdle();
    expect((await h.service.status()).repoErrors).toEqual({ "Acme/Other": "boom" });
    expect((await h.service.list()).map((i) => i.pr.number).sort((a, b) => a - b)).toEqual([3, 18]);
    // Next tick lists it again.
    h.emit({ kind: "prs", prs: [PR, OTHER_PR] });
    await h.service.whenIdle();
    expect((await h.service.status()).repoErrors).toEqual({});
    // A tick where it lists successfully with no PRs drops them.
    h.emit({ kind: "prs", prs: [PR] });
    expect((await h.service.list()).map((i) => i.pr.number)).toEqual([18]);
  });

  it("pastes nothing, and sends no instruction, while Listen is off", async () => {
    const h = harness();
    h.config.enabled = false;
    await withQueued(h);
    await h.advance(10_000);
    expect(await h.service.sendReview(PR_KEY, PANE)).toEqual({ sent: false, wait: "paused" });
    expect(await h.service.deliverNow(PR_KEY)).toEqual({ sent: false, wait: "paused" });
    await h.advance(10_000);
    expect(h.writes).toHaveLength(0);
    h.config.enabled = true;
    await h.advance(10_000);
    expect(h.writes.length).toBeGreaterThan(0);
  });

  it("does not cache a failed repo lookup for more than 60 s", async () => {
    let calls = 0;
    let answer: string | undefined;
    const h = harness({
      repoOf: async () => {
        calls++;
        return answer;
      },
    });
    await h.service.whenIdle();
    await flush();
    expect(h.pollRepos()).not.toContain("acme/app");
    await flush();
    const first = calls;
    answer = "acme/app";
    await h.advance(30_000);
    h.pollRepos();
    await flush();
    expect(calls).toBe(first);
    await h.advance(31_000);
    h.pollRepos();
    await flush();
    expect(calls).toBeGreaterThan(first);
    expect(h.pollRepos()).toContain("acme/app");
  });

  it("polls once when project discovery finishes", async () => {
    const h = harness();
    await h.service.whenIdle();
    await flush();
    expect(h.pollNows).toBe(1);
  });

  it("picks up a project added to the live config on the next poll", async () => {
    const h = harness({
      repoOf: async (cwd) => (cwd === "/p/new" ? "acme/new" : "acme/app"),
    });
    await h.service.whenIdle();
    h.projectDirs.push("/p/new");
    h.pollRepos();
    await flush();
    expect(h.pollRepos()).toContain("acme/new");
  });

  it("notifies review-queued after 120 s when the link is ambiguous", async () => {
    const h = harness({
      panes: [
        { paneKey: PANE, exited: false },
        { paneKey: OTHER, exited: false },
      ],
    });
    h.logs.set(OTHER, IDLE_TAIL);
    await withQueued(h);
    expect((await h.service.list())[0]?.link.kind).toBe("ambiguous");
    await h.advance(130_000);
    expect(h.notifies.filter((n) => n.kind === "review-queued")).toEqual([
      { kind: "review-queued", pr: PR_KEY },
    ]);
  });
});

describe("review service e2e fixes", () => {
  const OTHER = "tab-2";

  // Claude Code redraws in place; its raw log is unreadable, so the pane's
  // rendered screen is what the idle reader sees whenever there is one.
  it("reads a pane's rendered screen over its raw log, the log when there is none", async () => {
    const h = harness();
    h.logs.set(PANE, BUSY_TAIL);
    expect((await h.service.paneStateOf(PANE)).input).toBe("busy");
    h.screens.set(PANE, IDLE_TAIL);
    expect((await h.service.paneStateOf(PANE)).input).toBe("idle-input");
    h.screens.set(PANE, `${IDLE_TAIL.replace("> ", "> half a dra")}`);
    expect((await h.service.paneStateOf(PANE)).draft).toBe(true);
  });

  // A pane's key comes back when its shell restarts (shell.ts start): a
  // link set on the new shell must not be wiped by the old one's exit,
  // queued behind a running evaluation.
  it("keeps a link set on a quickly restarted pane after the old shell's queued forget", async () => {
    const h = harness({
      panes: [
        { paneKey: PANE, exited: false },
        { paneKey: OTHER, exited: false },
      ],
    });
    await h.service.whenIdle();
    const release = h.holdScans();
    h.output(PANE, "x");
    h.exit(OTHER);
    for (const pane of h.panes) if (pane.paneKey === OTHER) pane.exited = false;
    const linked = h.service.link(PR_KEY, OTHER);
    const paused = h.service.pause(OTHER, true);
    release();
    await Promise.all([linked, paused]);
    await h.service.whenIdle();
    expect((await h.store.manualLinks()).get(PR_KEY)).toBe(OTHER);
    expect(await h.store.paused()).toEqual(new Set([OTHER]));
  });
});
