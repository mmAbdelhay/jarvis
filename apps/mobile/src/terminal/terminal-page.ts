// Runs *inside* the terminal WebView page, not in the app bundle — see
// task-6-brief.md rule 2. No imports: `scripts/build-terminal-html.mjs`
// strips this file's types with Node's `stripTypeScriptTypes` and inlines
// the plain-JS function body directly into the generated HTML's single
// inline script element. Erasable TS only (types and a function; no enums,
// no namespaces, no decorators) — anything else would survive stripping as
// runtime code the builder never asked for.
//
// This is the only place that touches the real xterm instance. It never
// posts anything derived from the bytes it writes — only `ready`, `resize`,
// `modes` and (bug 9) `wheel`, which carries only a synthesized scroll
// direction, never anything read from the terminal's own content — so a
// page compromised by attacker-controlled terminal output still can't say
// anything back except its own size, mode bits and touch gestures
// (global-constraints.md, "the WebView never produces pty bytes").
//
// Wide layout (Task 4 fix round 1): the one exception is `selection`, the
// text the user has selected with the mouse, posted only by the browser
// build (the boot code wires it only without a ReactNativeWebView bridge).
// The app only ever writes it to the clipboard on the user's own copy
// chord; it never reaches the pty or any RPC.

export type MouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

export type PageTerminal = {
  write(data: string, done: () => void): void;
  reset(): void;
  readonly cols: number;
  readonly rows: number;
  readonly modes: {
    readonly applicationCursorKeysMode: boolean;
    // Bug 9: "none" means no program has turned mouse reporting on — a
    // touch drag in the alternate screen buffer then does nothing rather
    // than emitting wheel events a reporting-unaware program (or one that
    // never asked for them) would misinterpret as real input.
    readonly mouseTrackingMode: MouseTrackingMode;
  };
  // Bug 9: which screen xterm is currently rendering — a full-screen
  // program (vim, htop, …) swaps to "alternate", which owns scrolling
  // itself once it has turned mouse tracking on. Named/shaped exactly like
  // the real `Terminal.buffer.active.type` (not a flattened field) so the
  // boot code can pass the real xterm instance straight through as `term`
  // with no adapter object in between.
  readonly buffer: { readonly active: { readonly type: "normal" | "alternate" } };
  /** Scrolls the *normal* buffer's viewport — positive scrolls down
   *  (toward the newest line), negative scrolls up (toward scrollback),
   *  matching xterm's own `Terminal.scrollLines`. */
  scrollLines(amount: number): void;
  /** The mouse selection's text ("" for none), as xterm's own. */
  getSelection(): string;
  clearSelection(): void;
};

// terminal-protocol.ts's MAX_SELECTION_CHARS: a longer selection is
// posted cut to this length (this file cannot import it).
const MAX_SELECTION_CHARS = 100000;

export type PageDeps = {
  term: PageTerminal;
  fit(): void;
  post(text: string): void;
  /** Bug 8: called instead of `fit()` once a fixed size has arrived from
   *  native (a `{t:"size"}` message) — resizes the terminal to exactly
   *  `cols` x `rows`, picking whatever font size (and possible horizontal
   *  pan) that size needs to render legibly at the WebView's current
   *  width. Every later re-layout (a rotation, `{t:"fit"}`) reapplies the
   *  same fixed size instead of falling back to `fit()`'s own auto-sizing,
   *  until a *different* `{t:"size"}` message arrives. */
  applyFixedSize(cols: number, rows: number): void;
  /** Bug 9: the pixel height of one terminal row right now — used to turn
   *  an accumulated touch-drag distance (device px) into whole
   *  `scrollLines()`/wheel steps, one per line-height of drag. */
  lineHeightPx(): number;
};

export function createPageController(deps: PageDeps): {
  receive(raw: unknown): void;
  start(): void;
  layoutChanged(): void;
  // Bug 9: driven by the WebView's own touchstart/touchmove/touchend —
  // `dy` is this move's delta in device px (current Y minus previous Y),
  // not a running total; the controller accumulates it itself so a caller
  // never has to track a remainder between calls.
  touchStart(): void;
  touchMove(dy: number): void;
  touchEnd(): void;
  // Wired to xterm's onSelectionChange in the browser build only.
  selectionChanged(): void;
} {
  let lastCols = -1;
  let lastRows = -1;
  let lastApplicationCursor = deps.term.modes.applicationCursorKeysMode;
  // Bug 8: set once native has ever reported the pty's real size; from then
  // on every re-layout reapplies it instead of calling fit().
  let fixedSize: { cols: number; rows: number } | undefined;
  // Bug 9: the running, not-yet-consumed touch-drag distance (device px)
  // since the last touchStart/whole line-height step.
  let touchAccumulator = 0;
  let lastSelection = "";

  function postModesIfChanged(): void {
    const current = deps.term.modes.applicationCursorKeysMode;
    if (current !== lastApplicationCursor) {
      lastApplicationCursor = current;
      deps.post(JSON.stringify({ t: "modes", applicationCursor: current }));
    }
  }

  function postSizeIfChanged(): void {
    const cols = deps.term.cols;
    const rows = deps.term.rows;
    if (cols !== lastCols || rows !== lastRows) {
      lastCols = cols;
      lastRows = rows;
      deps.post(JSON.stringify({ t: "resize", cols, rows }));
    }
  }

  function start(): void {
    deps.fit();
    lastCols = deps.term.cols;
    lastRows = deps.term.rows;
    lastApplicationCursor = deps.term.modes.applicationCursorKeysMode;
    deps.post(JSON.stringify({ t: "ready", cols: lastCols, rows: lastRows }));
    deps.post(JSON.stringify({ t: "modes", applicationCursor: lastApplicationCursor }));
  }

  function layoutChanged(): void {
    if (fixedSize !== undefined) {
      deps.applyFixedSize(fixedSize.cols, fixedSize.rows);
    } else {
      deps.fit();
    }
    postSizeIfChanged();
  }

  function receive(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return;
    }
    const obj = parsed as { t?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    if (obj.t === "write") {
      if (typeof obj.data !== "string") {
        return;
      }
      const data = obj.data;
      deps.term.write(data, () => {
        postModesIfChanged();
      });
      return;
    }
    if (obj.t === "reset") {
      deps.term.reset();
      postModesIfChanged();
      return;
    }
    if (obj.t === "clearSelection") {
      deps.term.clearSelection();
      return;
    }
    if (obj.t === "fit") {
      layoutChanged();
      return;
    }
    if (obj.t === "size") {
      if (typeof obj.cols !== "number" || typeof obj.rows !== "number") {
        return;
      }
      fixedSize = { cols: obj.cols, rows: obj.rows };
      layoutChanged();
      return;
    }
  }

  // Bug 9: xterm 6's viewport is wheel-only — no native touch scrolling —
  // so a vertical drag is turned into scrollLines() (normal buffer) or a
  // synthesized wheel event (alternate buffer, only when some program has
  // turned mouse tracking on) right here, one whole line-height at a time.
  function touchStart(): void {
    touchAccumulator = 0;
  }

  function touchMove(dy: number): void {
    const mouseTrackingOn = deps.term.modes.mouseTrackingMode !== "none";
    const bufferType = deps.term.buffer.active.type;
    if (bufferType === "alternate" && !mouseTrackingOn) {
      // Nothing owns this gesture: no native scrolling to fall back to,
      // and no tracking program to send it to either. Dropped, not
      // buffered, so a later toggle mid-drag doesn't unleash a backlog.
      touchAccumulator = 0;
      return;
    }
    const lineHeight = deps.lineHeightPx();
    if (lineHeight <= 0) return;
    // Content follows the finger: dragging up (dy < 0) reveals newer
    // lines (scroll down, positive); dragging down reveals scrollback
    // (scroll up, negative) — see scrollLines' own doc above.
    touchAccumulator -= dy;
    while (Math.abs(touchAccumulator) >= lineHeight) {
      const amount = touchAccumulator > 0 ? 1 : -1;
      touchAccumulator -= amount * lineHeight;
      if (bufferType === "alternate") {
        deps.post(JSON.stringify({ t: "wheel", direction: amount > 0 ? "down" : "up" }));
      } else {
        deps.term.scrollLines(amount);
      }
    }
  }

  function touchEnd(): void {
    touchAccumulator = 0;
  }

  function selectionChanged(): void {
    const text = deps.term.getSelection().slice(0, MAX_SELECTION_CHARS);
    if (text === lastSelection) return;
    lastSelection = text;
    deps.post(JSON.stringify({ t: "selection", text }));
  }

  return { receive, start, layoutChanged, touchStart, touchMove, touchEnd, selectionChanged };
}
