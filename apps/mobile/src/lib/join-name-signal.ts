// A one-shot, in-memory "open /pair's join form with this name" signal, set by
// the machine switcher's found row. Not a route param, which a crafted
// `jarvis://pair?...` link could set (clear-failed-signal.ts's reasoning): only
// a tap in the app fills the name. The person still types the password.

let signalled: string | undefined;

export function setJoinNameSignal(text: string): void {
  signalled = text;
}

/** Reads and clears the signal in one step. */
export function takeJoinNameSignal(): string | undefined {
  const value = signalled;
  signalled = undefined;
  return value;
}

/** /pair's step after reading the machines: the join form when a name came
 *  with the visit, and a failed read fails closed either way. */
export function phaseAfterReadForJoin(
  read: "scan" | "checkFailed",
  joinText: string | undefined,
): "scan" | "join" | "checkFailed" {
  return read === "scan" && joinText !== undefined ? "join" : read;
}

/** Opens /pair for a found machine. The name is set inside the navigate
 *  action, so a navigation the gate drops never leaves a stale name behind
 *  for the next unrelated /pair visit. */
export function openJoinWithName(
  gate: { navigate(action: () => void, onDropped?: () => void): void },
  text: string,
  push: () => void,
): void {
  gate.navigate(
    () => {
      setJoinNameSignal(text);
      push();
    },
    () => {
      takeJoinNameSignal();
    },
  );
}
