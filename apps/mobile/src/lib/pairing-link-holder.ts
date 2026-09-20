// A tiny, module-scope one-shot holder for an incoming `jarvis://pair?...`
// deep link's raw URL string (final review I1/I2). `app/+native-intent.tsx`
// stashes a link here — via `native-intent.ts` — instead of letting Expo
// Router parse it into the `/pair` route's params, where it would sit in
// React Navigation state (visible to navigation devtools, state
// persistence, `useGlobalSearchParams`) for as long as that screen
// instance is mounted, carrying the pairing secret. `app/pair.tsx` reads
// the link from here instead.
//
// One-shot, process-wide, forever: `takePairingLink()` clears the slot the
// moment it is read, and nothing ever repopulates it except a fresh
// `stashPairingLink()` call from a new incoming link. This is what closes
// T5 r2 Minor 1 — before this holder existed, `Linking.getInitialURL()`
// kept returning the *same* cold-start URL on every call, so a phone that
// unpaired and returned to `/pair` could see its old deep link "resurface"
// and start pairing again on its own. A value taken once is gone; only a
// genuinely new deep link can produce another one.
let held: string | null = null;
const listeners = new Set<() => void>();

export function stashPairingLink(url: string): void {
  held = url;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Reads and clears the held link in one step — consumed exactly once. */
export function takePairingLink(): string | null {
  const link = held;
  held = null;
  return link;
}

/** Notified every time a new link is stashed (not on every `take`). */
export function subscribePairingLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
