// A page gets one ready message per native-observed load. Repeated
// messages cannot trigger more snapshot requests.
//
// Fix round 3, N-r2-4: the gate starts *disarmed* — `accept()` before any
// `arm()` is dropped like a duplicate, not accepted as "initial". Nothing
// can post a `ready` before the WebView's first native load event, but
// this closes the gap between "gate exists" and "a load was actually
// observed" exactly, at no cost.
//
// Fix round 3, N-r2-1: `arm()` (called from onLoadStart, and from a crash
// remount's own load) reports whether *this* is the very first load ever
// observed ("initial") or a later one ("reattach"). The caller uses this
// to decide whether the pre-ready attach buffer must survive to the next
// `ready` (initial — writes queued before this native event reached JS
// must not be lost) or is safe to drop (reattach — the page is reloading
// or was remounted, and the `ready` that follows is dispositioned
// "replay", which drives a full host resnapshot instead).
//
// Final review I2: `accept()`'s disposition is based on the *last* `arm()`
// kind, not on whether a `ready` was ever accepted before. A crash during
// the initial load — a second `onLoadStart`/`arm()` before any `ready` ever
// arrived — must still disposition the eventual `ready` as "replay" (so the
// caller calls onNeedsReplay() and the host resnapshots), because the page
// that answers is not the one whose in-flight writes were buffered under
// the first "initial" arm. Basing this on `everReady` instead accepted that
// `ready` as "initial", so `onNeedsReplay()` never fired and the initial
// snapshot was silently lost (the earlier terminal-ready.test.ts case named
// this "still attaches initially" — that was the bug, not the spec).
export function createTerminalReadyGate() {
  let armed = false;
  let accepted = false;
  let everLoaded = false;
  let lastArmKind: "initial" | "reattach" = "initial";
  let dropped = 0;
  return {
    arm(): "initial" | "reattach" {
      armed = true;
      accepted = false;
      const kind = everLoaded ? "reattach" : "initial";
      everLoaded = true;
      lastArmKind = kind;
      return kind;
    },
    accept(): "initial" | "replay" | "duplicate" {
      if (!armed || accepted) {
        dropped += 1;
        return "duplicate";
      }
      accepted = true;
      return lastArmKind === "reattach" ? "replay" : "initial";
    },
    dropped: () => dropped,
  };
}
