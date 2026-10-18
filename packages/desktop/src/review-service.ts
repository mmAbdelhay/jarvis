// The Reviews service (spec §4.2–4.4): ties the pure pieces in
// @jarvis/core's reviews module to real Terminal panes. It owns the poller,
// resolves which pane each PR belongs to, and pastes queued review comments
// into the agent session running there — only through the delivery gate
// (planDelivery), and only after a fresh process scan says an agent is
// still in that pane. Every doubt resolves to "wait": a missed paste only
// delays, a wrong one types into a shell or answers an approval menu.

import {
  buildCommentsMessage,
  planDelivery,
  prKey as makePrKey,
  readAgentInputState,
  inputLineHasDraft,
  resolveLink,
  reviewCommentKey,
  reviewInstruction,
  summaryInstruction,
  type AgentConfig,
  type DeliveryWait,
  type LinkResult,
  type PaneFacts,
  type PaneState,
  type PrKey,
  type PullRequest,
  type QueuedComment,
  type ReviewComment,
  type ReviewsConfig,
  type ReviewsGh,
  type ReviewsStore,
} from "@jarvis/core";
import type { ExternalAgentProcess, ShellManager } from "@jarvis/platform";
import { bracketedSubmit } from "./bracketed.js";
import type { TerminalHandlers } from "./ipc.js";

/** Pane output must be quiet this long before an evaluation is triggered. */
export const REVIEW_QUIET_MS = 2_000;
/** Re-evaluation safety net, whatever else happens. */
export const REVIEW_SAFETY_MS = 5_000;
/** A comment waiting this long with no link or no agent is notified. */
export const REVIEW_QUEUED_NOTIFY_MS = 120_000;
/** Lines of a pane's raw log fed to the idle reader. */
export const REVIEW_TAIL_LINES = 400;
/** How long a pane directory's branch is reused before git is asked again. */
const BRANCH_TTL_MS = 10_000;

type GhStatus = Awaited<ReturnType<ReviewsGh["status"]>>;

/** Mirrors core's ReviewEvent (poller.ts), kept structural so this module
 *  does not depend on the poller's own export. */
export type ReviewPollerEvent =
  | { kind: "status"; status: GhStatus }
  | { kind: "comments"; prKey: PrKey; added: number }
  | { kind: "review-requested"; pr: PullRequest }
  | { kind: "prs"; prs: PullRequest[] }
  | { kind: "repo-error"; repo: string; message: string };

export type ReviewPollerOptions = {
  gh: ReviewsGh;
  store: ReviewsStore;
  config: () => ReviewsConfig;
  repos: () => string[];
  schedule: (fn: () => void, ms: number) => () => void;
  now: () => number;
  onEvent: (event: ReviewPollerEvent) => void;
};

export type ReviewPoller = { start(): void; stop(): void; pollNow(): Promise<void> };

export type ReviewNotify =
  | { kind: "review-comment"; pr: PrKey }
  | { kind: "review-queued"; pr: PrKey }
  | { kind: "review-requested"; pr: PrKey };

export type ReviewWaitReason = Exclude<DeliveryWait, "nothing">;

export type ReviewListItem = {
  pr: PullRequest;
  link: LinkResult;
  /** Count of comments waiting to be delivered. */
  queued: number;
  /** Count of comments already pasted into a pane. */
  delivered: number;
  waitReason: ReviewWaitReason | null;
  /** Newest comment or delivery, epoch ms; 0 when the PR has none. */
  lastActivity: number;
};

export type ReviewThread = {
  pr: PullRequest;
  link: LinkResult;
  waitReason: ReviewWaitReason | null;
  comments: QueuedComment[];
};

export type ReviewStatus = {
  gh: GhStatus | null;
  enabled: boolean;
  /** The last poll error per repository, cleared when it lists PRs again. */
  repoErrors: Record<string, string>;
};

export type DeliveryOutcome = { sent: true } | { sent: false; wait: DeliveryWait };

export type ReviewServiceDeps = {
  shells: Pick<ShellManager, "panes" | "log" | "write" | "onOutput" | "onShellExit">;
  terminal: Pick<TerminalHandlers, "paneCwd" | "lastKeystrokeAt">;
  /** The current git branch of a directory, undefined outside a repository. */
  branchOf(cwd: string): Promise<string | undefined>;
  gh: ReviewsGh;
  store: ReviewsStore;
  /** A fresh `listAgentProcesses` run — never a cached result. */
  scanAgents(): Promise<readonly ExternalAgentProcess[]>;
  /** The configured agents, read live: their vendors pick the idle markers. */
  agents(): readonly AgentConfig[];
  config(): ReviewsConfig;
  /** Configured project directories, whose repositories are polled. */
  projectDirs(): readonly string[];
  createPoller(options: ReviewPollerOptions): ReviewPoller;
  now(): number;
  /** One-shot timer; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
  /** Comment time in the pasted message; local HH:MM by default. */
  fmtTime?(ms: number): string;
};

export type ReviewService = {
  status(): ReviewStatus;
  list(): Promise<ReviewListItem[]>;
  thread(prKey: PrKey): Promise<ReviewThread | undefined>;
  reply(prKey: PrKey, body: string, inReplyTo?: string): Promise<ReviewComment>;
  link(prKey: PrKey, paneKey: string | null): Promise<void>;
  pause(paneKey: string, paused: boolean): Promise<void>;
  requeue(prKey: PrKey, commentId: string): Promise<boolean>;
  deliverNow(prKey: PrKey): Promise<DeliveryOutcome>;
  sendReview(prKey: PrKey, paneKey: string): Promise<DeliveryOutcome>;
  postSummary(prKey: PrKey): Promise<DeliveryOutcome>;
  pollNow(): Promise<void>;
  /** The delivery gate's view of one pane, from a fresh process scan. Shared
   *  with the Plan panel's send (Task 14). */
  paneStateOf(paneKey: string): Promise<PaneState>;
  onChanged(cb: (prKey: PrKey | null) => void): () => void;
  onNotify(cb: (e: ReviewNotify) => void): () => void;
  /** Resolves once no evaluation is running or queued. */
  whenIdle(): Promise<void>;
  dispose(): void;
};

/** An instruction (review request, session summary) waiting for the gate. */
type PendingInstruction = {
  prKey: PrKey;
  /** A fixed target pane, or the PR's linked pane at delivery time. */
  paneKey?: string;
  text: string;
};

function defaultTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The last `count` lines of `text`, without splitting the whole log. */
export function lastLinesOf(text: string, count: number): string {
  let at = text.length;
  for (let i = 0; i < count; i++) {
    const nl = text.lastIndexOf("\n", at - 1);
    if (nl === -1) return text;
    at = nl;
  }
  return text.slice(at + 1);
}

const lower = (key: string): string => key.toLowerCase();

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const startedAt = deps.now();
  const fmtTime = deps.fmtTime ?? defaultTime;
  const changedListeners = new Set<(prKey: PrKey | null) => void>();
  const notifyListeners = new Set<(e: ReviewNotify) => void>();

  let ghStatus: GhStatus | null = null;
  const repoErrors = new Map<string, string>();
  /** Known PRs, keyed by lowercased prKey (gh's casing is kept on the PR). */
  const prs = new Map<string, PullRequest>();
  const links = new Map<string, LinkResult>();
  const waits = new Map<string, ReviewWaitReason>();
  const pending = new Map<string, PendingInstruction>();

  const lastOutput = new Map<string, number>();
  const seenPanes = new Set<string>();
  const quietTimers = new Map<string, () => void>();
  const repoCache = new Map<string, Promise<string | undefined>>();
  const branchCache = new Map<string, { at: number; value: Promise<string | undefined> }>();
  /** First time each queued comment was seen waiting on no-link/no-agent. */
  const waitingSince = new Map<string, number>();

  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let queuedRun: Promise<void> | undefined;
  let cancelSafety: (() => void) | undefined;

  const changed = (key: PrKey | null): void => {
    for (const cb of changedListeners) cb(key);
  };
  const notify = (e: ReviewNotify): void => {
    for (const cb of notifyListeners) cb(e);
  };

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn);
    chain = run.catch((error: unknown) => {
      console.error(`reviews: ${error instanceof Error ? error.message : String(error)}`);
    });
    return run;
  }

  /** Coalesced evaluation: at most one queued behind the running one. */
  function requestEvaluation(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (queuedRun !== undefined) return queuedRun;
    const run = exclusive(async () => {
      queuedRun = undefined;
      if (!disposed) await evaluate();
    });
    queuedRun = run.catch(() => {});
    return queuedRun;
  }

  function armSafety(): void {
    if (disposed) return;
    cancelSafety = deps.schedule(() => {
      void requestEvaluation();
      armSafety();
    }, REVIEW_SAFETY_MS);
  }

  function repoOf(cwd: string): Promise<string | undefined> {
    let hit = repoCache.get(cwd);
    if (hit === undefined) {
      hit = deps.gh.repoOf(cwd).catch(() => undefined);
      repoCache.set(cwd, hit);
    }
    return hit;
  }

  function branchOf(cwd: string): Promise<string | undefined> {
    const now = deps.now();
    const hit = branchCache.get(cwd);
    if (hit !== undefined && now - hit.at < BRANCH_TTL_MS) return hit.value;
    const value = deps.branchOf(cwd).catch(() => undefined);
    branchCache.set(cwd, { at: now, value });
    return value;
  }

  async function paneFacts(): Promise<PaneFacts[]> {
    return Promise.all(
      deps.shells.panes().map(async ({ paneKey, exited }): Promise<PaneFacts> => {
        if (exited) return { paneKey, exited };
        const cwd = deps.terminal.paneCwd(paneKey);
        if (cwd === undefined) return { paneKey, exited };
        const [repo, branch] = await Promise.all([repoOf(cwd), branchOf(cwd)]);
        return {
          paneKey,
          exited,
          ...(repo === undefined ? {} : { repo }),
          ...(branch === undefined ? {} : { branch }),
        };
      }),
    );
  }

  async function paneStateOf(paneKey: string): Promise<PaneState> {
    const [processes, paused] = await Promise.all([deps.scanAgents(), deps.store.paused()]);
    const now = deps.now();
    // The newest agent in the pane is the one at its prompt (an agent
    // started from inside another's shell tool is its child).
    const found = processes
      .filter((p) => p.terminalPaneKey === paneKey)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    const vendor =
      found === undefined ? undefined : deps.agents().find((a) => a.id === found.agentId)?.vendor;
    const tail = lastLinesOf(deps.shells.log(paneKey), REVIEW_TAIL_LINES);
    const input = readAgentInputState(tail, vendor ?? "");
    const keystroke = deps.terminal.lastKeystrokeAt(paneKey);
    return {
      // An agent whose vendor has no idle markers can never be read as
      // idle, and "Deliver now" skips the idle check — so it counts as no
      // agent at all, the one state no path ever pastes into.
      hasAgent: found !== undefined && vendor !== undefined && input !== "unknown",
      input,
      draft: vendor === undefined ? false : inputLineHasDraft(tail, vendor),
      quietMs: now - (lastOutput.get(paneKey) ?? startedAt),
      sinceKeystrokeMs: keystroke === undefined ? Number.POSITIVE_INFINITY : now - keystroke,
      paused: paused.has(paneKey),
    };
  }

  /** Writes `text` as one bracketed paste; false when the write threw. */
  function paste(paneKey: string, text: string): boolean {
    try {
      deps.shells.write(paneKey, bracketedSubmit(text));
      return true;
    } catch (error) {
      console.error(
        `reviews: write to ${paneKey} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** Delivers one PR's queued comments if the gate allows; returns the plan's verdict. */
  async function deliverPr(
    key: string,
    queued: QueuedComment[],
    link: LinkResult,
    force: boolean,
  ): Promise<DeliveryOutcome> {
    const pr = prs.get(key);
    if (pr === undefined) return { sent: false, wait: "no-link" };
    // The scan inside paneStateOf runs right here, immediately before the
    // write: nothing else awaits between it and shells.write.
    const pane = link.kind === "linked" ? await paneStateOf(link.paneKey) : undefined;
    const plan = planDelivery({
      now: deps.now(),
      queued,
      link,
      ...(pane === undefined ? {} : { pane }),
      batchMs: deps.config().batchSeconds * 1000,
      force,
    });
    if ("wait" in plan) return { sent: false, wait: plan.wait };
    if (link.kind !== "linked") return { sent: false, wait: "no-link" };
    const message = buildCommentsMessage(
      pr,
      plan.send.map((q) => q.comment),
      fmtTime,
    );
    if (!paste(link.paneKey, message)) return { sent: false, wait: "busy" };
    await deps.store.markDelivered(
      plan.send.map((q) => reviewCommentKey(q.prKey, q.comment.kind, q.comment.id)),
      link.paneKey,
      deps.now(),
    );
    return { sent: true };
  }

  /** The same gate for an instruction: one synthetic, already-batched item. */
  async function deliverInstruction(
    item: PendingInstruction,
    link: LinkResult,
  ): Promise<DeliveryOutcome> {
    const target: LinkResult =
      item.paneKey === undefined
        ? link
        : deps.shells.panes().some((p) => p.paneKey === item.paneKey && !p.exited)
          ? { kind: "linked", paneKey: item.paneKey, how: "manual" }
          : { kind: "none" };
    const pane = target.kind === "linked" ? await paneStateOf(target.paneKey) : undefined;
    const synthetic: QueuedComment = {
      prKey: item.prKey,
      comment: {
        id: "instruction",
        kind: "issue",
        author: "",
        isBot: false,
        body: "",
        createdAt: 0,
      },
      state: "queued",
    };
    const plan = planDelivery({
      now: deps.now(),
      queued: [synthetic],
      link: target,
      ...(pane === undefined ? {} : { pane }),
      batchMs: 0,
      force: false,
    });
    if ("wait" in plan) return { sent: false, wait: plan.wait };
    if (target.kind !== "linked") return { sent: false, wait: "no-link" };
    return paste(target.paneKey, item.text) ? { sent: true } : { sent: false, wait: "busy" };
  }

  async function trackQueuedNotify(
    key: string,
    queued: QueuedComment[],
    wait: DeliveryWait,
  ): Promise<void> {
    const ids = queued.map((q) => reviewCommentKey(q.prKey, q.comment.kind, q.comment.id));
    if (wait !== "no-link" && wait !== "no-agent") {
      for (const id of ids) waitingSince.delete(id);
      return;
    }
    const now = deps.now();
    const due: string[] = [];
    for (const id of ids) {
      const since = waitingSince.get(id) ?? now;
      waitingSince.set(id, since);
      if (
        now - since >= REVIEW_QUEUED_NOTIFY_MS &&
        !(await deps.store.wasNotified(`queued|${id}`))
      ) {
        due.push(id);
      }
    }
    if (due.length === 0) return;
    for (const id of due) await deps.store.markNotified(`queued|${id}`);
    const pr = prs.get(key);
    if (deps.config().notify.queued && pr !== undefined) {
      notify({ kind: "review-queued", pr: makePrKey(pr.repo, pr.number) });
    }
  }

  /** One pass over every PR; `forceKey` is a lowercased prKey for "Deliver now". */
  async function evaluate(forceKey?: string): Promise<DeliveryOutcome | undefined> {
    let forced: DeliveryOutcome | undefined;
    const cfg = deps.config();
    const queuedAll = await deps.store.listQueued();
    const byPr = new Map<string, QueuedComment[]>();
    for (const q of queuedAll) {
      if (q.state !== "queued") continue;
      const key = lower(q.prKey);
      const list = byPr.get(key) ?? [];
      list.push(q);
      byPr.set(key, list);
    }
    if (prs.size === 0) return undefined;

    const [facts, manualRaw] = await Promise.all([paneFacts(), deps.store.manualLinks()]);
    for (const pane of facts) if (!pane.exited) rememberRepo(pane);

    for (const [key, pr] of prs) {
      const canonical = makePrKey(pr.repo, pr.number);
      const link = resolveLink(pr, facts, manualFor(manualRaw, canonical), cfg.autoLink);
      const before = JSON.stringify([links.get(key), waits.get(key)]);
      links.set(key, link);

      const queued = byPr.get(key) ?? [];
      if (queued.length === 0) {
        waits.delete(key);
      } else {
        const outcome = await deliverPr(key, queued, link, key === forceKey);
        if (key === forceKey) forced = outcome;
        if (outcome.sent) {
          waits.delete(key);
          for (const q of queued)
            waitingSince.delete(reviewCommentKey(q.prKey, q.comment.kind, q.comment.id));
        } else {
          if (outcome.wait === "nothing") waits.delete(key);
          else waits.set(key, outcome.wait);
          await trackQueuedNotify(key, queued, outcome.wait);
        }
        if (outcome.sent) changed(canonical);
      }

      const instruction = pending.get(key);
      if (instruction !== undefined) {
        const outcome = await deliverInstruction(instruction, link);
        if (outcome.sent) pending.delete(key);
      }

      if (JSON.stringify([links.get(key), waits.get(key)]) !== before) changed(canonical);
    }
    return forced;
  }

  // The store keeps prKeys as gh wrote them; lookups ignore case.
  function manualFor(
    raw: ReadonlyMap<PrKey, string | null>,
    canonical: PrKey,
  ): Map<PrKey, string | null> {
    const out = new Map<PrKey, string | null>();
    for (const [k, v] of raw) if (lower(k) === lower(canonical)) out.set(canonical, v);
    return out;
  }

  const knownRepos = new Set<string>();
  function rememberRepo(pane: PaneFacts): void {
    if (pane.repo !== undefined) knownRepos.add(pane.repo);
  }

  /** Repositories to poll: configured ones, plus those of project dirs and open panes. */
  function pollRepos(): string[] {
    const cfg = deps.config();
    const out = new Map<string, string>();
    for (const [repo, on] of Object.entries(cfg.repos)) if (on) out.set(lower(repo), repo);
    for (const repo of knownRepos) if (!out.has(lower(repo))) out.set(lower(repo), repo);
    return [...out.values()];
  }

  function onPollerEvent(event: ReviewPollerEvent): void {
    if (disposed) return;
    const cfg = deps.config();
    switch (event.kind) {
      case "status":
        ghStatus = event.status;
        changed(null);
        return;
      case "repo-error":
        repoErrors.set(event.repo, event.message);
        changed(null);
        return;
      case "prs":
        repoErrors.clear();
        prs.clear();
        for (const pr of event.prs) prs.set(lower(makePrKey(pr.repo, pr.number)), pr);
        changed(null);
        void requestEvaluation();
        return;
      case "comments":
        if (cfg.notify.comment) notify({ kind: "review-comment", pr: event.prKey });
        changed(event.prKey);
        void requestEvaluation();
        return;
      case "review-requested":
        if (cfg.notify.requested) {
          notify({ kind: "review-requested", pr: makePrKey(event.pr.repo, event.pr.number) });
        }
        changed(makePrKey(event.pr.repo, event.pr.number));
        return;
      default:
        // A newer poller's event kind this service does not know: ignored.
        return;
    }
  }

  const poller = deps.createPoller({
    gh: deps.gh,
    store: deps.store,
    config: deps.config,
    repos: pollRepos,
    schedule: deps.schedule,
    now: deps.now,
    onEvent: onPollerEvent,
  });

  const stopOutput = deps.shells.onOutput(({ paneKey }) => {
    if (disposed) return;
    lastOutput.set(paneKey, deps.now());
    if (!seenPanes.has(paneKey)) {
      seenPanes.add(paneKey);
      void requestEvaluation();
    }
    quietTimers.get(paneKey)?.();
    quietTimers.set(
      paneKey,
      deps.schedule(() => {
        quietTimers.delete(paneKey);
        void requestEvaluation();
      }, REVIEW_QUIET_MS),
    );
  });
  const stopExit = deps.shells.onShellExit(({ paneKey }) => {
    if (disposed) return;
    seenPanes.delete(paneKey);
    lastOutput.delete(paneKey);
    quietTimers.get(paneKey)?.();
    quietTimers.delete(paneKey);
    void requestEvaluation();
  });

  // Project repositories are learned up front so the first poll has them.
  for (const dir of deps.projectDirs()) {
    void repoOf(dir).then((repo) => {
      if (repo !== undefined) knownRepos.add(repo);
    });
  }
  poller.start();
  armSafety();

  function prOrThrow(prKey: PrKey): PullRequest {
    const pr = prs.get(lower(prKey));
    if (pr === undefined) throw new Error(`Unknown pull request: ${prKey}`);
    return pr;
  }

  async function queueInstruction(item: PendingInstruction): Promise<DeliveryOutcome> {
    return exclusive(async () => {
      const key = lower(item.prKey);
      const pr = prs.get(key);
      const link =
        pr === undefined
          ? { kind: "none" as const }
          : (links.get(key) ?? { kind: "none" as const });
      const outcome = await deliverInstruction(item, link);
      if (outcome.sent) pending.delete(key);
      else pending.set(key, item);
      return outcome;
    });
  }

  async function countsFor(prKey: PrKey): Promise<QueuedComment[]> {
    const pr = prs.get(lower(prKey));
    return pr === undefined ? [] : deps.store.thread(makePrKey(pr.repo, pr.number));
  }

  return {
    status: () => ({
      gh: ghStatus,
      enabled: deps.config().enabled,
      repoErrors: Object.fromEntries(repoErrors),
    }),

    async list() {
      const items: ReviewListItem[] = [];
      for (const [key, pr] of prs) {
        const thread = await countsFor(makePrKey(pr.repo, pr.number));
        let lastActivity = 0;
        for (const q of thread) {
          lastActivity = Math.max(lastActivity, q.comment.createdAt, q.deliveredAt ?? 0);
        }
        items.push({
          pr,
          link: links.get(key) ?? { kind: "none" },
          queued: thread.filter((q) => q.state === "queued").length,
          delivered: thread.filter((q) => q.state === "delivered").length,
          waitReason: waits.get(key) ?? null,
          lastActivity,
        });
      }
      return items;
    },

    async thread(prKey) {
      const key = lower(prKey);
      const pr = prs.get(key);
      if (pr === undefined) return undefined;
      return {
        pr,
        link: links.get(key) ?? { kind: "none" },
        waitReason: waits.get(key) ?? null,
        comments: await deps.store.thread(makePrKey(pr.repo, pr.number)),
      };
    },

    async reply(prKey, body, inReplyTo) {
      const pr = prOrThrow(prKey);
      const posted =
        inReplyTo === undefined
          ? await deps.gh.postComment(pr, body)
          : await deps.gh.replyToReviewComment(pr, inReplyTo, body);
      const canonical = makePrKey(pr.repo, pr.number);
      await deps.store.markOwn(canonical, posted);
      changed(canonical);
      return posted;
    },

    async link(prKey, paneKey) {
      const pr = prs.get(lower(prKey));
      await deps.store.setManualLink(
        pr === undefined ? prKey : makePrKey(pr.repo, pr.number),
        paneKey,
      );
      changed(prKey);
      await requestEvaluation();
    },

    async pause(paneKey, paused) {
      await deps.store.setPaused(paneKey, paused);
      changed(null);
      await requestEvaluation();
    },

    async requeue(prKey, commentId) {
      const thread = await countsFor(prKey);
      const entry = thread.find((q) => q.comment.id === commentId && q.state === "history");
      if (entry === undefined) return false;
      const ok = await deps.store.requeue(
        reviewCommentKey(entry.prKey, entry.comment.kind, entry.comment.id),
      );
      if (ok) {
        changed(entry.prKey);
        void requestEvaluation();
      }
      return ok;
    },

    deliverNow(prKey) {
      return exclusive(async () => {
        const outcome = await evaluate(lower(prKey));
        return outcome ?? { sent: false, wait: "nothing" };
      });
    },

    sendReview(prKey, paneKey) {
      const pr = prOrThrow(prKey);
      return queueInstruction({
        prKey: makePrKey(pr.repo, pr.number),
        paneKey,
        text: reviewInstruction(pr),
      });
    },

    postSummary(prKey) {
      const pr = prOrThrow(prKey);
      return queueInstruction({
        prKey: makePrKey(pr.repo, pr.number),
        text: summaryInstruction(pr),
      });
    },

    async pollNow() {
      await poller.pollNow();
      await requestEvaluation();
    },

    paneStateOf,

    onChanged(cb) {
      changedListeners.add(cb);
      return () => changedListeners.delete(cb);
    },

    onNotify(cb) {
      notifyListeners.add(cb);
      return () => notifyListeners.delete(cb);
    },

    async whenIdle() {
      for (;;) {
        const current = chain;
        await current;
        if (current === chain && queuedRun === undefined) return;
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      poller.stop();
      cancelSafety?.();
      for (const cancel of quietTimers.values()) cancel();
      quietTimers.clear();
      stopOutput();
      stopExit();
      changedListeners.clear();
      notifyListeners.clear();
    },
  };
}
