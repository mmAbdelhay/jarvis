import { describe, expect, it } from "vitest";
import {
  COMMAND_SPECS,
  completePath,
  parseCommandLog,
  parseZshHistory,
  pathPrefix,
  rank,
  specSuggestions,
  suggest,
} from "./completion.js";

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

describe("rank", () => {
  const now = 1_756_000_000;
  const DAY = 60 * 60 * 24;

  // The whole point of the affinity boost: a repo-local script is worth
  // offering in its own repo and noise everywhere else.
  it("puts a command run in this cwd above the same command run elsewhere", () => {
    const entries = [
      { command: "./docker-entrypoint.sh up", at: now - 60, cwd: "/p/other" },
      { command: "./docker-entrypoint.sh down", at: now - 60, cwd: "/p/acme" },
    ];
    expect(rank("./doc", entries, "/p/acme", now)[0]?.value).toBe(
      "./docker-entrypoint.sh down",
    );
  });

  it("prefers a recent command over an older one of equal frequency", () => {
    const entries = [
      { command: "git push", at: now - DAY * 200 },
      { command: "git status", at: now - 60 },
    ];
    expect(rank("git ", entries, "/p", now)[0]?.value).toBe("git status");
  });

  it("prefers a frequent command over a one-off of the same age", () => {
    const entries = [
      { command: "npm test", at: now - 60 },
      { command: "npm run dev", at: now - 60 },
      { command: "npm run dev", at: now - 61 },
      { command: "npm run dev", at: now - 62 },
    ];
    expect(rank("npm ", entries, "/p", now)[0]?.value).toBe("npm run dev");
  });

  it("offers a history entry whole, with its arguments", () => {
    expect(
      rank("saml", [{ command: "saml2aws login", at: now }], "/p", now).map((s) => s.value),
    ).toEqual(["saml2aws login"]);
  });

  it("offers each distinct command once, however often it was run", () => {
    const entries = [
      { command: "gh auth login", at: now },
      { command: "gh auth login", at: now - 5 },
    ];
    expect(rank("gh", entries, "/p", now)).toHaveLength(1);
  });

  it("never offers back exactly what is already typed", () => {
    expect(rank("gh auth login", [{ command: "gh auth login", at: now }], "/p", now)).toEqual([]);
  });

  it("matches case-insensitively but keeps the history's own spelling", () => {
    expect(rank("GH", [{ command: "gh auth login", at: now }], "/p", now)[0]?.value).toBe(
      "gh auth login",
    );
  });

  it("returns nothing for empty or blank input", () => {
    expect(rank("", [{ command: "gh", at: now }], "/p", now)).toEqual([]);
    expect(rank("   ", [{ command: "gh", at: now }], "/p", now)).toEqual([]);
  });

  it("treats an entry with no timestamp as old rather than dropping it", () => {
    expect(rank("py", [{ command: "python -V" }], "/p", now).map((s) => s.value)).toEqual([
      "python -V",
    ]);
  });

  // Accepting a suggestion writes it to the pty as bytes. A newline in one
  // would submit it, running a command the user never pressed Enter on.
  it("never offers a multi-line entry, which would run itself on acceptance", () => {
    expect(rank("go", [{ command: "go build \\\n ./...", at: now }], "/p", now)).toEqual([]);
  });

  it("never offers an entry carrying an escape sequence", () => {
    expect(rank("ec", [{ command: "echo \u001b]0;pwned", at: now }], "/p", now)).toEqual([]);
  });

  it("labels what it returns as coming from history", () => {
    expect(rank("gh", [{ command: "gh pr list", at: now }], "/p", now)[0]?.kind).toBe("history");
  });
});

describe("specSuggestions", () => {
  const specs = [
    { command: "git", subcommands: ["status", "stash"], flags: ["--no-verify", "--amend"] },
  ];

  it("offers a subcommand for a partially typed one", () => {
    expect(specSuggestions("git sta", specs).map((s) => s.value)).toEqual([
      "git stash",
      "git status",
    ]);
  });

  it("offers every subcommand once the command name and a space are typed", () => {
    expect(specSuggestions("git ", specs).map((s) => s.value)).toEqual(["git stash", "git status"]);
  });

  it("offers flags once a dash is typed, wherever in the line it is", () => {
    expect(specSuggestions("git commit --no", specs).map((s) => s.value)).toEqual([
      "git commit --no-verify",
    ]);
  });

  it("offers nothing for a command it has no spec for", () => {
    expect(specSuggestions("orbit-dependabot u", specs)).toEqual([]);
  });

  it("offers nothing before the command name is complete", () => {
    expect(specSuggestions("gi", specs)).toEqual([]);
  });

  it("offers no subcommand beyond the first argument", () => {
    expect(specSuggestions("git commit sta", specs)).toEqual([]);
  });

  it("labels what it returns as coming from a spec", () => {
    expect(specSuggestions("git sta", specs)[0]?.kind).toBe("spec");
  });
});

describe("pathPrefix", () => {
  it("is the directory part of the last token when the token looks like a path", () => {
    expect(pathPrefix("cat ./scripts/po")).toBe("./scripts/");
    expect(pathPrefix("cat ./")).toBe("./");
    expect(pathPrefix("cat /etc/ho")).toBe("/etc/");
  });

  it("is the home directory for a bare tilde token", () => {
    expect(pathPrefix("cat ~/.conf")).toBe("~/");
  });

  it("is undefined for a token that is not a path", () => {
    expect(pathPrefix("git stat")).toBeUndefined();
    expect(pathPrefix("")).toBeUndefined();
  });
});

describe("completePath", () => {
  it("completes the last token against the listing, keeping the rest of the line", () => {
    expect(
      completePath("cat ./scripts/po", ["port-forward-dev2.sh", "build/"]).map((s) => s.value),
    ).toEqual(["cat ./scripts/port-forward-dev2.sh"]);
  });

  it("offers everything in the directory when the token ends at a slash", () => {
    expect(completePath("cat ./", ["a.txt", "b/"]).map((s) => s.value)).toEqual([
      "cat ./a.txt",
      "cat ./b/",
    ]);
  });

  it("offers nothing when the token is not a path", () => {
    expect(completePath("git stat", ["status"])).toEqual([]);
  });

  it("labels what it returns as a path", () => {
    expect(completePath("cat ./", ["a.txt"])[0]?.kind).toBe("path");
  });
});

describe("suggest", () => {
  const now = 1_756_000_000;
  const base = {
    history: [] as { command: string; at?: number; cwd?: string }[],
    specs: COMMAND_SPECS,
    listing: [] as string[],
    cwd: "/p",
    now,
  };

  it("returns nothing for empty input — the dropdown must not open at a bare prompt", () => {
    expect(suggest("", base)).toEqual([]);
    expect(suggest("   ", base)).toEqual([]);
  });

  it("puts history above specs for the same input", () => {
    const result = suggest("git sta", { ...base, history: [{ command: "git stash pop", at: now }] });
    expect(result[0]).toMatchObject({ value: "git stash pop", kind: "history" });
    expect(result.some((s) => s.kind === "spec")).toBe(true);
  });

  it("never repeats a value another source already offered", () => {
    const result = suggest("git sta", { ...base, history: [{ command: "git status", at: now }] });
    expect(result.filter((s) => s.value === "git status")).toHaveLength(1);
  });

  it("caps the list so the dropdown cannot cover the screen", () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      command: `npm run task-${index}`,
      at: now - index,
    }));
    expect(suggest("npm", { ...base, history }).length).toBeLessThanOrEqual(8);
  });

  it("includes path completions for a path-shaped token", () => {
    expect(
      suggest("cat ./", { ...base, listing: ["notes.md"] }).map((s) => s.value),
    ).toContain("cat ./notes.md");
  });

  it("has specs for exactly the generic tools the design named", () => {
    expect([...COMMAND_SPECS.map((spec) => spec.command)].sort()).toEqual([
      "docker",
      "gh",
      "git",
      "go",
      "npm",
      "pnpm",
    ]);
  });
});
