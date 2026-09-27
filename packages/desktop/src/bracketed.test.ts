import { describe, expect, it } from "vitest";
import { bracketedSubmit } from "./bracketed.js";

describe("bracketedSubmit", () => {
  it("wraps a single-line comment in bracketed paste, unlike submitBytes", () => {
    expect(bracketedSubmit("looks good")).toBe("\u001b[200~looks good\u001b[201~\r");
  });

  it("wraps multi-line feedback the same way", () => {
    expect(bracketedSubmit('Comments on plan.md:\n\n1. On "x": fix it')).toBe(
      '\u001b[200~Comments on plan.md:\n\n1. On "x": fix it\u001b[201~\r',
    );
  });

  it("wraps empty text too — always exactly one Enter", () => {
    expect(bracketedSubmit("")).toBe("\u001b[200~\u001b[201~\r");
  });

  // Security fix: formatFeedback (@jarvis/core) embeds plan block text,
  // quote, body and path verbatim, and any of those can come from an
  // untrusted plan file on disk. Without sanitizing first, an embedded
  // `\u001b[201~` closes the bracketed paste early and everything after it
  // is typed live into the shell/agent as if the user had typed it.
  it("strips an embedded ESC so a plan file cannot end the paste early", () => {
    const out = bracketedSubmit("looks good\u001b[201~rm -rf ~\n");

    // Exactly one START, at the very beginning.
    expect(out.indexOf("\u001b[200~")).toBe(0);
    expect(out.indexOf("\u001b[200~", 1)).toBe(-1);
    // Exactly one END, immediately before the final \r.
    expect(out.endsWith("\u001b[201~\r")).toBe(true);
    expect(out.slice(0, -"\u001b[201~\r".length).includes("\u001b[201~")).toBe(false);
    // No ESC anywhere but the two markers this function itself added.
    const escCount = [...out].filter((ch) => ch === "\u001b").length;
    expect(escCount).toBe(2);
    // The rest of the embedded sequence survives as harmless literal text
    // (no leading ESC byte, so a terminal reads it as printable characters,
    // not a control sequence) rather than being silently dropped.
    expect(out).toBe("\u001b[200~looks good[201~rm -rf ~\n\u001b[201~\r");
  });

  it("strips other C0 control bytes (e.g. BEL) but keeps tab and newline", () => {
    expect(bracketedSubmit("a\u0007b\tc\nd")).toBe("\u001b[200~ab\tc\nd\u001b[201~\r");
  });

  it("strips C1 control bytes (\\u0080-\\u009f)", () => {
    expect(bracketedSubmit("a\u0085b")).toBe("\u001b[200~ab\u001b[201~\r");
  });

  it("normalises CRLF and lone CR to LF", () => {
    expect(bracketedSubmit("a\r\nb\rc")).toBe("\u001b[200~a\nb\nc\u001b[201~\r");
  });
});
