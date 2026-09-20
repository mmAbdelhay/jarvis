// The Docker log stream (M9 Task 6): one device-owned `docker logs -f`
// follower, mirroring the desktop's follower contract
// (packages/desktop/src/docker-followers.ts, packages/desktop/src/
// remote-push-policy.ts's `dockerLogPolicy`) from the phone side, without
// importing anything from @jarvis/desktop (global-constraints.md rule 4).
//
// Unlike session-stream.ts's `session:output`, `docker:log` carries no
// offset/cursor — a follower is not durable history (M5 ruling), so this
// store never asks for a snapshot; it only appends what the server pushes
// while a follower is live, and shows a plain gap marker across anything it
// missed.
//
// M5 rulings reused here:
//  - A device's follower streams exist only while attached: `close()` (blur/
//    unmount) always drops the local keyed subscription and best-effort
//    unfollows the desktop's `docker logs -f` process, never leaving one
//    running for a screen nobody is looking at.
//  - On any state away from "open", the local keyed subscription is dropped
//    immediately — the desktop's own disconnect handler already reaps this
//    device's followers (main.ts's `followers.unfollowOwnedBy(deviceId)`),
//    and the server's `addKeyedTarget` (packages/remote/src/connection.ts)
//    silently drops an unauthorized re-add rather than erroring, so a phone
//    that left the stale target in RpcClient's own re-`sub`-on-welcome list
//    would sit "open" with no pushes and no visible failure. Reconnect
//    always follows again under a fresh `remote-<32hex>` id (never the old
//    one) before re-subscribing.
//  - Live logs are not durable history: reconnecting after a gap inserts a
//    plain marker into the text rather than pretending nothing was missed.
//
// Logging discipline (global-constraints.md rule 7): nothing here ever
// carries container output — this store exposes no `log` line at all, only
// the `DockerLogView` a caller may log fields of (phase, counts) itself.

import type { RpcClient, RpcResult } from "./rpc-client";
import { parseGitViewResult } from "./workspace-results";

/** Retained mobile text cap (task-6-brief.md): older text is trimmed from
 *  the front once the live log exceeds this many UTF-16 units. */
export const DOCKER_LOG_TEXT_CAP = 262_144;

/** Inserted once, in place of the text missed while disconnected — plain,
 *  language-neutral content (never routed through i18n: this is stream
 *  content, not app chrome, same rule stream-cursor.ts's `gapMarker`
 *  follows for session output). No ANSI: unlike session-stream.ts's
 *  terminal sink, this store's text renders in a plain native `Text`
 *  (task-6-brief.md rule 4), which would show escape codes as literal
 *  characters instead of interpreting them. */
export const DOCKER_LOG_GAP_MARKER = "\n⋯\n";

/** Shown when a `docker:follow` call itself never reached the server with a
 *  usable answer (offline/timeout/unsupported) — no server text exists to
 *  show verbatim, so this resolves through i18n.ts like
 *  sidecars-store.ts's `GENERIC_LOAD_ERROR`. */
export const DOCKER_LOG_FOLLOW_FAILED = "docker.log.followFailed";

export type DockerLogPhase = "idle" | "following" | "waiting" | "failed";

export type DockerLogView = {
  text: string;
  phase: DockerLogPhase;
  droppedBytes: number;
  notice?: string;
};

export type DockerLogStream = {
  follow(project: string, container: string): Promise<void>;
  get(): DockerLogView;
  subscribe(fn: (view: DockerLogView) => void): () => void;
  close(): void;
};

/** `remote-` plus 32 lowercase hex characters — a subset of the server's
 *  own `REMOTE_FOLLOW_TAB_PATTERN` (docker-followers.ts), minted the same
 *  way voice-controller.ts's `newTurnId` mints @jarvis/wire's
 *  TURN_ID_PATTERN: never a desktop tab id. */
export function newFollowId(random: () => number): string {
  let id = "remote-";
  for (let i = 0; i < 32; i++) {
    id += Math.floor(random() * 16).toString(16);
  }
  return id;
}

/** A wire-level `RpcResult` failure, resolved the same way
 *  changes-store.ts's `noticeFromResult` resolves one: server text shown
 *  verbatim, everything else this screen's own generic fallback.
 *
 *  Fix round 1, Important 3 (task-6-review.md): unlike changes-store.ts
 *  (where `offline`/`timeout` leave the notice unset and `uncertain` alone
 *  carries the meaning), `DockerLogView` has no `uncertain` field — leaving
 *  the notice unset here left the panel blank with no error and no retry
 *  cue, so `offline`/`timeout` now resolve through the same generic
 *  fallback as `unsupported` instead of being left silent. */
function noticeFromResult(result: RpcResult): string | undefined {
  if (result.ok) return undefined;
  if (result.error.kind === "remote") return result.error.text;
  return DOCKER_LOG_FOLLOW_FAILED;
}

/** Parses a `docker:log` push payload defensively: `{ tabId, chunk }`
 *  (remote-push-policy.ts's `dockerLogPolicy`), matched against the id this
 *  stream currently owns — another key's push (or a malformed payload) is
 *  never applied. */
function parseDockerLogChunk(payload: unknown, id: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const obj = payload as Record<string, unknown>;
  if (obj.tabId !== id) return undefined;
  return typeof obj.chunk === "string" ? obj.chunk : undefined;
}

/** Appends `chunk` to `text`, trimming from the front once the result
 *  exceeds `DOCKER_LOG_TEXT_CAP` UTF-16 units and carrying the trimmed
 *  amount into `droppedBytes` — pure, so the cap arithmetic is unit
 *  testable on its own. */
function appended(
  text: string,
  droppedBytes: number,
  chunk: string,
): { text: string; droppedBytes: number } {
  let next = text + chunk;
  let dropped = droppedBytes;
  if (next.length > DOCKER_LOG_TEXT_CAP) {
    const overflow = next.length - DOCKER_LOG_TEXT_CAP;
    next = next.slice(overflow);
    dropped += overflow;
  }
  return { text: next, droppedBytes: dropped };
}

export function createDockerLogStream(deps: {
  client: RpcClient;
  randomId(): string;
}): DockerLogStream {
  const { client } = deps;
  const listeners = new Set<(view: DockerLogView) => void>();
  let view: DockerLogView = { text: "", phase: "idle", droppedBytes: 0 };

  let current: { project: string; container: string } | undefined;
  let id: string | undefined;
  let generation = 0;
  let attached = false;
  // Set only while a real follow was live and the connection then dropped
  // (never on a first attach) — attach() consumes it once, inserting the
  // gap marker for exactly that segment.
  let reconnecting = false;

  let unsubscribePush: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;

  function setView(patch: Partial<DockerLogView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) listener(view);
  }

  function appendText(chunk: string): void {
    if (chunk.length === 0) return;
    setView(appended(view.text, view.droppedBytes, chunk));
  }

  function dropLocalSubscription(): void {
    if (id === undefined) return;
    client.unsubscribe({ ch: "docker:log", key: id });
    id = undefined;
  }

  function bestEffortUnfollow(followId: string): void {
    // Never queued (global-constraints.md rule 5): an unfollow that can't
    // reach the server now is not worth holding — the server's own
    // disconnect cleanup (main.ts) reaps it anyway once this device drops.
    if (client.state() !== "open") return;
    void client.call("docker:unfollow", [followId], { whenNotOpen: "reject" });
  }

  async function attach(myGeneration: number, project: string, container: string): Promise<void> {
    const newId = deps.randomId();
    const result = await client.call("docker:follow", [newId, project, container], {
      whenNotOpen: "reject",
    });
    if (myGeneration !== generation) {
      // Superseded by close()/a newer follow()/a newer reattach while this
      // call was in flight — a late success must never leave a follower
      // nobody will ever read (task-6-brief.md: "late follow success after
      // close still gets cleanup when connected"), and neither must a late
      // *timeout* (fix round 1, Important 3): the desktop may have created
      // the follower before the reply was lost, exactly as when this
      // generation is still current.
      if (result.ok) {
        const parsed = parseGitViewResult(result.value, (): true => true);
        if (parsed.ok) bestEffortUnfollow(newId);
      } else if (result.error.kind === "timeout") {
        bestEffortUnfollow(newId);
      }
      return;
    }
    if (!result.ok) {
      if (result.error.kind === "timeout") {
        // Fix round 1, Important 3 (task-6-review.md): the client's own 30s
        // request timer fired while the connection is still "open" — unlike
        // a disconnect (where the server's own cleanup, main.ts's
        // `unfollowOwnedBy`, reaps every follower this device holds
        // regardless), nothing else will ever release this one: the
        // desktop may already have created it before the reply was lost.
        // Best-effort unfollow it now so a lost reply never strands one of
        // the device's four slots until the socket eventually drops.
        bestEffortUnfollow(newId);
      }
      setView({ phase: "failed", notice: noticeFromResult(result) });
      return;
    }
    const parsed = parseGitViewResult(result.value, (): true => true);
    if (!parsed.ok) {
      // The app-level refusal (owned-elsewhere/limit/unknown container) —
      // server text, shown verbatim.
      setView({ phase: "failed", notice: parsed.text });
      return;
    }
    // Rule 2: the keyed subscription is acquired only after `docker:follow`
    // has actually succeeded — never before.
    const subResult = client.subscribe({ ch: "docker:log", key: newId });
    if (!subResult.ok) {
      bestEffortUnfollow(newId);
      setView({ phase: "failed", notice: DOCKER_LOG_FOLLOW_FAILED });
      return;
    }
    id = newId;
    if (reconnecting) {
      reconnecting = false;
      setView({
        ...appended(view.text, view.droppedBytes, DOCKER_LOG_GAP_MARKER),
        phase: "following",
        notice: undefined,
      });
      return;
    }
    setView({ phase: "following", notice: undefined });
  }

  /** Terminal client states (rpc-client.ts's `ClientState`): no automatic
   *  reconnect is coming back from any of these, unlike `connecting`/
   *  `authenticating`/`reconnecting`. Fix round 1, Minor 2: treating them
   *  like an ordinary drop left the panel reading "Reconnecting…" forever
   *  after a revoke/incompatible-version/explicit disconnect. */
  const TERMINAL_CLIENT_STATES = new Set(["unpaired", "incompatible", "closed"]);

  function handlePush(payload: unknown, dropped: number | undefined): void {
    if (id === undefined || view.phase !== "following") return;
    const chunk = parseDockerLogChunk(payload, id);
    if (chunk === undefined) return;
    if (dropped !== undefined && dropped > 0) {
      // Fix round 1, Important 2 (task-6-review.md): the server's own
      // STREAM_MAX_BYTES overflow disclosure (remote-push-policy.ts,
      // rpc-client.ts's `onPush` second argument) — dropped exactly like
      // session-stream.ts's own gap marker, so a laptop-side drop is never
      // silently invisible.
      setView(appended(view.text, view.droppedBytes + dropped, DOCKER_LOG_GAP_MARKER));
    }
    appendText(chunk);
  }

  function handleState(state: string): void {
    if (current === undefined) return;
    if (state === "open") {
      generation += 1;
      const myGeneration = generation;
      void attach(myGeneration, current.project, current.container);
      return;
    }
    // Not open: drop the local keyed subscription now (see file header) —
    // never left for RpcClient's own re-`sub`-on-welcome to silently fail
    // to re-authorize.
    dropLocalSubscription();
    if (TERMINAL_CLIENT_STATES.has(state)) {
      // Fix round 1, Minor 2: no reconnect is coming — the next Follow tap
      // starts a fresh segment rather than this one ever resuming.
      reconnecting = false;
      setView({ phase: "failed", notice: DOCKER_LOG_FOLLOW_FAILED });
      return;
    }
    if (view.phase === "following") {
      reconnecting = true;
      setView({ phase: "waiting" });
    }
  }

  function ensureAttached(): void {
    if (attached) return;
    attached = true;
    unsubscribePush = client.onPush("docker:log", handlePush);
    unsubscribeState = client.onState(handleState);
  }

  // Fix round 1, Minor 3: a rapid repeat tap for the *same* segment while
  // the previous one is still attaching is ignored outright — without this,
  // five quick taps on the same row would each mint a fresh id and send a
  // fresh `docker:follow` before the first resolved, needlessly spending
  // the device's four-follower cap on duplicates of the exact same log.
  // Switching to a *different* container is never blocked by this — the
  // check is keyed on both the flag and the target matching.
  let followInFlight = false;

  async function follow(project: string, container: string): Promise<void> {
    ensureAttached();
    if (followInFlight && current?.project === project && current?.container === container) {
      return;
    }
    followInFlight = true;
    try {
      generation += 1;
      const myGeneration = generation;
      const previousId = id;
      dropLocalSubscription();
      if (previousId !== undefined) bestEffortUnfollow(previousId);
      current = { project, container };
      reconnecting = false;
      // Fix round 1, Minor 1: never optimistically "following" before
      // `docker:follow` has actually resolved — a drop during an in-flight
      // first follow must not look like a live segment ever existed (it
      // also kept the `reconnecting` flag, set only "while a real follow
      // was live", accurate).
      setView({ text: "", phase: "waiting", droppedBytes: 0, notice: undefined });
      if (client.state() !== "open") return;
      await attach(myGeneration, project, container);
    } finally {
      followInFlight = false;
    }
  }

  function close(): void {
    generation += 1;
    const previousId = id;
    dropLocalSubscription();
    if (previousId !== undefined) bestEffortUnfollow(previousId);
    current = undefined;
    reconnecting = false;
    unsubscribePush?.();
    unsubscribeState?.();
    unsubscribePush = undefined;
    unsubscribeState = undefined;
    attached = false;
    setView({ text: "", phase: "idle", droppedBytes: 0, notice: undefined });
  }

  return {
    follow,
    get: () => view,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    close,
  };
}
