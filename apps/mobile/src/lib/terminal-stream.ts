// M9 Task 7: a Workspace terminal pane's output, on the exact same
// attach/re-attach/gap-marker machinery M7's SessionStream already proved
// out — see session-stream.ts's `createAttachStream`, which this is a thin
// wrapper over. The only differences from a session's own stream are the
// channel names and the push payload's key field (`paneKey`, not
// `sessionId`): `terminal:data`/`terminal:snapshot`, keyed by `paneKey`, per
// task-7-brief.md's interface line and remote-policy.ts's terminal:* rows.

import type { Clock } from "./clock";
import type { RpcClient } from "./rpc-client";
import { createAttachStream, type SessionStream } from "./session-stream";

export function createTerminalStream(deps: {
  client: RpcClient;
  paneKey: string;
  log(line: string): void;
  clock: Clock;
}): SessionStream {
  return createAttachStream({
    client: deps.client,
    id: deps.paneKey,
    clock: deps.clock,
    log: deps.log,
    pushChannel: "terminal:data",
    keyField: "paneKey",
    snapshotChannel: "terminal:snapshot",
    logPrefix: "terminal-stream",
  });
}

// Fix round 1, Important 1: a pane's `terminal:exit` is a second keyed
// subscription the screen owns *beside* `terminal:data` (task-7-brief.md
// rule 3: "one selected pane owns exactly terminal:data and terminal:exit
// keyed subscriptions") — not folded into createAttachStream/SessionStream
// itself, which stays exactly what session/[id].tsx's own session stream
// already is (sessions have no analogous exit push). `matchesPaneExit`
// mirrors parseStreamChunk's own defensive "malformed or another key's
// push parses to false, never throws" discipline, minus the offset/chunk
// fields an exit payload doesn't carry.
export function matchesPaneExit(payload: unknown, paneKey: string): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const obj = payload as Record<string, unknown>;
  return obj.paneKey === paneKey;
}

export type TerminalExitWatcher = {
  close(): void;
};

/**
 * Owns one pane's `terminal:exit` keyed subscription. `onExit` fires at
 * most once per open watcher — the screen only needs the transition (to
 * disable input/resize and show the exited state), never a running count
 * or the exit code itself, which is never surfaced here (logging/UI
 * discipline: never log or render pane content, and an exit code is
 * incidental detail the screen has no use for). The screen creates this
 * alongside its `createTerminalStream` call and releases both in the same
 * cleanup (`close()` here, `stream.close()` there) — never one without the
 * other.
 */
export function watchTerminalExit(deps: {
  client: RpcClient;
  paneKey: string;
  onExit(): void;
}): TerminalExitWatcher {
  const target = { ch: "terminal:exit", key: deps.paneKey };
  let closed = false;
  let fired = false;
  const unsubscribePush = deps.client.onPush("terminal:exit", (payload) => {
    if (closed || fired) return;
    if (!matchesPaneExit(payload, deps.paneKey)) return;
    fired = true;
    deps.onExit();
  });
  deps.client.subscribe(target);
  return {
    close() {
      if (closed) return;
      closed = true;
      unsubscribePush();
      deps.client.unsubscribe(target);
    },
  };
}
