import { describe, expect, it } from "vitest";
import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import type { ShellExit, ShellOutput } from "@jarvis/platform";
import {
  PR_TAB_TITLE_MAX,
  createPrTabNamer,
  prTabTitle,
  type PrInfo,
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

const NOW = 10_000_000;

function info(n: number, over: Partial<PrInfo> = {}): PrInfo {
  return {
    repo: "Acme/App",
    number: n,
    title: "Fix the header",
    state: "OPEN",
    createdAt: NOW - 60_000,
    ...over,
  };
}

function world(
  opts: {
    prInfo?: (repo: string, n: number) => Promise<PrInfo | undefined>;
    manual?: string[];
  } = {},
) {
  const state: WorkspaceState = { tabs: [tab("t1"), tab("t2")], activeTabId: "t1" };
  const renames: [string, string][] = [];
  const links: [string, string | null][] = [];
  const tracked: string[] = [];
  const order: string[] = [];
  let lookups = 0;
  const cfg = { enabled: true, autoLink: true };
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
        order.push("link");
        links.push([key, pane]);
      },
      trackRepo: (repo) => {
        order.push("track");
        tracked.push(repo);
      },
      pollNow: async () => {
        order.push("poll");
      },
    },
    prInfo: async (repo, n) => {
      lookups++;
      return opts.prInfo === undefined ? info(n) : opts.prInfo(repo, n);
    },
    hasManualLink: async (key) =>
      (opts.manual ?? []).some((k) => k.toLowerCase() === key.toLowerCase()),
    reviewsConfig: () => cfg,
    now: () => NOW,
  };
  const namer = createPrTabNamer(deps);
  namer.start();
  return {
    namer,
    renames,
    links,
    tracked,
    order,
    cfg,
    lookups: () => lookups,
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
  it("renames the tab and links the pane, polling first so the key is canonical", async () => {
    const w = world();
    w.print("t1", `Created ${URL_42}\r\n`);
    await w.namer.whenIdle();
    expect(w.renames).toEqual([["t1", "PR #42 · Fix the header"]]);
    expect(w.links).toEqual([["Acme/App#42", "t1"]]);
    expect(w.tracked).toEqual(["Acme/App"]);
    expect(w.order).toEqual(["track", "poll", "link"]);
    expect(w.namer.isPrNamedTab("t1")).toBe(true);
    expect(w.namer.isPrNamedTab("t2")).toBe(false);
  });

  it("maps a split pane to its tab", async () => {
    const w = world();
    w.print("t2:3", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toEqual([["t2", "PR #42 · Fix the header"]]);
    expect(w.namer.isPrNamedTab("t2")).toBe(true);
  });

  it("acts once for the same URL printed again", async () => {
    const w = world();
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toHaveLength(1);
    expect(w.links).toHaveLength(1);
  });

  it("ignores an old PR — one listed or mentioned, not opened here", async () => {
    const w = world({ prInfo: async (_r, n) => info(n, { createdAt: NOW - 2 * 60 * 60_000 }) });
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toEqual([]);
    expect(w.links).toEqual([]);
    expect(w.namer.isPrNamedTab("t1")).toBe(false);
  });

  it("ignores a closed or merged PR", async () => {
    const w = world({ prInfo: async (_r, n) => info(n, { state: "MERGED" }) });
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toEqual([]);
  });

  it("does nothing when gh cannot say", async () => {
    const w = world({
      prInfo: async () => {
        throw new Error("gh: not found");
      },
    });
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toEqual([]);
    expect(w.tracked).toEqual([]);
  });

  it("never writes over a manual link or unlink", async () => {
    const w = world({ manual: ["acme/app#42"] });
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toHaveLength(1);
    expect(w.links).toEqual([]);
    expect(w.tracked).toEqual([]);
  });

  it("renames without linking while Reviews or its auto-link is off", async () => {
    const off = world();
    off.cfg.enabled = false;
    off.print("t1", `${URL_42}\n`);
    await off.namer.whenIdle();
    expect(off.renames).toHaveLength(1);
    expect(off.links).toEqual([]);

    const manualOnly = world();
    manualOnly.cfg.autoLink = false;
    manualOnly.print("t1", `${URL_42}\n`);
    await manualOnly.namer.whenIdle();
    expect(manualOnly.links).toEqual([]);
    expect(manualOnly.tracked).toEqual([]);
  });

  it("asks gh once per pane at a time, the newest waiting PR winning", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = world({
      prInfo: async (_repo, n) => {
        if (n === 42) await gate;
        return info(n, { title: `title ${n}` });
      },
    });
    w.print("t1", `${URL_42}\n`);
    w.print("t1", "https://github.com/acme/app/pull/43\n");
    w.print("t1", "https://github.com/acme/app/pull/44\n");
    release();
    await w.namer.whenIdle();
    expect(w.lookups()).toBe(2);
    expect(w.renames).toEqual([
      ["t1", "PR #42 · title 42"],
      ["t1", "PR #44 · title 44"],
    ]);
  });

  it("forgets a pane whose shell exited", async () => {
    const w = world();
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    w.exit("t1");
    expect(w.namer.isPrNamedTab("t1")).toBe(false);
    w.print("t1", `${URL_42}\n`);
    await w.namer.whenIdle();
    expect(w.renames).toHaveLength(2);
  });
});
