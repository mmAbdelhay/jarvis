// "Waiting for you" heuristic (M10, ruling 8): a pure marker check over a
// session's ANSI-stripped output tail. It does not touch `Session.state`
// — `SessionManager` is untouched — and `notify.ts` (desktop) is its only
// consumer. A false positive costs one coalesced push; a false negative
// costs a missed one, so the marker list is the one thing worth tuning
// later without touching this function's shape.
//
// This file imports nothing (plan, "Interfaces").

export const PROMPT_TAIL_CHARS = 2_048;

// The initial marker list (ruling 8). Case-insensitive substring match
// against the tail's last 20 non-empty lines.
export const PROMPT_MARKERS: readonly string[] = [
  "Do you want to",
  "❯ 1. Yes",
  "esc to cancel",
  "(y/n)",
  "[Y/n]",
  "[y/N]",
  "Enter to confirm",
  "Allow once",
  "Press Enter to continue",
];

const LOWER_PROMPT_MARKERS = PROMPT_MARKERS.map((marker) => marker.toLowerCase());

// CSI: ESC "[" then parameter bytes (0x30-0x3F), intermediate bytes
// (0x20-0x2F), then one final byte (0x40-0x7E) — ECMA-48.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC literally is the point — stripping it is what this pattern is for.
const CSI_PATTERN = /\x1b\[[0-9:;<=>?]*[ !"#$%&'()*+,\-./]*[@-~]/g;
// OSC: ESC "]" up to a BEL terminator or an ESC "\" (ST) terminator. The
// body excludes ESC and BEL themselves, so a failed match stops at the next
// escape instead of scanning to the end of the string, and an unterminated
// "ESC ]" can never swallow past the *next* OSC's own terminator.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC and BEL literally is the point — stripping them is what this pattern is for.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Single-character escapes: ESC followed by exactly one of these bytes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC literally is the point — stripping it is what this pattern is for.
const SINGLE_CHAR_ESCAPE_PATTERN = /\x1b[()#=><78cDEHM]/g;

/**
 * Strips CSI sequences, OSC sequences, single-character escapes and any
 * stray `ESC` from `text`, and drops `\r`. Never throws — a lone `ESC`
 * with no following bytes, or any other malformed sequence, is simply
 * removed rather than causing a match failure.
 */
export function stripAnsi(text: string): string {
  return (
    text
      .replace(OSC_PATTERN, "")
      .replace(CSI_PATTERN, "")
      .replace(SINGLE_CHAR_ESCAPE_PATTERN, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a stray ESC literally is the point — stripping it is what this pattern is for.
      .replace(/\x1b/g, "")
      .replace(/\r/g, "")
  );
}

/**
 * True iff a session's output tail looks like it's sitting at an
 * interactive prompt: take the last {@link PROMPT_TAIL_CHARS} characters
 * of `tail`, {@link stripAnsi} them, split into lines, keep the last 20
 * non-empty (after trim) lines, and answer true iff any of them contains
 * any {@link PROMPT_MARKERS} entry, compared case-insensitively. An empty
 * `tail` is false.
 */
export function looksLikePrompt(tail: string): boolean {
  const scanned = tail.length > PROMPT_TAIL_CHARS ? tail.slice(-PROMPT_TAIL_CHARS) : tail;
  const stripped = stripAnsi(scanned);
  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-20);

  return lines.some((line) => {
    const lowerLine = line.toLowerCase();
    return LOWER_PROMPT_MARKERS.some((marker) => lowerLine.includes(marker));
  });
}
