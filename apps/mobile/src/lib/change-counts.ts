// Each live session's changed-file count and +/- line totals, pushed by the
// laptop as `git:counts` (a `latest` push: only the newest value matters).
// Home's Active rows show them; there is no request channel, so nothing is
// known until the first push lands. Parsed field by field: a row that does
// not have the shape is dropped, never guessed.
import type { RpcClient } from "./rpc-client";

export type ChangeCount = { files: number; insertions: number; deletions: number };

export type ChangeCountsView = Readonly<Record<string, ChangeCount>>;

export type ChangeCountsStore = {
  get(): ChangeCountsView;
  subscribe(listener: (view: ChangeCountsView) => void): () => void;
  focus(): void;
  blur(): void;
};

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseChangeCounts(value: unknown): ChangeCountsView {
  if (!Array.isArray(value)) return {};
  const counts: Record<string, ChangeCount> = {};
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.sessionId !== "string") continue;
    const files = count(row.files);
    const insertions = count(row.insertions);
    const deletions = count(row.deletions);
    if (files === undefined || insertions === undefined || deletions === undefined) continue;
    counts[row.sessionId] = { files, insertions, deletions };
  }
  return counts;
}

export function createChangeCountsStore(deps: { client: RpcClient }): ChangeCountsStore {
  const listeners = new Set<(view: ChangeCountsView) => void>();
  let view: ChangeCountsView = {};
  let unsubscribePush: (() => void) | undefined;
  let focused = false;
  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focus() {
      if (focused) return;
      focused = true;
      unsubscribePush = deps.client.onPush("git:counts", (payload) => {
        view = parseChangeCounts(payload);
        for (const listener of [...listeners]) listener(view);
      });
      deps.client.subscribe("git:counts");
    },
    blur() {
      if (!focused) return;
      focused = false;
      deps.client.unsubscribe("git:counts");
      unsubscribePush?.();
      unsubscribePush = undefined;
    },
  };
}
