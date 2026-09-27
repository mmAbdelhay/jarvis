import type { RpcClient, RpcResult } from "./rpc-client";
import type { AnchoredComment, PlanDoc, PlanList, PlanResult } from "../plan/types";

export type PlansState = {
  list?: PlanList;
  doc?: PlanDoc;
  comments: AnchoredComment[];
  error?: string;
};

export type PlansStore = {
  state: PlansState;
  load(): Promise<void>;
  open(path: string): Promise<void>;
  addComment(blockId: string, quote: string, body: string): Promise<void>;
  send(ids?: string[]): Promise<void>;
  writeBlock(blockId: string, source: string): Promise<"ok" | "conflict" | "error">;
  subscribe(cb: () => void): () => void;
};

export type PlansStoreDeps = {
  client: RpcClient;
  paneKey: string;
  /** Optional because the terminal route does not currently expose a cwd. */
  cwd?: string;
};

const LOAD_ERROR = "plans.loadFailed";

function errorOf(result: RpcResult): string {
  return !result.ok && result.error.kind === "remote" ? result.error.text : LOAD_ERROR;
}

export function createPlansStore(deps: PlansStoreDeps): PlansStore {
  const state: PlansState = { comments: [] };
  const listeners = new Set<() => void>();
  let stopPush: (() => void) | undefined;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    const args = deps.cwd === undefined ? [deps.paneKey] : [deps.paneKey, deps.cwd];
    const result = await deps.client.call("plans:list", args);
    if (!result.ok) {
      state.error = errorOf(result);
    } else {
      state.list = result.value as PlanList;
      state.error = undefined;
    }
    emit();
  }

  async function reloadComments(path: string): Promise<void> {
    const result = await deps.client.call("plans:comments", [path]);
    if (state.doc?.path !== path) return;
    if (!result.ok) state.error = errorOf(result);
    else state.comments = result.value as AnchoredComment[];
    emit();
  }

  async function open(path: string): Promise<void> {
    const result = await deps.client.call("plans:read", [path]);
    if (!result.ok) {
      state.error = errorOf(result);
      emit();
      return;
    }
    const outcome = result.value as PlanResult<PlanDoc>;
    if (!outcome.ok) {
      state.error = outcome.detail ?? outcome.reason;
      if (outcome.doc !== undefined) state.doc = outcome.doc;
      emit();
      return;
    }
    state.doc = outcome.value;
    state.error = undefined;
    emit();
    await reloadComments(path);
  }

  async function addComment(blockId: string, quote: string, body: string): Promise<void> {
    const path = state.doc?.path;
    if (path === undefined) return;
    const result = await deps.client.call("plans:addComment", [path, blockId, quote, body]);
    if (!result.ok) {
      state.error = errorOf(result);
      emit();
      return;
    }
    await reloadComments(path);
  }

  async function send(ids?: string[]): Promise<void> {
    const path = state.doc?.path;
    if (path === undefined) return;
    const selected =
      ids ?? state.comments.filter((item) => item.sentAt === undefined).map((item) => item.id);
    if (selected.length === 0) return;
    const result = await deps.client.call("plans:send", [deps.paneKey, path, selected]);
    if (!result.ok) {
      state.error = errorOf(result);
      emit();
      return;
    }
    await reloadComments(path);
  }

  async function writeBlock(blockId: string, source: string): Promise<"ok" | "conflict" | "error"> {
    const current = state.doc;
    if (current === undefined) return "error";
    const result = await deps.client.call("plans:writeBlock", [
      current.path,
      blockId,
      source,
      current.mtimeMs,
    ]);
    if (!result.ok) {
      state.error = errorOf(result);
      emit();
      return "error";
    }
    const outcome = result.value as PlanResult<PlanDoc>;
    if (!outcome.ok) {
      if (outcome.doc !== undefined) state.doc = outcome.doc;
      state.error = outcome.detail;
      emit();
      return outcome.reason === "conflict" ? "conflict" : "error";
    }
    state.doc = outcome.value;
    state.error = undefined;
    emit();
    return "ok";
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

  return { state, load, open, addComment, send, writeBlock, subscribe };
}
