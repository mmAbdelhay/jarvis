// A tiny FIFO run-queue. Used to serialise config writes (Settings save,
// and anything else that reads-then-writes jarvis.yaml) so two overlapping
// saves can never interleave: each call's read, write and any follow-up
// (like re-reading the file to apply it to the live remote bridge) happens
// only after the previous call's has fully finished.
export function serialize<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const run = tail.then(() => fn(...args));
    // Swallow so one rejected call does not poison the chain for callers
    // queued behind it — each caller still gets its own call's outcome via
    // the returned `run` promise.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
