// packages/desktop/renderer/terminal-input.ts
//
// A real DOM editor for the command line, standing in front of the shell
// instead of typing straight into the pty. Built as a <textarea> (the value,
// invisible text with a visible caret) painted over by a <div> behind it
// (the syntax highlighting) — the standard highlighted-textarea trick, and
// the only one that keeps selection, IME and Arabic input working. Never
// reach for contenteditable here.

import { hostPlatform, keyLabel } from "./keys.js";

export type EditorHooks = {
  /** Enter: the whole line, for the pane to send with a carriage return. */
  submit: (line: string) => void;
  /** A key the editor will not handle. The pane sends it to the pty. */
  passthrough: (event: KeyboardEvent) => void;
  /** ↑/↓ on an empty-history-position line. Returns the previous or next
   *  command, or undefined at the end of the list. */
  history: (delta: number) => string | undefined;
};

export type TerminalEditor = {
  element: HTMLElement;
  value(): string;
  setValue(text: string): void;
  focus(): void;
  show(prompt: string): void;
  hide(): void;
  isVisible(): boolean;
};

// Three rules and nothing more. This is not a shell parser: it exists to
// paint a command line, not to understand one, and a parser that hangs on a
// pathological heredoc costs far more than a slightly wrong highlight.
type Token = { text: string; cls: string | null };

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  // Split on runs of whitespace, keeping the whitespace itself as plain
  // tokens so the painted text lines up character-for-character with the
  // textarea underneath.
  const parts = line.split(/(\s+)/);
  let seenCommand = false;
  for (const part of parts) {
    if (part === "") continue;
    if (/^\s+$/.test(part)) {
      tokens.push({ text: part, cls: null });
      continue;
    }
    if (!seenCommand) {
      tokens.push({ text: part, cls: "tok-command" });
      seenCommand = true;
    } else if (part.startsWith("-")) {
      tokens.push({ text: part, cls: "tok-flag" });
    } else if (part.includes("/")) {
      tokens.push({ text: part, cls: "tok-path" });
    } else {
      tokens.push({ text: part, cls: null });
    }
  }
  return tokens;
}

export function createEditor(host: HTMLElement, hooks: EditorHooks): TerminalEditor {
  const wrapper = document.createElement("div");
  wrapper.className = "terminal-input";

  const promptEl = document.createElement("div");
  promptEl.className = "terminal-input-prompt";

  // The painted layer and the textarea live inside their own flex item
  // (.terminal-input-field), a sibling of the prompt rather than the
  // prompt's parent. That way the prompt's width shows up as ordinary flex
  // space taken from the row — nobody has to compute an offset and apply it
  // to both layers, so there is no way for them to apply it inconsistently
  // and drift apart.
  const field = document.createElement("div");
  field.className = "terminal-input-field";

  const paint = document.createElement("div");
  paint.className = "terminal-input-paint";
  // See the textarea below: the two layers are drawn on top of each other
  // and must agree about direction, or the colouring lands on the wrong
  // characters.
  paint.dir = "auto";

  // Text a caller's own e.element.textContent checks would otherwise pick
  // up even while [hidden] — hidden only affects rendering, not the DOM
  // tree — so the hint's text is cleared, not just hidden, once there's a
  // line to show instead.
  const HINT_TEXT = `Type a command · ${keyLabel("palette", hostPlatform())} for actions`;
  const hint = document.createElement("div");
  hint.className = "terminal-input-hint";
  hint.textContent = HINT_TEXT;

  const textarea = document.createElement("textarea");
  textarea.className = "terminal-input-text";
  textarea.spellcheck = false;
  textarea.rows = 1;
  // The line takes its direction from what is actually in it. Arabic typed
  // here ran left to right like the Latin around it, which puts a word's
  // letters on screen in the wrong order; "auto" reads the first strong
  // character and leaves an English line exactly as it was.
  //
  // This is the one place in a terminal that can do this at all: the
  // editor is Jarvis's own DOM. The grid underneath is xterm.js, which has
  // no bidirectional text support, so the shell's echo of the same line —
  // and anything a program prints — is still laid out logically.
  textarea.dir = "auto";

  field.append(paint, hint, textarea);
  wrapper.append(promptEl, field);
  host.append(wrapper);
  // Starts hidden: the pane that owns this editor decides when it appears.
  wrapper.hidden = true;

  function repaint() {
    paint.textContent = "";
    for (const tok of tokenize(textarea.value)) {
      if (tok.cls === null) {
        paint.append(document.createTextNode(tok.text));
      } else {
        const span = document.createElement("span");
        span.className = tok.cls;
        span.textContent = tok.text;
        paint.append(span);
      }
    }
    // A trailing newline collapses in a <div>'s rendering unless there's
    // something after it; keep the painted layer's wrapping matching the
    // textarea by appending a zero-width trailer when the value ends in \n.
    if (textarea.value.endsWith("\n")) paint.append(document.createTextNode(""));
    const empty = textarea.value.length === 0;
    hint.hidden = !empty;
    hint.textContent = empty ? HINT_TEXT : "";
  }

  function setCursorToEnd() {
    const end = textarea.value.length;
    textarea.selectionStart = end;
    textarea.selectionEnd = end;
  }

  function killWordBeforeCursor() {
    const pos = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, pos);
    const after = textarea.value.slice(pos);
    // Trim trailing whitespace, then the word before it.
    const trimmed = before.replace(/\s+$/, "");
    const cut = trimmed.replace(/\S+$/, "");
    textarea.value = cut + after;
    textarea.selectionStart = cut.length;
    textarea.selectionEnd = cut.length;
    repaint();
  }

  function killWholeLine() {
    textarea.value = "";
    setCursorToEnd();
    repaint();
  }

  function submitLine() {
    const line = textarea.value;
    hooks.submit(line);
    textarea.value = "";
    repaint();
  }

  function insertNewlineAtCursor() {
    const pos = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, pos);
    const after = textarea.value.slice(pos);
    textarea.value = `${before}\n${after}`;
    textarea.selectionStart = pos + 1;
    textarea.selectionEnd = pos + 1;
    repaint();
  }

  function moveCursorToLineStart() {
    const pos = textarea.selectionStart ?? 0;
    const lineStart = textarea.value.lastIndexOf("\n", pos - 1) + 1;
    textarea.selectionStart = lineStart;
    textarea.selectionEnd = lineStart;
  }

  function lineEndFrom(pos: number): number {
    const lineEnd = textarea.value.indexOf("\n", pos);
    return lineEnd === -1 ? textarea.value.length : lineEnd;
  }

  function moveCursorToLineEnd() {
    const lineEnd = lineEndFrom(textarea.selectionStart ?? textarea.value.length);
    textarea.selectionStart = lineEnd;
    textarea.selectionEnd = lineEnd;
  }

  function killToLineEnd() {
    const pos = textarea.selectionStart ?? textarea.value.length;
    const lineEnd = lineEndFrom(pos);
    textarea.value = textarea.value.slice(0, pos) + textarea.value.slice(lineEnd);
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    repaint();
  }

  function historyStep(delta: number) {
    const result = hooks.history(delta);
    if (result === undefined) return;
    textarea.value = result;
    setCursorToEnd();
    repaint();
  }

  function onKeyDown(event: KeyboardEvent) {
    try {
      // Enter / Shift+Enter.
      if (event.key === "Enter") {
        if (event.shiftKey) {
          event.preventDefault();
          insertNewlineAtCursor();
        } else {
          event.preventDefault();
          submitLine();
        }
        return;
      }

      // readline's own editing chords, which the line editor reimplements
      // because the shell's is not the one receiving these keystrokes.
      //
      // !shiftKey is not decoration. On Linux the app's chords are Ctrl+Shift
      // (see keys.ts), and Ctrl+Shift+W is "close this pane" — without this
      // guard it would kill a word on its way there, and Ctrl+Shift+K would
      // truncate the line before clearing the screen.
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        switch (event.key.toLowerCase()) {
          case "w":
            event.preventDefault();
            killWordBeforeCursor();
            return;
          case "u":
            event.preventDefault();
            killWholeLine();
            return;
          case "a":
            event.preventDefault();
            moveCursorToLineStart();
            return;
          case "e":
            event.preventDefault();
            moveCursorToLineEnd();
            return;
          case "k":
            event.preventDefault();
            killToLineEnd();
            return;
          default:
            // Every other Ctrl chord — ^C, ^D above all — is not ours to
            // eat: it is how a user interrupts a command or exits a shell.
            hooks.passthrough(event);
            return;
        }
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        historyStep(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        historyStep(1);
        return;
      }
    } catch {
      // A failure in this widget must never take the terminal down with it.
    }
  }

  wrapper.addEventListener("keydown", onKeyDown);
  textarea.addEventListener("input", repaint);

  // Nothing this widget does may throw into the terminal it sits in front
  // of — it is an enhancement, and a bug here must leave a usable terminal
  // behind. Every public method below runs through this guard.
  function guard(fn: () => void) {
    try {
      fn();
    } catch {
      // Swallowed deliberately: see the comment above.
    }
  }

  return {
    element: wrapper,
    value: () => textarea.value,
    setValue(text: string) {
      guard(() => {
        textarea.value = text;
        setCursorToEnd();
        repaint();
      });
    },
    focus() {
      guard(() => textarea.focus());
    },
    show(prompt: string) {
      guard(() => {
        // A prompt is user-configured text arriving from the shell —
        // untrusted exactly like a command line — so it goes in via
        // textContent, never markup. An empty prompt clears the element
        // rather than leaving whatever a previous show() rendered.
        promptEl.textContent = prompt;
        wrapper.hidden = false;
      });
    },
    hide() {
      guard(() => {
        wrapper.hidden = true;
        promptEl.textContent = "";
      });
    },
    isVisible() {
      return !wrapper.hidden;
    },
  };
}
