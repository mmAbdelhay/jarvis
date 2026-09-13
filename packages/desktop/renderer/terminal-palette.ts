// The command palette: ⌘P over the focused pane, and the same widget under
// `^R`'s history search.
//
// It is `terminal-completion.ts`'s dropdown with a text field on top —
// filtering, ↑/↓ with wrapping, textContent-only rendering, and the rule
// that keys are claimed only while it is open. That last rule is the
// reason `handleKey` exists here rather than a plain keydown listener: a
// closed palette must hand every key straight back, exactly as the
// dropdown does, or the terminal stops feeling like a terminal the moment
// this module is loaded.
//
// Two shapes share the one widget. `open` hands it actions to run; `ask`
// hands it plain strings and resolves to whichever one was chosen (or
// undefined on Escape) — what history search, and later a workflow's
// placeholders, are built from. Both are "an item was picked"; only what
// picking one *does* differs, so both go through the same `entries` list
// internally, each entry already carrying its own `run`.

export type PaletteAction = { id: string; label: string; run: () => void | Promise<void> };

export type Palette = {
  /** Opens over a list of actions. Enter runs the selected one's `run`
   *  exactly once and closes; Escape closes and runs nothing. */
  open(actions: readonly PaletteAction[], placeholder?: string): void;
  /** Opens over a list of strings and resolves to the chosen one, or
   *  undefined if the palette closed without a choice. Used for history
   *  search and for a workflow's placeholders. */
  ask(items: readonly string[], placeholder: string): Promise<string | undefined>;
  close(): void;
  isOpen(): boolean;
  /** Run before the terminal's or the editor's own key handling, the same
   *  contract terminal-completion.ts's Completion follows: false means the
   *  key was claimed, true lets it through. Closed, every key comes back
   *  true — the palette has nothing to say about a key it never opened
   *  for. */
  handleKey(event: KeyboardEvent): boolean;
};

/** One row's worth of what the palette needs: what to show, and what
 *  choosing it does. `open`'s actions and `ask`'s strings both become one
 *  of these, so the rest of the widget — filtering, selection, Enter —
 *  never has to know which mode built the list it is showing. */
type Entry = { label: string; run: () => void };

/**
 * The palette widget, built as nodes and appended to the terminal's own
 * host so it travels with the pane it belongs to.
 *
 * Every entry's label goes in through `textContent`, never `innerHTML` —
 * a history line is untrusted text, exactly as shell history is for the
 * completion dropdown, and a palette that parsed it as markup would be
 * executing it.
 */
export function createPalette(host: HTMLElement): Palette {
  const element = document.createElement("div");
  element.className = "terminal-palette";
  element.hidden = true;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "terminal-palette-input mono";
  input.spellcheck = false;
  input.autocomplete = "off";

  const list = document.createElement("div");
  list.className = "terminal-palette-list";

  element.append(input, list);
  host.append(element);

  /** Every entry the palette is currently open over, unfiltered. */
  let entries: Entry[] = [];
  /** What the filter query currently matches, in `entries` order. */
  let filtered: Entry[] = [];
  let index = 0;
  /** The pending `ask()` call's resolver, or undefined when the palette is
   *  in `open()` mode (or closed). Exactly one may be pending at a time —
   *  a second call finishes the first with undefined before starting. */
  let resolveAsk: ((value: string | undefined) => void) | undefined;
  /** Set only by `ask([], …)` — an empty item list, meaning there is
   *  nothing to choose from and Enter should resolve to whatever is typed
   *  instead of requiring a filtered match. What a workflow's placeholder
   *  prompts are built from. */
  let freeText = false;

  function paint(): void {
    list.replaceChildren();
    filtered.forEach((entry, position) => {
      const row = document.createElement("div");
      row.className =
        position === index ? "terminal-palette-item selected" : "terminal-palette-item";
      // textContent, deliberately. See the note above.
      row.textContent = entry.label;
      list.append(row);
    });
  }

  function applyFilter(): void {
    const needle = input.value.trim().toLowerCase();
    filtered =
      needle === "" ? entries : entries.filter((e) => e.label.toLowerCase().includes(needle));
    index = 0;
    paint();
  }

  /** Resolves whatever `ask()` is waiting on, at most once. A second call
   *  — from `close()` running after Enter already resolved it — finds
   *  nothing left to resolve and does nothing. */
  function finishAsk(value: string | undefined): void {
    const resolve = resolveAsk;
    resolveAsk = undefined;
    resolve?.(value);
  }

  function reset(placeholder: string | undefined): void {
    input.value = "";
    input.placeholder = placeholder ?? "";
  }

  function show(): void {
    element.hidden = false;
    applyFilter();
    input.focus();
  }

  function closePalette(): void {
    element.hidden = true;
    entries = [];
    filtered = [];
    index = 0;
    freeText = false;
    list.replaceChildren();
    // Escape, or any other path out: a choice that was never made resolves
    // to undefined rather than leaving `ask()`'s caller waiting forever.
    finishAsk(undefined);
  }

  function move(delta: number): void {
    if (filtered.length === 0) return;
    index = (index + delta + filtered.length) % filtered.length;
    paint();
  }

  /** Runs the selected entry exactly once, then closes. In free-text mode
   *  there is no entry to select — Enter resolves to the input's own
   *  value instead, even when it is "". An empty filtered list otherwise
   *  has nothing to run — the key is still claimed, but the palette stays
   *  open rather than closing on a choice that was never made. */
  function chooseSelected(): void {
    if (freeText) {
      finishAsk(input.value);
      closePalette();
      return;
    }
    const entry = filtered[index];
    if (entry === undefined) return;
    entry.run();
    closePalette();
  }

  input.addEventListener("input", applyFilter);

  return {
    open(actions, placeholder) {
      finishAsk(undefined);
      freeText = false;
      entries = actions.map((action) => ({ label: action.label, run: action.run }));
      reset(placeholder);
      show();
    },

    ask(items, placeholder) {
      finishAsk(undefined);
      freeText = items.length === 0;
      return new Promise<string | undefined>((resolve) => {
        resolveAsk = resolve;
        entries = items.map((item) => ({ label: item, run: () => finishAsk(item) }));
        reset(placeholder);
        show();
      });
    },

    close: closePalette,

    isOpen: () => !element.hidden,

    handleKey(event) {
      if (event.type !== "keydown") return true;
      // Closed: the palette has nothing to say about this key. This is the
      // line that keeps every other key behaving exactly as it does today.
      if (element.hidden) return true;

      if (event.key === "Escape") {
        closePalette();
        event.preventDefault();
        return false;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        move(event.key === "ArrowDown" ? 1 : -1);
        event.preventDefault();
        return false;
      }

      if (event.key === "Enter") {
        chooseSelected();
        event.preventDefault();
        return false;
      }

      // Everything else — the characters that filter the list — is the
      // input field's own default action: typing into it fires the
      // "input" listener above, which is what actually filters.
      return true;
    },
  };
}
