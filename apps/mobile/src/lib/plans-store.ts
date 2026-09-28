import type { RpcClient, RpcResult } from "./rpc-client";
import type {
  AnchoredComment,
  PlanBlock,
  PlanComment,
  PlanDoc,
  PlanList,
  PlanResult,
} from "../plan/types";

export type PlansState = {
  list?: PlanList;
  doc?: PlanDoc;
  comments: AnchoredComment[];
  error?: PlanError;
};

export type PlanErrorCode =
  | "loadFailed"
  | "sendFailed"
  | "saveFailed"
  | "conflict"
  | "tooLarge"
  | "forbidden"
  | "noPane"
  | "noComments";
export type PlanError = { code: PlanErrorCode; detail?: string };
export type PlanActionResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; error: PlanError };

/** Final fix wave I4: what became of an edited block's save. `kept` means
 *  the write was refused because the plan changed (or the block is gone):
 *  the caller keeps the user's typed text, retargeted at `block` — the
 *  same block in the fresh doc, whose mtime is now the base — or, with no
 *  `block`, just shown alongside the notice. */
export type BlockSaveOutcome =
  | { kind: "saved" }
  | { kind: "kept"; block: PlanBlock | undefined; notice: "changedOnDisk" | "blockGone" }
  | { kind: "error" };

export type PlansStore = {
  state: PlansState;
  load(): Promise<void>;
  open(path: string): Promise<void>;
  /** Final fix wave M5: loads the list and, unless a plan is already open,
   *  opens the pane's default plan (session, else the newest plan-mode or
   *  repo entry) with its comments. */
  openDefault(): Promise<void>;
  addComment(blockId: string, quote: string, body: string): Promise<PlanActionResult<PlanComment>>;
  send(ids?: string[]): Promise<PlanActionResult>;
  writeBlock(
    blockId: string,
    source: string,
  ): Promise<"ok" | "conflict" | "missing-block" | "error">;
  saveBlock(block: PlanBlock, source: string): Promise<BlockSaveOutcome>;
  /** Final fix wave M4: drops a stale error (e.g. when a sheet opens). */
  clearError(): void;
  subscribe(cb: () => void): () => void;
};

export type PlansStoreDeps = {
  client: RpcClient;
  paneKey: string;
  /** Optional because the terminal route does not currently expose a cwd. */
  cwd?: string;
};

function rpcError(result: RpcResult, code: PlanErrorCode): PlanError {
  if (!result.ok && result.error.kind === "remote") return { code, detail: result.error.text };
  return { code };
}

function reasonError(reason: string, fallback: PlanErrorCode, detail?: string): PlanError {
  const codes: Record<string, PlanErrorCode> = {
    conflict: "conflict",
    "too-large": "tooLarge",
    tooLarge: "tooLarge",
    forbidden: "forbidden",
    "no-pane": "noPane",
    noPane: "noPane",
    "no-comments": "noComments",
    noComments: "noComments",
  };
  return { code: codes[reason] ?? fallback, ...(detail === undefined ? {} : { detail }) };
}

export function createPlansStore(deps: PlansStoreDeps): PlansStore {
  const state: PlansState = { comments: [] };
  const listeners = new Set<() => void>();
  let stopPush: (() => void) | undefined;
  let openSequence = 0;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    const args = deps.cwd === undefined ? [deps.paneKey] : [deps.paneKey, deps.cwd];
    const result = await deps.client.call("plans:list", args);
    if (!result.ok) {
      state.error = rpcError(result, "loadFailed");
    } else {
      state.list = result.value as PlanList;
      state.error = undefined;
    }
    emit();
  }

  async function reloadComments(path: string): Promise<void> {
    const result = await deps.client.call("plans:comments", [path]);
    if (state.doc?.path !== path) return;
    if (!result.ok) state.error = rpcError(result, "loadFailed");
    else state.comments = result.value as AnchoredComment[];
    emit();
  }

  async function open(path: string): Promise<void> {
    const sequence = ++openSequence;
    const result = await deps.client.call("plans:read", [path]);
    if (sequence !== openSequence) return;
    if (!result.ok) {
      state.error = rpcError(result, "loadFailed");
      emit();
      return;
    }
    const outcome = result.value as PlanResult<PlanDoc>;
    if (!outcome.ok) {
      state.error = reasonError(outcome.reason, "loadFailed", outcome.detail);
      if (outcome.doc !== undefined) state.doc = outcome.doc;
      emit();
      return;
    }
    state.doc = outcome.value;
    state.error = undefined;
    emit();
    await reloadComments(path);
  }

  async function addComment(
    blockId: string,
    quote: string,
    body: string,
  ): Promise<PlanActionResult<PlanComment>> {
    const path = state.doc?.path;
    if (path === undefined) {
      const error: PlanError = { code: "saveFailed" };
      state.error = error;
      emit();
      return { ok: false, error };
    }
    const result = await deps.client.call("plans:addComment", [path, blockId, quote, body]);
    if (!result.ok) {
      const error = rpcError(result, "saveFailed");
      state.error = error;
      emit();
      return { ok: false, error };
    }
    const created = result.value as PlanComment;
    state.error = undefined;
    await reloadComments(path);
    return { ok: true, value: created };
  }

  async function send(ids?: string[]): Promise<PlanActionResult> {
    const path = state.doc?.path;
    if (path === undefined) {
      const error: PlanError = { code: "sendFailed" };
      state.error = error;
      emit();
      return { ok: false, error };
    }
    const selected =
      ids ?? state.comments.filter((item) => item.sentAt === undefined).map((item) => item.id);
    if (selected.length === 0) return { ok: true, value: undefined };
    const result = await deps.client.call("plans:send", [deps.paneKey, path, selected]);
    if (!result.ok) {
      const error = rpcError(result, "sendFailed");
      state.error = error;
      emit();
      return { ok: false, error };
    }
    const outcome = result.value as { ok: true; sent: number } | { ok: false; reason: string };
    if (!outcome.ok) {
      const error = reasonError(outcome.reason, "sendFailed");
      state.error = error;
      emit();
      return { ok: false, error };
    }
    state.error = undefined;
    await reloadComments(path);
    return { ok: true, value: undefined };
  }

  async function writeBlock(
    blockId: string,
    source: string,
  ): Promise<"ok" | "conflict" | "missing-block" | "error"> {
    const current = state.doc;
    if (current === undefined) return "error";
    const result = await deps.client.call("plans:writeBlock", [
      current.path,
      blockId,
      source,
      current.mtimeMs,
    ]);
    if (!result.ok) {
      state.error = rpcError(result, "saveFailed");
      emit();
      return "error";
    }
    const outcome = result.value as PlanResult<PlanDoc>;
    if (!outcome.ok) {
      if (outcome.doc !== undefined) state.doc = outcome.doc;
      state.error = reasonError(outcome.reason, "saveFailed", outcome.detail);
      emit();
      return outcome.reason === "conflict" || outcome.reason === "missing-block"
        ? outcome.reason
        : "error";
    }
    state.doc = outcome.value;
    state.error = undefined;
    emit();
    return "ok";
  }

  async function saveBlock(block: PlanBlock, source: string): Promise<BlockSaveOutcome> {
    const before = state.doc;
    const result = await writeBlock(block.id, source);
    if (result === "ok") return { kind: "saved" };
    if (result === "error" || before === undefined) return { kind: "error" };
    // Re-read (doc + comments) so the base mtime and the pins are current;
    // the typed text itself stays with the caller untouched.
    await open(before.path);
    const fresh = state.doc;
    const index = before.blocks.findIndex((item) => item.id === block.id);
    const atIndex = index < 0 ? undefined : fresh?.blocks[index];
    const target =
      fresh?.blocks.find((item) => item.id === block.id) ??
      (atIndex?.kind === block.kind ? atIndex : undefined);
    return target === undefined
      ? { kind: "kept", block: undefined, notice: "blockGone" }
      : { kind: "kept", block: target, notice: "changedOnDisk" };
  }

  async function openDefault(): Promise<void> {
    await load();
    if (state.doc !== undefined) return;
    const list = state.list;
    const first = list?.session ?? list?.planMode[0] ?? list?.repo[0];
    if (first !== undefined) await open(first.path);
  }

  function clearError(): void {
    if (state.error === undefined) return;
    state.error = undefined;
    emit();
  }

  function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    if (listeners.size === 1) {
      stopPush = deps.client.onPush("plans:changed", (payload) => {
        if (typeof payload === "string" && payload === state.doc?.path) void open(payload);
        void load();
      });
      deps.client.subscribe("plans:changed");
    }
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) {
        stopPush?.();
        stopPush = undefined;
        deps.client.unsubscribe("plans:changed");
      }
    };
  }

  return {
    state,
    load,
    open,
    openDefault,
    addComment,
    send,
    writeBlock,
    saveBlock,
    clearError,
    subscribe,
  };
}
