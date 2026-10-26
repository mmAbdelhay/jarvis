import { describe, expect, it } from "vitest";
import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import type { ShellExit, ShellOutput } from "@jarvis/platform";
import {
  PR_TAB_TITLE_MAX,
  createPrTabNamer,
  prTabTitle,
  type PrTabNamerDeps,
} from "./pr-tab-namer.js";

const URL_42 = "https://github.com/acme/app/pull/42";

function tab(id: string): WorkspaceTab {
  return {
    id,
    project: "p",
    url: "",
    kind: "terminal",
    title: "zsh",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    hasPlayingVideo: false,
    pageFullscreen: false,
    suspended: false,
  };
}

function world(opts: { title?: (repo: string, n: number) => Promise<string | undefined> } = {}) {
  const state: WorkspaceState = { tabs: [tab("t1"), tab("t2")], activeTabId: "t1" };
  const renames: [string, string][] = [];
  const links: [string, string | null][] = [];
  const tracked: string[] = [];
  let polls = 0;
  let enabled = true;
  const outputs = new Set<(o: ShellOutput) => void>();
  const exits = new Set<(e: ShellExit) => void>();
  const deps: PrTabNamerDeps = {
    shells: {
      onOutput: (l) => {
        outputs.add(l);
        return () => outputs.delete(l);
      },
      onShellExit: (l) => {
        exits.add(l);
        return () => exits.delete(l);
      },
    },
    tabs: {
      state: () => state,
      rename: (id, title) => {
        renames.push([id, title]);
      },
    },
    reviews: {
      link: async (key, pane) => {
        links.push([key, pane]);
      },
      trackRepo: (repo) => {
        tracked.push(repo);
      },
      pollNow: async () => {
        polls++;
      },
    },
    prTitle: opts.title ?? (async () => "Fix the header"),
    reviewsEnabled: () => enabled,
  };
  const namer = createPrTabNamer(deps);
  namer.start();
  return {
    namer,
    renames,
    links,
    tracked,
    polls: () => polls,
    disable: () => {
      enabled = false;
    },
    print: (paneKey: string, chunk: string) => {
      for (const l of outputs) l({ paneKey, chunk, offset: 0 });
    },
    exit: (paneKey: string) => {
      for (const l of exits) l({ paneKey, code: 0 } as ShellExit);
    },
  };
}

describe("prTabTitle", () => {
  it("names the PR number and title", () => {
    expect(prTabTitle(42, "Fix the header")).toBe("PR #42 · Fix the header");
  });
  it("falls back to the number alone", () => {
    expect(prTabTitle(42, undefined)).toBe("PR #42");
    expect(prTabTitle(42, "  ")).toBe("PR #42");
  });
  it("cuts a long title with an ellipsis", () => {
    const title = prTabTitle(42, "A very long pull request title that keeps on going");
    expect(title.length).toBeLessThanOrEqual(PR_TAB_TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("PR #42 · A very")).toBe(true);
  });
});

describe("PR tab namer", () => {
  it("renames the pane's tab and links the pane in Reviews", async () => {
    const w = world();
    w.print("t1", `Created ${URL_42}\r\n`);
    await w.namer.whenIdle();
    expect(w.renames).toEqual([["t1", "PR #42 · Fix the header"]]);
    expect(w.links).toEqual([["acme/app#42", "t1"]]);
    expect(w.tracked).toEqual(["acme/app"]);
    expect(w.polls()).toBe(1);
    expect(w.namer.isPrNamed("t1")).toBe(true);
    expect(w.namer.isPrNamed("t2")).toBe(false);
  });

  it("maps a split pane to its tab", async () => {
    const w = world();
    w.print("t2:3", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toEqual([["t2", "PR #42 · Fix the header"]]);
  });

  it("acts once for the same URL printed again", async () => {
    const w = world();
    w.print("t1", `${URL_42}\n`);
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toHaveLength(1);
    expect(w.links).toHaveLength(1);
  });

  it("uses the bare number when the title cannot be read", async () => {
    const w = world({
      title: async () => {
        throw new Error("gh: not found");
      },
    });
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toEqual([["t1", "PR #42"]]);
  });

  it("still renames, without linking, while Reviews is off", async () => {
    const w = world();
    w.disable();
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toHaveLength(1);
    expect(w.links).toEqual([]);
    expect(w.tracked).toEqual([]);
  });

  it("lets a newer PR win over one whose title is still loading", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = world({
      title: async (_repo, n) => {
        if (n === 42) await gate;
        return `title ${n}`;
      },
    });
    w.print("t1", `${URL_42}\n`);
    w.print("t1", "https://github.com/acme/app/pull/43\n");
    release();
    await w.namer.whenIdle();
    expect(w.renames).toEqual([["t1", "PR #43 · title 43"]]);
  });

  it("forgets a pane whose shell exited", async () => {
    const w = world();
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    w.exit("t1");
    expect(w.namer.isPrNamed("t1")).toBe(false);
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toHaveLength(2);
  });
});
