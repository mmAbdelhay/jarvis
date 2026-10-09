// Everything the CLI prints that came from outside (model text, tool names and
// summaries, card titles and details, provider errors, memory text) passes
// through here first. A terminal obeys escape sequences, so untrusted text could
// otherwise set the window title, erase and rewrite the line a card was drawn
// on (ESC[2K + CR), or reverse text with bidi controls. That would make an
// approval card say something other than what it approves.
const ESCAPES = new RegExp(
  [
    "\\u001b\\[[0-?]*[ -/]*[@-~]", // CSI
    "\\u009b[0-?]*[ -/]*[@-~]", // C1 CSI
    "\\u001b\\][^\\u0007\\u001b\\u009c]*(?:\\u0007|\\u001b\\\\|\\u009c)?", // OSC
    "\\u009d[^\\u0007\\u001b\\u009c]*(?:\\u0007|\\u001b\\\\|\\u009c)?", // C1 OSC
    "\\u001b[PX^_][^\\u001b\\u009c]*(?:\\u001b\\\\|\\u009c)?", // DCS, SOS, PM, APC
    "[\\u0090\\u0098\\u009e\\u009f][^\\u001b\\u009c]*(?:\\u001b\\\\|\\u009c)?", // C1 strings
    "\\u001b[ -/]*[0-~]", // every other ESC sequence
  ].join("|"),
  "g",
);
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Untrusted text made inert: keeps newlines and tabs, drops everything a terminal would obey. */
export function terminalText(text: string): string {
  return text.replace(ESCAPES, "").replace(CONTROLS, "");
}

/** One untrusted field on one line, capped at `max` characters. */
export function terminalLine(text: string, max = 300): string {
  const one = terminalText(text.replace(/[\r\n\t]+/g, " ")).trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : one;
}
