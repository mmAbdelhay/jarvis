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
/** False from the start of initPopped until the host's list has answered (or
 *  a second has passed, or the channel failed): until then nothing can say
 *  which tabs this window must not draw. True when initPopped never ran. */
let ready = true;
let firstTaken = false;
const LIST_WAIT_MS = 1000;

export const isPoppedReady = (): boolean => ready;

/** Back to a fresh module's state (tests). */
export function resetPopped(): void {
  popped = new Set();
  settling.clear();
  effective = new Set();
  ready = true;
  firstTaken = false;
  onReturn = undefined;
}

export const poppedTabs = (): ReadonlySet<string> => effective;
export const isPopped = (tabId: string): boolean => effective.has(tabId);

function recompute(): boolean {
  const next = new Set([...popped, ...settling]);
  if (next.size === effective.size && [...next].every((id) => effective.has(id))) return false;
  effective = next;
  return true;
}

function publish(force = false): void {
  if (recompute() || force) for (const listener of [...listeners]) listener(effective);
}

function settle(id: string): void {
  if (onReturn === undefined || settling.has(id)) return;
  settling.add(id);
  onReturn(id)
    .catch(() => undefined)
    .finally(() => {
      settling.delete(id);
      publish();
    });
}

/** On the first draw after the list answered: tabs that came back while this
 *  window was reloading carry a staged return the list no longer shows, so it
 *  is taken for every terminal tab, once. Each counts as popped until taken
 *  (no draw in the meantime; the listeners redraw when it is). Never notifies
 *  from inside the draw that calls it. */
export function takeInitialReturns(tabIds: Iterable<string>): void {
  if (!ready || firstTaken || onReturn === undefined) return;
  firstTaken = true;
  for (const id of tabIds) if (!popped.has(id)) settle(id);
  recompute();
}

/** Replaces the set. True when what the window shows as popped changed. */
export function setPoppedTabs(ids: unknown): boolean {
  const next = new Set<string>(
    Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
  );
  const before = effective;
  const left = [...popped].filter((id) => !next.has(id));
  popped = next;
  for (const id of left) settle(id);
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
  ready = false;
  firstTaken = false;
  try {
    api.onPopoutChanged((ids) => setPoppedTabs(ids));
  } catch {
    // No channel.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let list: unknown;
  try {
    list = await Promise.race([
      api.popoutList(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), LIST_WAIT_MS);
      }),
    ]);
  } catch {
    // None popped.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // Ready first, so listeners told of the list can already draw; and told
  // even when the list changed nothing, because the window held its drawing.
  ready = true;
  if (list === undefined || !setPoppedTabs(list)) publish(true);
}
