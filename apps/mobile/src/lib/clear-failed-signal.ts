// A one-shot, in-memory "the automatic unpaired handler tried to clear this
// machine's stored pairing and couldn't" signal (final review I1). Previously
// carried as a `clearFailed=1` route param on the `/pair` navigation — but Expo
// Router maps `jarvis://pair?...&clearFailed=1` to the very same route param,
// so a crafted link could forge it and bypass the "refuse while paired" check.
// The only caller is `MachineSessions.forget`, when the store could not remove
// the machine, with that machine's id. There is no path from a link — or from
// anything else — into it, forged or not. `/pair` retries that id.

import type { MachineId } from "./machine-index";

let signalled: { id: MachineId | null } | undefined;

export function setClearFailedSignal(id: MachineId | null): void {
  signalled = { id };
}

/** Reads and clears the signal in one step — consumed exactly once. */
export function takeClearFailedSignal(): { id: MachineId | null } | undefined {
  const value = signalled;
  signalled = undefined;
  return value;
}

/** Clears the signal if it names this machine: a later failure of another
 *  machine is still waiting for its own /pair. */
export function dropClearFailedSignal(id: MachineId | null): void {
  if (signalled?.id === id) signalled = undefined;
}
