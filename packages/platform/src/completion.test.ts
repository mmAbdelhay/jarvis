import { describe, expect, it } from "vitest";
import { parseCommandLog, parseZshHistory } from "./completion.js";

describe("parseZshHistory", () => {
  it("reads the extended `: epoch:elapsed;command` format", () => {
    expect(parseZshHistory(": 1756000000:0;saml2aws login\n")).toEqual([
      { command: "saml2aws login", at: 1756000000 },
    ]);
  });

  it("reads a bare line written without the extended prefix", () => {
    expect(parseZshHistory("npm run dev\n")).toEqual([{ command: "npm run dev" }]);
  });

  // A history file is appended to by every shell the user has open, and a
  // half-written line is an ordinary thing to find in one.
  it("skips a malformed line and still parses the ones around it", () => {
    const entries = parseZshHistory(
      [": 1:0;git status", ": nonsense", "", ": 3:0;gh auth login"].join("\n"),
    );
    expect(entries.map((entry) => entry.command)).toEqual([
      "git status",
      ": nonsense",
      "gh auth login",
    ]);
  });

  it("keeps a command continued over lines as one entry", () => {
    expect(parseZshHistory(": 1:0;go build \\\n  ./...\n")).toEqual([
      { command: "go build \n  ./...", at: 1 },
    ]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseZshHistory("")).toEqual([]);
  });
});

describe("parseCommandLog", () => {
  it("reads Jarvis's own epoch/cwd/command lines", () => {
    expect(parseCommandLog("1756000000\t/p/acme\t./scripts/port-forward-dev2.sh\n")).toEqual([
      { command: "./scripts/port-forward-dev2.sh", at: 1756000000, cwd: "/p/acme" },
    ]);
  });

  it("skips a line with too few fields", () => {
    expect(parseCommandLog("garbage\n1\t/p\tls\n").map((entry) => entry.command)).toEqual(["ls"]);
  });

  it("skips a line whose timestamp is not a number", () => {
    expect(parseCommandLog("when\t/p\tls\n")).toEqual([]);
  });

  it("keeps a command that itself contains a tab", () => {
    expect(parseCommandLog("1\t/p\tgrep 'a\tb' file\n")[0]?.command).toBe("grep 'a\tb' file");
  });
});
