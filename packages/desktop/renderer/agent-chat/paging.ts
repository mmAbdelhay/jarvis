// How the pages the main process sends become one list: the live page (the
// latest items, sent again on every look) replaces its own part; the older
// pages loaded so far stay; `reset` starts over. Items are matched by their
// stable id, so a tool that finished takes the place of the running one.
import type { ChatItem } from "@jarvis/platform";

/** The previous list with the live page applied. */
export function mergeLive(
  previous: readonly ChatItem[],
  live: readonly ChatItem[],
  reset: boolean,
): ChatItem[] {
  if (reset || previous.length === 0) return [...live];
  const liveIds = new Set(live.map((item) => item.id));
  // What was loaded before the live page starts is everything up to the first
  // item the live page also holds; with no overlap the live page moved on.
  const overlap = previous.findIndex((item) => liveIds.has(item.id));
  const kept = overlap === -1 ? previous : previous.slice(0, overlap);
  return [...kept, ...live];
}

/** An older page placed before what is shown; ids already shown are skipped. */
export function prependOlder(current: readonly ChatItem[], older: readonly ChatItem[]): ChatItem[] {
  const have = new Set(current.map((item) => item.id));
  return [...older.filter((item) => !have.has(item.id)), ...current];
}
