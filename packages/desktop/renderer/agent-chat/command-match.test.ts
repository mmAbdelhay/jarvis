import { describe, expect, it } from "vitest";
import type { AgentCommandInfo } from "../../src/agent-suggest.js";
import { BUILT_IN_COMMANDS } from "../../src/agent-command-tables.js";
import { argumentChoices, rankCommands, readToken } from "./command-match.js";

const c = (name: string, extra: Partial<AgentCommandInfo> = {}): AgentCommandInfo => ({
  name,
  source: "built-in",
  ...extra,
});
const names = (list: ReturnType<typeof rankCommands>) => list.map((hit) => hit.command.name);

describe("rankCommands", () => {
  const list = [
    c("review"),
    c("security-review"),
    c("preview"),
    c("rev", { source: "project" }),
    c("clear", { aliases: ["reset"] }),
    c("x", { description: "Write a review of the diff" }),
    c("rvw"),
  ];

  it("ranks exact, alias, prefix, word start, substring, subsequence, then description", () => {
    expect(names(rankCommands(list, "rev", "/"))).toEqual([
      "rev",
      "review",
      "security-review",
      "preview",
      "x",
    ]);
    expect(names(rankCommands(list, "reset", "/"))[0]).toBe("clear");
    expect(names(rankCommands(list, "rvw", "/"))).toEqual([
      "rvw",
      "review",
      "preview",
      "security-review",
    ]);
  });

  it("puts a built-in first only when the rank is equal", () => {
    const tie = [
      c("deploy", { source: "project" }),
      c("deploy2"),
      c("deploy3", { source: "plugin" }),
    ];
    expect(names(rankCommands(tie, "dep", "/"))).toEqual(["deploy2", "deploy", "deploy3"]);
    expect(names(rankCommands(tie, "deploy", "/"))[0]).toBe("deploy");
  });

  it("marks the matched letters of the name", () => {
    const hit = rankCommands([c("security-review")], "rev", "/")[0];
    expect(hit?.indexes).toEqual([9, 10, 11]);
    expect(rankCommands([c("review")], "rvw", "/")[0]?.indexes).toEqual([0, 2, 5]);
  });

  it("lists everything for an empty query, grouped: built-in, project, account, skill, plugin", () => {
    const mixed = [
      c("p", { source: "plugin" }),
      c("s", { source: "skill" }),
      c("b1"),
      c("a", { source: "account" }),
      c("pr", { source: "project" }),
      c("b2"),
    ];
    expect(names(rankCommands(mixed, "", "/"))).toEqual(["b1", "b2", "pr", "a", "s", "p"]);
  });

  it("shows $ skills in the / list and only them after $", () => {
    const mixed = [c("model"), c("pdf", { trigger: "$", source: "skill" })];
    expect(names(rankCommands(mixed, "", "/"))).toEqual(["model", "pdf"]);
    expect(names(rankCommands(mixed, "", "$"))).toEqual(["pdf"]);
    expect(names(rankCommands(mixed, "mo", "$"))).toEqual([]);
  });

  it("does not look in descriptions for a single letter", () => {
    expect(names(rankCommands([c("zzz", { description: "a b c" })], "c", "/"))).toEqual([]);
  });

  it.each(["anthropic", "openai", "github"] as const)(
    "%s: every prefix of three command names finds that command",
    (vendor) => {
      const table = BUILT_IN_COMMANDS[vendor];
      const list = table.map((command) => ({
        ...command,
        source: "built-in" as const,
      })) as AgentCommandInfo[];
      for (const name of [
        table[0]?.name,
        table[Math.floor(table.length / 2)]?.name,
        table.at(-1)?.name,
      ]) {
        for (let length = 1; length <= (name ?? "").length; length++) {
          const prefix = (name ?? "").slice(0, length);
          expect(names(rankCommands(list, prefix, "/")), `${vendor} ${prefix}`).toContain(name);
        }
      }
    },
  );
});

describe("readToken", () => {
  it("reads a command name at the start and in the middle of a message", () => {
    expect(readToken("/rev", 4, true)).toMatchObject({
      kind: "name",
      trigger: "/",
      query: "rev",
      start: 0,
      end: 4,
      atStart: true,
    });
    expect(readToken("please /re", 10, true)).toMatchObject({
      kind: "name",
      query: "re",
      start: 7,
      atStart: false,
    });
  });

  it("filters by the part before the caret and replaces the whole name", () => {
    expect(readToken("/review now", 4, true)).toMatchObject({
      kind: "name",
      query: "rev",
      start: 0,
      end: 7,
    });
  });

  it("closes for paths, URLs, a second slash and plain words", () => {
    expect(readToken("see /usr/", 9, true)).toBeUndefined();
    expect(readToken("see /usr/local", 8, true)).toBeUndefined();
    expect(readToken("a/b", 3, true)).toBeUndefined();
    expect(readToken("http://x", 8, true)).toBeUndefined();
    expect(readToken("//x", 3, true)).toBeUndefined();
  });

  it("takes $ only when allowed", () => {
    expect(readToken("use $pd", 7, true)).toMatchObject({
      kind: "name",
      trigger: "$",
      query: "pd",
    });
    expect(readToken("use $pd", 7, false)).toBeUndefined();
  });

  it("reads the argument after a typed name and a space", () => {
    expect(readToken("/model ", 7, true)).toMatchObject({
      kind: "arg",
      name: "model",
      query: "",
      start: 7,
      end: 7,
    });
    expect(readToken("/model so", 9, true)).toMatchObject({
      kind: "arg",
      name: "model",
      query: "so",
      start: 7,
    });
    expect(readToken("hey /model ", 11, true)).toBeUndefined();
    expect(readToken("/model a b", 10, true)).toBeUndefined();
  });
});

describe("argumentChoices", () => {
  const model = c("model", { choices: ["opus", "sonnet", "haiku"], aliases: ["m"] });

  it("filters the documented choices the same way, by name or alias, and never invents any", () => {
    expect(argumentChoices([model], "model", "")).toEqual(["opus", "sonnet", "haiku"]);
    expect(argumentChoices([model], "m", "so")).toEqual(["sonnet"]);
    expect(argumentChoices([model], "model", "zz")).toEqual([]);
    expect(argumentChoices([c("init")], "init", "")).toEqual([]);
    expect(argumentChoices([model], "nope", "")).toEqual([]);
  });
});
