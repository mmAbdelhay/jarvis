// The bracketed-paste bytes `plans:send` (dispatch.ts) writes to a
// terminal pane for a batch of plan comments — a pure, framework-free
// counterpart to terminal-pane.ts's own `submitBytes`, which the renderer
// bundle exports for exactly the same reason: the renderer cannot
// value-import shared code (it is compiled from a separate entry point
// with no access to packages/desktop/src), so a second, identical helper
// lives here rather than terminal-pane.ts being reached into from main.
//
// Unlike `submitBytes` (which only wraps a line that already contains a
// newline), this always wraps — even a single short comment — because the
// text it wraps is never a line the user typed at a prompt; it is a
// formatted message (`formatFeedback`, @jarvis/core) that may itself
// contain no newline at all today and still deserves the same "one paste,
// one Enter" treatment a multi-line one gets, rather than a second helper
// growing a conditional to match `submitBytes` exactly.
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * Wraps `text` in a bracketed-paste sequence followed by the one carriage
 * return that submits it. Always wrapped, regardless of whether `text`
 * contains a newline — see the file comment for why this differs from
 * terminal-pane.ts's `submitBytes`.
 */
export function bracketedSubmit(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}\r`;
}
