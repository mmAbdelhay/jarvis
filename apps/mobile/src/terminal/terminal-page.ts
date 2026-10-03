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
  /** Getting around the scrollback: the viewport's position, a line's
   *  text and scrolling to it. Optional so a host without it (or a test
   *  that does not need it) still gets everything else. */
  nav?: PageNav;
};

/** The parts of xterm's buffer the controller moves through. Lines are
 *  absolute buffer rows, as xterm counts them. */
export type PageNav = {
  viewportY(): number;
  baseY(): number;
  lineCount(): number;
  lineText(row: number): string;
  scrollToLine(row: number): void;
  scrollToBottom(): void;
  select(column: number, row: number, length: number): void;
};

/** Where a command's prompt was drawn, as xterm tracks it through
 *  scrollback trimming (an `IMarker`). */
export type CommandMark = { readonly line: number; readonly isDisposed: boolean };

/** The longest search the page accepts; longer is refused, not cut. */
const MAX_FIND_CHARS = 200;

// A fixed size's font range. 11px is the smallest that stays readable on a
// phone; a pty wider than that fits overflows and pans sideways instead.
const MIN_FIXED_FONT_PX = 11;
const MAX_FIXED_FONT_PX = 14;

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
  /** A shell prompt began here (OSC 133;A from the laptop's shell
   *  integration): one stop for "previous / next command". */
  commandMark(mark: CommandMark): void;
  /** The viewport moved or the buffer grew: re-reports the view state. */
  viewChanged(): void;
  /** Bug 8: the font for a fixed `cols`-wide size in `width` px — the
   *  largest in [11,14]px whose columns fit, else 11px and overflowing.
   *  `charWidthAt` measures one cell at a font size. */
  fixedFont(
    cols: number,
    width: number,
    charWidthAt: (size: number) => number,
  ): { size: number; overflowing: boolean };
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
  const marks: CommandMark[] = [];
  let lastView = "";
  // Where the last find matched, so the next one continues past it.
  let findRow: number | undefined;
  let findQuery = "";

  function liveMarkLines(): number[] {
    const lines: number[] = [];
    for (let i = marks.length - 1; i >= 0; i--) {
      const mark = marks[i];
      if (mark === undefined || mark.isDisposed || mark.line < 0) marks.splice(i, 1);
      else lines.unshift(mark.line);
    }
    return lines.sort((a, b) => a - b);
  }

  /**
   * Whether the viewport is scrolled back from the newest line, and
   * whether any command stops exist — the only things the page tells
   * native about where it is. Both are geometry and one bit of "the shell
   * marked its prompts", never any of the text itself.
   */
  function viewChanged(): void {
    const nav = deps.nav;
    if (nav === undefined) return;
    const view = JSON.stringify({
      t: "view",
      back: nav.viewportY() < nav.baseY(),
      commands: liveMarkLines().length > 0,
    });
    if (view === lastView) return;
    lastView = view;
    deps.post(view);
  }

  function jump(to: unknown): void {
    const nav = deps.nav;
    if (nav === undefined) return;
    if (to === "latest") {
      nav.scrollToBottom();
    } else if (to === "prevCommand" || to === "nextCommand") {
      const top = nav.viewportY();
      const lines = liveMarkLines();
      const target =
        to === "prevCommand"
          ? lines.filter((line) => line < top).at(-1)
          : lines.find((line) => line > top);
      if (target === undefined) {
        // Past the newest prompt there is only the live end left.
        if (to === "nextCommand") nav.scrollToBottom();
      } else {
        nav.scrollToLine(Math.min(target, nav.baseY()));
      }
    }
    viewChanged();
  }

  /**
   * The next line (in `direction`) holding `query`, ignoring case, from
   * just past the last match — or from the viewport, for a new query. The
   * match is selected and scrolled into view; native hears only whether
   * there was one.
   */
  function find(query: unknown, direction: unknown): void {
    const nav = deps.nav;
    if (nav === undefined) return;
    if (typeof query !== "string" || query === "" || query.length > MAX_FIND_CHARS) return;
    if (direction !== "next" && direction !== "prev") return;
    const needle = query.toLocaleLowerCase();
    const count = nav.lineCount();
    if (query !== findQuery || findRow === undefined) {
      findQuery = query;
      findRow = direction === "prev" ? nav.viewportY() + deps.term.rows : nav.viewportY() - 1;
    }
    const step = direction === "next" ? 1 : -1;
    for (let scanned = 0, row = findRow + step; scanned < count; scanned++, row += step) {
      const wrapped = ((row % count) + count) % count;
      const column = nav.lineText(wrapped).toLocaleLowerCase().indexOf(needle);
      if (column === -1) continue;
      findRow = wrapped;
      nav.select(column, wrapped, query.length);
      nav.scrollToLine(
        Math.max(0, Math.min(nav.baseY(), wrapped - Math.floor(deps.term.rows / 2))),
      );
      deps.post(JSON.stringify({ t: "found", ok: true }));
      viewChanged();
      return;
    }
    deps.post(JSON.stringify({ t: "found", ok: false }));
  }

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
        viewChanged();
      });
      return;
    }
    if (obj.t === "reset") {
      deps.term.reset();
      postModesIfChanged();
      return;
    }
    if (obj.t === "jump") {
      jump((parsed as { to?: unknown }).to);
      return;
    }
    if (obj.t === "find") {
      const message = parsed as { query?: unknown; direction?: unknown };
      find(message.query, message.direction);
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
    // Fit toggle: native is driving the pty's size from this page's own
    // fit now, so it goes back to fitting until the next `size`.
    if (obj.t === "free") {
      fixedSize = undefined;
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

  function commandMark(mark: CommandMark): void {
    marks.push(mark);
    viewChanged();
  }

  function fixedFont(
    cols: number,
    width: number,
    charWidthAt: (size: number) => number,
  ): { size: number; overflowing: boolean } {
    for (let size = MAX_FIXED_FONT_PX; size > MIN_FIXED_FONT_PX; size--) {
      if (charWidthAt(size) * cols <= width) return { size, overflowing: false };
    }
    return {
      size: MIN_FIXED_FONT_PX,
      overflowing: charWidthAt(MIN_FIXED_FONT_PX) * cols > width,
    };
  }

  return {
    fixedFont,
    receive,
    start,
    layoutChanged,
    touchStart,
    touchMove,
    touchEnd,
    selectionChanged,
    commandMark,
    viewChanged,
  };
}
