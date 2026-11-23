import type { RendererApi } from "../src/ipc.js";

// The tabs this host shows in windows of their own (popout.ts), as the main
// window knows them. The host owns the truth; this is a mirror, re-read at
// start so a reload of this window loses nothing, and followed by a push.
//
// A tab that has just come back still counts as popped until its return has
// been taken (what its terminal carried: layout, unsent text), so nothing
// draws it here before that state can be applied.

let popped: ReadonlySet<string> = new Set();
/** Tabs that left `popped` whose return is still being taken. */
const settling = new Set<string>();
let effective: ReadonlySet<string> = new Set();
const listeners = new Set<(ids: ReadonlySet<string>) => void>();
let onReturn: ((tabId: string) => Promise<void>) | undefined;

export const poppedTabs = (): ReadonlySet<string> => effective;
export const isPopped = (tabId: string): boolean => effective.has(tabId);

function publish(): void {
  const next = new Set([...popped, ...settling]);
  if (next.size === effective.size && [...next].every((id) => effective.has(id))) return;
  effective = next;
  for (const listener of [...listeners]) listener(effective);
}

/** Replaces the set. True when what the window shows as popped changed. */
export function setPoppedTabs(ids: unknown): boolean {
  const next = new Set<string>(
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
  );
  const before = effective;
  const left = [...popped].filter((id) => !next.has(id));
  popped = next;
  for (const id of left) {
    if (onReturn === undefined || settling.has(id)) continue;
    settling.add(id);
    onReturn(id)
      .catch(() => undefined)
      .finally(() => {
        settling.delete(id);
        publish();
      });
  }
  publish();
  return effective !== before;
}

export function onPoppedChange(listener: (ids: ReadonlySet<string>) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the host's list and follows its changes. `returned` is awaited for
 *  each tab that comes back, before it counts as back. Never throws: a host
 *  without the channels is one with no pop-outs. */
export async function initPopped(
  api: Pick<RendererApi, "popoutList" | "onPopoutChanged">,
  returned?: (tabId: string) => Promise<void>,
): Promise<void> {
  onReturn = returned;
  try {
    api.onPopoutChanged((ids) => setPoppedTabs(ids));
  } catch {
    // No channel.
  }
  try {
    setPoppedTabs(await api.popoutList());
  } catch {
    // None popped.
  }
}
