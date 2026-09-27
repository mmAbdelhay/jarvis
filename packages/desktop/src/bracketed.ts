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

// Every C0 control byte except tab (\u0009) and newline (\u000a), plus
// every C1 control byte (\u0080-\u009f). \u000d (CR) is covered by this
// range too, but is never actually matched — sanitizeForPaste normalises
// it to \n first — kept in the range anyway as a defence against a future
// caller of this regex that skips that normalisation step.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC and every other control byte literally is the point — stripping them is what this pattern is for.
const CONTROL_BYTES = /[\u0000-\u0008\u000b-\u001f\u0080-\u009f]/g;

/**
 * Strips every control byte that could terminate — or otherwise interfere
 * with — a bracketed paste, and normalises line endings to `\n` first.
 *
 * `formatFeedback` (@jarvis/core) embeds plan block text, a user-typed
 * comment body/quote, and the plan's own file path verbatim into the
 * string `bracketedSubmit` wraps. All three can originate from a plan
 * file on disk, which this process does not otherwise trust as terminal
 * input — a plan containing a literal `\u001b[201~` byte sequence would,
 * unsanitized, end the bracketed paste early and have everything after it
 * typed live into the shell (and from there, the agent) as if the user
 * had typed it themselves. Stripping the bare ESC byte (`\u001b`, within
 * the C0 range below) is what defeats this: the rest of an embedded
 * `[201~...` sequence survives as inert printable text with no escape
 * introducer, never a control sequence a terminal would act on.
 */
function sanitizeForPaste(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.replace(CONTROL_BYTES, "");
}

/**
 * Wraps `text` in a bracketed-paste sequence followed by the one carriage
 * return that submits it, after sanitizing it (see `sanitizeForPaste`).
 * Always wrapped, regardless of whether `text` contains a newline — see
 * the file comment for why this differs from terminal-pane.ts's
 * `submitBytes`.
 */
export function bracketedSubmit(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizeForPaste(text)}${BRACKETED_PASTE_END}\r`;
}
