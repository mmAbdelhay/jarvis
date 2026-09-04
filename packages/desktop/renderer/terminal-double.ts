// A stand-in for xterm.js, used by the renderer tests.
//
// xterm.js renders to a canvas and measures real character cells, neither of
// which jsdom provides — so the tests mock the vendored module with this and
// assert on what Jarvis does (which bytes reach the terminal, which
// keystrokes go back to the pty, which session's output is filtered out)
// rather than on xterm's own rendering, which is not ours to test.
//
// It lives beside the source rather than inside a test file because several
// test files (session-view.test.ts, app.test.ts and workspace-terminal.test.ts)
// mock the same module and must agree on the double's shape.

export type FakeTerminalOptions = Record<string, unknown>;

export class FakeTerminal {
  static last: FakeTerminal | undefined;
  /** Every terminal built, in construction order. The Workspace holds one
   *  per terminal tab, so `last` alone is not enough there. Reset with
   *  `FakeTerminal.instances = []` in a beforeEach. */
  static instances: FakeTerminal[] = [];

  readonly options: FakeTerminalOptions;
  /** Every chunk written, in order — the terminal's whole input stream,
   *  including what a later reset() wiped off the screen. A pane freezing a
   *  finished command resets the live terminal as it goes, so this is the
   *  only place a test can still see that no byte was swallowed on the way. */
  written: string[] = [];
  /** What is on the screen: everything *parsed* since the last reset(). */
  #screen: string[] = [];
  /** Written but not parsed yet — xterm's write buffer, modelled. See
   *  `write` and `flush` below for why this exists. */
  #pending: { data: string; done: (() => void) | undefined }[] = [];
  #draining = false;
  resets = 0;
  focused = 0;
  opened: unknown;
  addons: unknown[] = [];

  /** What getSelection() returns — set by a test simulating a drag. */
  selection = "";
  cleared = 0;
  /** xterm's unicode facade; the addon sets activeVersion through it. */
  unicode = { activeVersion: "6" };

  /** The handler attachCustomKeyEventHandler was given, if any. */
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;

  /** The screen, as rows of text. Set by a test to say what the shell has
   *  drawn; terminal-completion.ts reads its input line out of here rather
   *  than modelling keystrokes, so this is what it sees. */
  lines: string[] = [];
  cursor = { x: 0, y: 0 };
  baseY = 0;
  cols = 80;
  rows = 24;

  /** xterm's buffer facade, over `lines` and `cursor`. */
  get buffer(): {
    active: {
      cursorX: number;
      cursorY: number;
      baseY: number;
      getLine(y: number): { translateToString(t?: boolean, s?: number, e?: number): string } | undefined;
    };
  } {
    const lines = this.lines;
    return {
      active: {
        cursorX: this.cursor.x,
        cursorY: this.cursor.y,
        baseY: this.baseY,
        getLine: (y: number) => {
          const line = lines[y];
          if (line === undefined) return undefined;
          return {
            translateToString: (_t?: boolean, s = 0, e = line.length) => line.slice(s, e),
          };
        },
      },
    };
  }

  /** xterm's parser facade. Only the OSC registration is modelled, because
   *  that is the only part Jarvis uses. */
  readonly parser = {
    handlers: new Map<number, (data: string) => boolean | Promise<boolean>>(),
    registerOscHandler: (
      ident: number,
      callback: (data: string) => boolean | Promise<boolean>,
    ): { dispose(): void } => {
      this.parser.handlers.set(ident, callback);
      return { dispose: () => this.parser.handlers.delete(ident) };
    },
    /** Simulates the shell emitting an OSC sequence. */
    emitOsc: (ident: number, data: string): void => {
      void this.parser.handlers.get(ident)?.(data);
    },
  };

  /** Simulates the shell drawing a prompt and the user typing after it:
   *  sets the row and puts the cursor at its end. */
  typeLine(line: string, row = 0): void {
    this.lines[row] = line;
    this.cursor = { x: line.length, y: row };
  }

  #dataListeners: ((data: string) => void)[] = [];
  #resizeListeners: ((size: { cols: number; rows: number }) => void)[] = [];

  disposed = false;

  constructor(options: FakeTerminalOptions = {}) {
    this.options = options;
    FakeTerminal.last = this;
    FakeTerminal.instances.push(this);
  }

  /**
   * What the screen is showing: everything *parsed* since the last reset,
   * joined.
   *
   * Reading it drains the write buffer first — the screen a test asks about
   * is the screen once the parser has caught up, which is the only screen a
   * user ever sees. That is what keeps every existing `text` assertion
   * meaning what it always meant while the queue underneath them became
   * real.
   */
  get text(): string {
    this.flush();
    return this.#screen.join("");
  }

  /**
   * Parses everything queued, in order, running each write's callback as
   * that write is parsed.
   *
   * This is the whole point of the queue. `Terminal.write()` defers parsing
   * to a macrotask, and `reset()` neither drains nor discards what is
   * queued — so a reset called straight after a write clears the screen and
   * then lets the very bytes it was clearing paint over it, while a reset
   * ordered *behind* the queue (`write("", () => reset())`) lands after
   * them. A double that applied writes synchronously could not tell those
   * two apart, which is why this class of bug survived sixteen tasks and
   * two review passes.
   *
   * Callbacks may write again; the loop keeps going, exactly as the real
   * parser would.
   */
  flush(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      let next = this.#pending.shift();
      while (next !== undefined) {
        this.#screen.push(next.data);
        next.done?.();
        next = this.#pending.shift();
      }
    } finally {
      this.#draining = false;
    }
  }

  open(host: unknown): void {
    this.opened = host;
  }
  loadAddon(addon: unknown): void {
    this.addons.push(addon);
  }
  /**
   * xterm's `write(data, callback)`.
   *
   * The bytes are recorded in `written` synchronously — that array is "what
   * was handed to the terminal", and the tests that read it are asserting
   * that no byte was swallowed on the way, which is true the moment it is
   * handed over. Everything else is queued: the data reaches the *screen*,
   * and the callback runs, only when the buffer is parsed — on a macrotask,
   * or the moment something reads the screen, whichever comes first.
   */
  write(data: string, done?: () => void): void {
    this.written.push(data);
    this.#pending.push({ data, done });
    setTimeout(() => this.flush(), 0);
  }
  /** Clears the screen — and, exactly like the real one, neither drains nor
   *  discards the write buffer: bytes queued before this still parse after
   *  it. Ordering a reset behind them is the caller's job. */
  reset(): void {
    this.resets += 1;
    this.#screen = [];
  }
  focus(): void {
    this.focused += 1;
  }
  dispose(): void {
    this.disposed = true;
  }

  getSelection(): string {
    return this.selection;
  }
  clear(): void {
    this.cleared += 1;
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  onData(listener: (data: string) => void): void {
    this.#dataListeners.push(listener);
  }
  onResize(listener: (size: { cols: number; rows: number }) => void): void {
    this.#resizeListeners.push(listener);
  }

  /** Simulates a key reaching the emulator. Returns what the handler said:
   *  false means "handled here, do not let xterm encode it". */
  pressKey(init: {
    key: string;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
  }): boolean {
    this.defaultPrevented = false;
    const event = {
      type: "keydown",
      ...init,
      preventDefault: () => {
        this.defaultPrevented = true;
      },
    };
    return this.keyHandler?.(event as unknown as KeyboardEvent) ?? true;
  }

  /** Whether the last pressKey's handler called preventDefault. Returning
   *  false from the handler only tells xterm not to encode the key; the
   *  browser still delivers its text to the textarea unless the default is
   *  prevented, which is how Shift+Enter came to send a second carriage
   *  return after the one it meant. */
  defaultPrevented = false;

  /** Simulates the user typing. */
  emitData(data: string): void {
    for (const listener of this.#dataListeners) listener(data);
  }
  /** Simulates the emulator settling on a new cell grid. */
  emitResize(cols: number, rows: number): void {
    for (const listener of this.#resizeListeners) listener({ cols, rows });
  }
}

export class FakeFitAddon {
  fits = 0;
  fit(): void {
    this.fits += 1;
  }
  dispose(): void {}
}
