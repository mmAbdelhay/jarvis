// A stand-in for xterm.js, used by the renderer tests.
//
// xterm.js renders to a canvas and measures real character cells, neither of
// which jsdom provides — so the tests mock the vendored module with this and
// assert on what Jarvis does (which bytes reach the terminal, which
// keystrokes go back to the pty, which session's output is filtered out)
// rather than on xterm's own rendering, which is not ours to test.
//
// It lives beside the source rather than inside a test file because two test
// files (session-view.test.ts and app.test.ts) mock the same module and must
// agree on the double's shape.

export type FakeTerminalOptions = Record<string, unknown>;

export class FakeTerminal {
  static last: FakeTerminal | undefined;

  readonly options: FakeTerminalOptions;
  /** Every chunk written, in order — the terminal's whole input stream. */
  written: string[] = [];
  resets = 0;
  focused = 0;
  opened: unknown;
  addons: unknown[] = [];

  #dataListeners: ((data: string) => void)[] = [];
  #resizeListeners: ((size: { cols: number; rows: number }) => void)[] = [];

  constructor(options: FakeTerminalOptions = {}) {
    this.options = options;
    FakeTerminal.last = this;
  }

  /** Everything written, joined — what the screen would be showing. */
  get text(): string {
    return this.written.join("");
  }

  open(host: unknown): void {
    this.opened = host;
  }
  loadAddon(addon: unknown): void {
    this.addons.push(addon);
  }
  write(data: string): void {
    this.written.push(data);
  }
  reset(): void {
    this.resets += 1;
    this.written = [];
  }
  focus(): void {
    this.focused += 1;
  }
  dispose(): void {}

  onData(listener: (data: string) => void): void {
    this.#dataListeners.push(listener);
  }
  onResize(listener: (size: { cols: number; rows: number }) => void): void {
    this.#resizeListeners.push(listener);
  }

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
