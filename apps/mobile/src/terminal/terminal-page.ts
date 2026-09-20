// Runs *inside* the terminal WebView page, not in the app bundle — see
// task-6-brief.md rule 2. No imports: `scripts/build-terminal-html.mjs`
// strips this file's types with Node's `stripTypeScriptTypes` and inlines
// the plain-JS function body directly into the generated HTML's single
// inline script element. Erasable TS only (types and a function; no enums,
// no namespaces, no decorators) — anything else would survive stripping as
// runtime code the builder never asked for.
//
// This is the only place that touches the real xterm instance. It never
// posts anything derived from the bytes it writes — only `ready`, `resize`
// and `modes` — so a page compromised by attacker-controlled terminal
// output still can't say anything back except its own size and mode bits
// (global-constraints.md, "the WebView never produces pty bytes").

export type PageTerminal = {
  write(data: string, done: () => void): void;
  reset(): void;
  readonly cols: number;
  readonly rows: number;
  readonly modes: { readonly applicationCursorKeysMode: boolean };
};

export type PageDeps = {
  term: PageTerminal;
  fit(): void;
  post(text: string): void;
};

export function createPageController(deps: PageDeps): {
  receive(raw: unknown): void;
  start(): void;
  layoutChanged(): void;
} {
  let lastCols = -1;
  let lastRows = -1;
  let lastApplicationCursor = deps.term.modes.applicationCursorKeysMode;

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
    deps.fit();
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
    const obj = parsed as { t?: unknown; data?: unknown };
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
    if (obj.t === "fit") {
      layoutChanged();
      return;
    }
  }

  return { receive, start, layoutChanged };
}
