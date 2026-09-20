import type { Session } from "@jarvis/core";

/**
 * Which session, if any, should have its transcript opened automatically
 * after a `sessions:update` push.
 *
 * Starting a session is an explicit request to watch it work, so a newly
 * started one opens itself — but only a session the user actually started.
 * Two things must never auto-open:
 *
 *  - The first update after launch, whatever it contains. Sessions live in
 *    memory for one app run, but since sessions:refresh + process discovery
 *    and the transcript backfill, that first push already carries rows the
 *    user did not just start — auto-opening the newest of them is the bug
 *    ("the app lands on the Session view, not the Dashboard") this guards
 *    against.
 *  - A row with `origin: "external"`: found by the process scan, not
 *    started by the user through Jarvis, so it was discovered rather than
 *    started.
 */
export function sessionToAutoOpen(
  previous: Session[],
  next: Session[],
  firstUpdate: boolean,
): Session | undefined {
  if (firstUpdate) return undefined;
  const known = new Set(previous.map((session) => session.id));
  const started = next.filter((session) => !known.has(session.id) && session.origin !== "external");
  if (started.length === 0) return undefined;
  // Newest first, so starting several at once lands on the last one.
  return [...started].sort((a, b) => b.startedAt - a.startedAt)[0];
}
