import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBashHistory, parseZshHistory } from "@jarvis/platform";
import { createCompletionSource, type CompletionSourceDeps } from "./completion-source.js";

function source(overrides: Partial<CompletionSourceDeps> = {}) {
  return createCompletionSource({
    readHistory: async () => "",
    // zsh's format unless a test says otherwise: it is the one every
    // existing case here is written in.
    parseHistory: parseZshHistory,
    readCommandLog: async () => "",
    listDirectory: async () => [],
    now: () => 0,
    ...overrides,
  });
}

describe("createCompletionSource", () => {
  it("ranks the user's own history for the given input", async () => {
    const instance = source({
      readHistory: async () => ": 100:0;saml2aws login\n",
      now: () => 100,
    });

    expect(await instance.suggest("/p", "saml")).toEqual(["saml2aws login"]);
  });

  // The whole reason Jarvis keeps a command log of its own: zsh's history
  // records no directory, so without it the affinity boost has nothing to
  // work with.
  it("boosts a command the log says was run in this directory", async () => {
    const instance = source({
      readHistory: async () => ": 100:0;./run.sh a\n: 100:0;./run.sh b\n",
      readCommandLog: async () => "100\t/p/two\t./run.sh b\n",
      now: () => 100,
    });

    expect((await instance.suggest("/p/two", "./run"))[0]).toBe("./run.sh b");
  });

  it("lists only the directory the typed token names, resolved against the cwd", async () => {
    const seen: string[] = [];
    const instance = source({
      listDirectory: async (path) => {
        seen.push(path);
        return ["port-forward-dev2.sh"];
      },
    });

    expect(await instance.suggest("/p", "cat ./scripts/po")).toEqual([
      "cat ./scripts/port-forward-dev2.sh",
    ]);
    // resolve(): the source resolves the token against the cwd, so the
    // listing is asked for the platform's own spelling of the path.
    expect(seen).toEqual([resolve("/p", "./scripts")]);
  });

  it("lists no directory at all when the token is not a path", async () => {
    let listed = 0;
    const instance = source({
      listDirectory: async () => {
        listed += 1;
        return [];
      },
    });

    await instance.suggest("/p", "git stat");

    expect(listed).toBe(0);
  });

  it("supplements history with the built-in specs", async () => {
    expect(await source().suggest("/p", "git stat")).toContain("git status");
  });

  // Every failure degrades to today's terminal. An unreadable history costs
  // the history source and nothing else.
  it("still suggests from specs when every file read fails", async () => {
    const instance = source({
      readHistory: async () => {
        throw new Error("ENOENT");
      },
      readCommandLog: async () => {
        throw new Error("ENOENT");
      },
      listDirectory: async () => {
        throw new Error("ENOENT");
      },
    });

    await expect(instance.suggest("/p", "git stat")).resolves.toContain("git status");
  });

  it("returns nothing for a blank line", async () => {
    expect(await source().suggest("/p", "")).toEqual([]);
    expect(await source().suggest("/p", "   ")).toEqual([]);
  });

  // A keystroke must not cost a re-read of a 1300-entry history file.
  it("re-reads the history at most once per cache window", async () => {
    let reads = 0;
    const instance = source({
      readHistory: async () => {
        reads += 1;
        return "";
      },
      cacheMs: 60_000,
      now: () => 0,
    });

    await instance.suggest("/p", "a");
    await instance.suggest("/p", "b");

    expect(reads).toBe(1);
  });

  it("re-reads the history once the cache window has passed", async () => {
    let reads = 0;
    let clock = 0;
    const instance = source({
      readHistory: async () => {
        reads += 1;
        return "";
      },
      cacheMs: 1_000,
      now: () => clock,
    });

    await instance.suggest("/p", "a");
    clock = 2_000;
    await instance.suggest("/p", "b");

    expect(reads).toBe(2);
  });
  // The editor's arrows read this: Jarvis's own log, newest first, with a
  // command run twice appearing once — and read fresh every time, because
  // the command you just ran is the one you are most likely to want back.
  it("gives the command log's commands newest first, deduplicated and capped", async () => {
    const instance = source({
      readCommandLog: async () => "100\t/p\tls\n101\t/p\tgit status\n102\t/p\tls\n103\t/p\tmake\n",
    });

    expect(await instance.history(2)).toEqual(["make", "ls"]);
    expect(await instance.history(10)).toEqual(["make", "ls", "git status"]);
  });

  it("gives no history when the command log cannot be read", async () => {
    const instance = source({
      readCommandLog: async () => {
        throw new Error("gone");
      },
    });

    await expect(instance.history(10)).resolves.toEqual([]);
  });
});

describe("createCompletionSource under bash", () => {
  it("ranks a bash-format history, timestamps and all", async () => {
    // The same assertion as the zsh case above, in the other format. Reading
    // a bash history with zsh's parser does not fail — it silently drops
    // every timestamp, and with it the recency half of the ranking.
    const instance = source({
      readHistory: async () => "#100\nsaml2aws login\n",
      parseHistory: parseBashHistory,
      now: () => 100,
    });

    expect(await instance.suggest("/p", "saml")).toEqual(["saml2aws login"]);
  });

  it("still ranks a bash history that carries no timestamps at all", async () => {
    const instance = source({
      readHistory: async () => "saml2aws login\n",
      parseHistory: parseBashHistory,
      now: () => 100,
    });

    expect(await instance.suggest("/p", "saml")).toEqual(["saml2aws login"]);
  });
});
