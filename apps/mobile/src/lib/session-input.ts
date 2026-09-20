// Task 5: raw session input. This is the path by which the phone types
// into an agent as the user — every byte comes from a native control (the
// key bar or the compose bar) and is sent verbatim, exactly once, never
// queued and never retried (ruling 6, global-constraints.md). Text and
// key bytes are never logged, only kinds/ids/lengths. See
// the mobile milestone 7, task 5 plan (docs/superpowers/plans).

import type { Clock } from "./clock";
import type { RpcClient, RpcResult } from "./rpc-client";
import type { KeyName, TerminalModes } from "./terminal-keys";
import { ctrlByte, keyBytes } from "./terminal-keys";

export const MAX_INPUT_CHARS = 16_384;
export const RESIZE_DEBOUNCE_MS = 300;

export type SendResult =
  | {
      kind:
        | "sent"
        | "empty"
        | "tooLong"
        | "offline"
        | "uncertain"
        | "rateLimited"
        | "ended"
        | "ctrlInvalid";
    }
  | { kind: "failed"; text: string };

export type SessionInput = {
  sendText(text: string): Promise<SendResult>;
  sendKey(key: KeyName): Promise<SendResult>;
  armCtrl(): void;
  disarmCtrl(): void;
  ctrlArmed(): boolean;
  setModes(modes: TerminalModes): void;
  setEnded(ended: boolean): void;
  resize(cols: number, rows: number): void;
  reassert(): void;
  dispose(): void;
};

export type SessionInputDeps = {
  client: RpcClient;
  clock: Clock;
  sessionId: string;
  log(line: string): void;
};

// M9 Task 7: identical raw-input machinery drives a session's own pty and
// one of the Workspace's existing terminal panes — only the channel names
// and the id itself differ (see terminal-input.ts). `createRawInput` is
// that shared core; `createSessionInput` is now a thin, exports-preserving
// wrapper around it, so every existing session-input.test.ts case (and its
// `sessionId`-shaped call site in session/[id].tsx) is untouched.
export type RawInputDeps = {
  client: RpcClient;
  clock: Clock;
  /** A session id or a terminal pane key — whatever `inputChannel` and
   *  `resizeChannel` name their first argument. */
  id: string;
  /** `session:input` or `terminal:input`. */
  inputChannel: string;
  /** `session:resize` or `terminal:resize`. */
  resizeChannel: string;
  /** The fixed first word of every log line this instance emits — kept
   *  distinct per caller only so a log reader can tell a session's input
   *  from a terminal pane's; never any content from the input itself. */
  logPrefix: string;
  log(line: string): void;
};

type Size = { cols: number; rows: number };

/** Maps a raw `RpcResult` for a non-queued send to the outward `SendResult`. */
function mapCallResult(result: RpcResult, wasOpenAtCallTime: boolean): SendResult {
  if (result.ok) return { kind: "sent" };
  const error = result.error;
  switch (error.kind) {
    case "offline":
      // Not open when the call was made -> nothing was ever sent. Open at
      // call time but offline by the time it resolved -> it may have been
      // sent; the drop happened in flight.
      return wasOpenAtCallTime ? { kind: "uncertain" } : { kind: "offline" };
    case "timeout":
      return { kind: "uncertain" };
    case "remote":
      if (error.code === "rate-limited") return { kind: "rateLimited" };
      return { kind: "failed", text: error.text };
    case "unsupported":
      return { kind: "failed", text: "" };
    case "busy":
    case "cancelled":
      // Task 5 additions to RpcError: upload()-only outcomes. call() (this
      // file's only use of RpcClient) never produces either — handled here
      // only for RpcError's exhaustiveness.
      return { kind: "failed", text: "" };
  }
}

function isValidDimension(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 1000;
}

export function createRawInput(deps: RawInputDeps): SessionInput {
  let modes: TerminalModes = { applicationCursor: false };
  let ctrlArmedFlag = false;
  let ended = false;
  // I1: `disposed` is deliberately separate from `ended`. `ended` is a
  // runtime toggle (setEnded(false) legitimately re-enables a live
  // session), but `dispose()` is permanent — a stray `setEnded(false)`
  // from a stale closure or a late push must never revive a disposed
  // instance's timers or state listener.
  let disposed = false;

  let latestSize: Size | undefined;
  let lastSentSize: Size | undefined;
  let resizeTimer: unknown;

  function blocked(): boolean {
    return ended || disposed;
  }

  function log(kind: string, len: number): void {
    deps.log(`${deps.logPrefix}: ${kind} id=${deps.id} len=${len}`);
  }

  async function sendBytes(bytes: string): Promise<SendResult> {
    const wasOpenAtCallTime = deps.client.state() === "open";
    const result = await deps.client.call(deps.inputChannel, [deps.id, bytes], {
      whenNotOpen: "reject",
    });
    const mapped = mapCallResult(result, wasOpenAtCallTime);
    log(mapped.kind, bytes.length);
    return mapped;
  }

  async function sendText(text: string): Promise<SendResult> {
    if (blocked()) {
      log("ended", text.length);
      return { kind: "ended" };
    }
    if (ctrlArmedFlag) {
      ctrlArmedFlag = false;
      const byte = ctrlByte(text);
      if (byte === undefined) {
        log("ctrlInvalid", text.length);
        return { kind: "ctrlInvalid" };
      }
      return sendBytes(byte);
    }
    if (text === "") {
      log("empty", 0);
      return { kind: "empty" };
    }
    if (text.length > MAX_INPUT_CHARS) {
      log("tooLong", text.length);
      return { kind: "tooLong" };
    }
    // Verbatim (ruling 3): no trim, no normalisation, no CR appended.
    return sendBytes(text);
  }

  async function sendKey(key: KeyName): Promise<SendResult> {
    if (blocked()) {
      log("ended", 0);
      return { kind: "ended" };
    }
    // A key never consumes the Ctrl latch.
    return sendBytes(keyBytes(key, modes));
  }

  function armCtrl(): void {
    ctrlArmedFlag = true;
  }

  function disarmCtrl(): void {
    ctrlArmedFlag = false;
  }

  function ctrlArmed(): boolean {
    return ctrlArmedFlag;
  }

  function setModes(next: TerminalModes): void {
    modes = next;
  }

  function cancelResizeTimer(): void {
    if (resizeTimer !== undefined) {
      deps.clock.clearTimeout(resizeTimer);
      resizeTimer = undefined;
    }
  }

  function setEnded(next: boolean): void {
    // I1: a disposed instance is permanently ended — setEnded(false) from
    // a stale closure or a late-arriving push must not revive it.
    if (disposed) return;
    ended = next;
    if (next) cancelResizeTimer();
  }

  /** Fire-and-forget: resize results are not surfaced, only logged on failure. */
  function sendResize(size: Size): void {
    lastSentSize = size;
    const wasOpenAtCallTime = deps.client.state() === "open";
    void deps.client
      .call(deps.resizeChannel, [deps.id, size.cols, size.rows], { whenNotOpen: "reject" })
      .then((result) => {
        const mapped = mapCallResult(result, wasOpenAtCallTime);
        if (mapped.kind !== "sent") {
          deps.log(`${deps.logPrefix}: resize-${mapped.kind} id=${deps.id}`);
          // M1: a failed/uncertain/offline attempt never reached the pty,
          // so it must not count as "the last size sent" — otherwise the
          // dedupe check in resize()'s debounce would silently swallow a
          // retry of the very same size. Only clear it if nothing newer
          // has since become the last-sent value (object identity: `size`
          // is the exact object sendResize was called with).
          if (lastSentSize === size) lastSentSize = undefined;
        }
      });
  }

  function resize(cols: number, rows: number): void {
    if (blocked()) return;
    if (!isValidDimension(cols) || !isValidDimension(rows)) return;
    latestSize = { cols, rows };
    cancelResizeTimer();
    resizeTimer = deps.clock.setTimeout(() => {
      resizeTimer = undefined;
      if (blocked() || latestSize === undefined) return;
      if (
        lastSentSize !== undefined &&
        lastSentSize.cols === latestSize.cols &&
        lastSentSize.rows === latestSize.rows
      ) {
        return;
      }
      sendResize(latestSize);
    }, RESIZE_DEBOUNCE_MS);
  }

  function reassert(): void {
    if (blocked() || latestSize === undefined) return;
    sendResize(latestSize);
  }

  const unsubscribeState = deps.client.onState((state) => {
    if (state === "open") {
      // Ruling 11: a fresh connection has no notion of "last sent" — the
      // size must go over again even if it happens to equal the size sent
      // on the previous connection.
      lastSentSize = undefined;
      reassert();
    }
  });

  function dispose(): void {
    disposed = true;
    ended = true;
    cancelResizeTimer();
    unsubscribeState();
  }

  return {
    sendText,
    sendKey,
    armCtrl,
    disarmCtrl,
    ctrlArmed,
    setModes,
    setEnded,
    resize,
    reassert,
    dispose,
  };
}

export function createSessionInput(deps: SessionInputDeps): SessionInput {
  return createRawInput({
    client: deps.client,
    clock: deps.clock,
    id: deps.sessionId,
    log: deps.log,
    inputChannel: "session:input",
    resizeChannel: "session:resize",
    logPrefix: "session-input",
  });
}
