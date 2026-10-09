import { describe, expect, it } from "vitest";
import { terminalLine, terminalText } from "./sanitize.js";

describe("terminalText", () => {
  it("strips terminal control sequences from untrusted text", () => {
    const hostile =
      "Install \u001b]0;owned\u0007GIMP\u001b[2K\r\u001b[1;31mOK\u001b[0m\u009b2J\u202eexe.txt\u0008";
    expect(terminalText(hostile)).toBe("Install GIMPOKexe.txt");
  });

  it("keeps newlines, tabs and ordinary Unicode", () => {
    expect(terminalText("سلام\n\tcafé ✓")).toBe("سلام\n\tcafé ✓");
  });

  it("drops an unterminated OSC to the end, and DCS strings", () => {
    expect(terminalText("a\u001b]8;;http://example.invalid")).toBe("a");
    expect(terminalText("x\u001bPq#0;2;0;0;0\u001b\\y")).toBe("xy");
    expect(terminalText("left\u001b7saved\u001b8")).toBe("leftsaved");
  });
});

describe("terminalLine", () => {
  it("folds a field onto one line and caps it", () => {
    expect(terminalLine("two\nlines\r\n")).toBe("two lines");
    expect(terminalLine("x".repeat(400), 10)).toBe(`${"x".repeat(9)}…`);
    expect(terminalLine("\u001b[31m  padded  ")).toBe("padded");
  });
});
