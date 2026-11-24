// @vitest-environment jsdom
//
// The feed: items in true order, grouped and carded tools, output and diffs,
// keyed rows that survive an update, paging, and the reader's scroll.
import { beforeEach, describe, expect, it } from "vitest";
import { agentView, geometry, open, reply, settle, t, tool, user } from "./fixture.js";
import { familyOf, tokenize } from "./code.js";
import { mergeLive, prependOlder } from "./paging.js";

beforeEach(() => {
  document.body.replaceChildren();
});

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".ac-column > *")];

describe("the feed's order and rows", () => {
  it("draws text and tools in the order they happened, with the working line last", async () => {
    const s = await open(
      agentView({
        working: "Crunching… 5s",
        page: {
          items: [
            user("u1", "go"),
            reply("a1", "first"),
            tool("t1", "Bash", { command: "ls", output: "a\nb", at: 0, endAt: 4000 }),
            reply("a2", "second"),
          ],
        },
      }),
    );
    const kinds = rows(s.host).map((row) => row.className);
    expect(kinds[0]).toContain("agent-chat__row--user");
    expect(kinds[1]).toContain("agent-chat__row--text");
    expect(kinds[2]).toContain("ac-card--bash");
    expect(kinds[3]).toContain("agent-chat__row--text");
    expect(kinds.at(-1)).toContain("ac-working");
    expect(s.q(".ac-working").getAttribute("role")).toBe("status");
  });

  it("shows a divider as a translated event, never as the user's words", async () => {
    const s = await open(
      agentView({
        page: {
          items: [
            { id: "d1", kind: "divider", event: "compacted" },
            { id: "d2", kind: "divider", event: "agentDone", label: "Check totals" },
          ],
        },
      }),
    );
    const dividers = [...s.host.querySelectorAll(".ac-divider")].map((d) => d.textContent);
    expect(dividers).toEqual([t("agentChatEventCompacted"), "Check totals finished"]);
    expect(s.host.querySelector(".agent-chat__bubble")).toBeNull();
  });

  it("keeps unchanged rows, appends only the new one, and replaces only a changed one", async () => {
    const s = await open();
    const before = rows(s.host);
    s.current.view = agentView({
      page: { items: [...agentView().page.items, reply("a2", "More.")] },
    });
    s.chat.refresh();
    await settle();
    const after = rows(s.host);
    expect(after.length).toBe(before.length + 1);
    for (const row of before) expect(after).toContain(row);

    s.current.view = agentView({
      page: {
        items: [
          ...agentView().page.items.slice(0, 2),
          reply("a1", "Changed."),
          reply("a2", "More."),
        ],
      },
    });
    s.chat.refresh();
    await settle();
    const changed = rows(s.host);
    expect(changed[0]).toBe(before[0]);
    expect(changed[1]).toBe(before[1]);
    expect(changed[2]).not.toBe(before[2]);
    expect(changed[2]?.textContent).toContain("Changed.");
  });

  it("gives each row content-visibility through its class, and a stable id", async () => {
    const s = await open();
    for (const row of rows(s.host)) expect(row.classList.contains("ac-row")).toBe(true);
    expect(rows(s.host).map((row) => row.dataset["itemId"])).toEqual(["u1", "t1", "a1"]);
  });
});

describe("tool rows", () => {
  it("collapses consecutive read and search tools into one row, and keeps Edit and Bash as cards", async () => {
    const s = await open(
      agentView({
        page: {
          items: [
            tool("r1", "Read", { target: "a.ts", at: 0, endAt: 1000 }),
            tool("r2", "Read", { target: "b.ts", at: 1000, endAt: 2000 }),
            tool("r3", "Grep", { target: "total", at: 2000, endAt: 4000 }),
            tool("e1", "Edit", { path: "/repo/a.ts", diff: [{ sign: "+", text: "x" }] }),
            tool("b1", "Bash", { command: "npm test" }),
            tool("r4", "Read", { target: "c.ts" }),
          ],
        },
      }),
    );
    const out = rows(s.host);
    expect(out).toHaveLength(4);
    expect(out[0]?.className).toContain("ac-group");
    expect(out[0]?.textContent).toContain("Read 2 files, searched once");
    expect(out[0]?.textContent).toContain("4s");
    expect(out[1]?.className).toContain("ac-card--edit");
    expect(out[2]?.className).toContain("ac-card--bash");
    expect(out[3]?.textContent).toContain("Read 1 file");
    const toggle = out[0]?.querySelector<HTMLButtonElement>(".ac-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(out[0]?.querySelector<HTMLElement>(".ac-group__list")?.hidden).toBe(true);
    toggle?.click();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(out[0]?.querySelector<HTMLElement>(".ac-group__list")?.hidden).toBe(false);
  });

  it("opens a short diff and collapses a long one, and the reader's choice survives an update", async () => {
    const long = Array.from({ length: 14 }, (_, i) => ({ sign: "+" as const, text: `l${i}` }));
    const s = await open(
      agentView({
        page: {
          items: [
            tool("e1", "Edit", {
              path: "/repo/a.ts",
              diff: [
                { sign: "-", text: "a" },
                { sign: "+", text: "b" },
              ],
            }),
            tool("e2", "Edit", { path: "/repo/b.ts", diff: long, state: "running" }),
          ],
        },
      }),
    );
    const [short, big] = rows(s.host);
    expect(short?.querySelector<HTMLElement>(".ac-diff")?.hidden).toBe(false);
    expect(short?.querySelector(".agent-chat__add")?.textContent).toBe("+1");
    expect(short?.querySelector(".agent-chat__del")?.textContent).toBe("−1");
    expect(big?.querySelector<HTMLElement>(".ac-diff")?.hidden).toBe(true);
    big?.querySelector<HTMLButtonElement>(".ac-toggle")?.click();
    // The running tool finishes: its row is rebuilt, and stays open.
    s.current.view = agentView({
      page: {
        items: [
          tool("e1", "Edit", {
            path: "/repo/a.ts",
            diff: [
              { sign: "-", text: "a" },
              { sign: "+", text: "b" },
            ],
          }),
          tool("e2", "Edit", { path: "/repo/b.ts", diff: long, state: "ok" }),
        ],
      },
    });
    s.chat.refresh();
    await settle();
    const [, rebuilt] = rows(s.host);
    expect(rebuilt).not.toBe(big);
    expect(rebuilt?.querySelector<HTMLElement>(".ac-diff")?.hidden).toBe(false);
  });

  it("opens an edited file through agentOpenFile", async () => {
    const s = await open();
    s.q<HTMLButtonElement>(".ac-card--edit .ac-small-button").click();
    await settle();
    expect(s.api.terminalAgentOpenFile).toHaveBeenCalledWith("t1", "/repo/app.ts");
    s.api.terminalAgentOpenFile.mockResolvedValueOnce({ ok: false, reason: "outside" } as never);
    s.q<HTMLButtonElement>(".ac-card--edit .ac-small-button").click();
    await settle();
    expect(s.q(".agent-chat__note").textContent).toBe(t("agentChatOpenFailed"));
  });

  it("shows output as its last 6 lines with Show all, and says when it was cut", async () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const s = await open(
      agentView({
        page: { items: [tool("b1", "Bash", { command: "npm test", output, outputCut: true })] },
      }),
    );
    const head = s.q<HTMLElement>(".ac-output__head");
    expect(head.hidden).toBe(true);
    const visible = s.q<HTMLElement>(".ac-output__text").textContent ?? "";
    expect(visible).toContain("line 20");
    expect(s.q(".ac-output__cut").textContent).toBe(t("agentChatOutputCut"));
    const more = s.q<HTMLButtonElement>(".ac-output .ac-link-button");
    expect(more.textContent).toBe("Show all 20 lines");
    more.click();
    expect(head.hidden).toBe(false);
    expect(more.textContent).toBe(t("agentChatShowLess"));
  });

  it("marks ok and failed neutrally with the time, never says Passed, and shows nothing for an unknown outcome", async () => {
    const s = await open(
      agentView({
        page: {
          items: [
            tool("b1", "Bash", {
              command: "npm test",
              state: "ok",
              at: 0,
              endAt: 4000,
              output: "PASS",
            }),
            tool("b2", "Bash", { command: "npm run x", state: "error", at: 0, endAt: 1000 }),
            tool("b3", "Bash", { command: "ls", state: "ended" }),
            tool("b4", "Bash", { command: "sleep 9", state: "running" }),
          ],
        },
      }),
    );
    const [ok, failed, ended, running] = rows(s.host);
    expect(ok?.querySelector(".ac-mark--ok")?.getAttribute("aria-label")).toBe(
      t("agentChatToolOk"),
    );
    expect(ok?.querySelector(".ac-time")?.textContent).toBe("4s");
    expect(failed?.querySelector(".ac-mark--error")).not.toBeNull();
    expect(ended?.querySelector(".ac-mark")).toBeNull();
    expect(running?.querySelector(".ac-mark--running")).not.toBeNull();
    expect(s.host.textContent).not.toMatch(/passed/i);
  });

  it("shows a pair list and details for any other tool", async () => {
    const s = await open(
      agentView({
        page: {
          items: [tool("x1", "TodoWrite", { input: [{ key: "todos", value: "3" }], state: "ok" })],
        },
      }),
    );
    const card = rows(s.host)[0];
    expect(card?.className).toContain("ac-card--other");
    expect(card?.querySelector("dt")?.textContent).toBe("todos");
  });

  it("names the language in the code header, and with none has no header and Copy overlays", async () => {
    const s = await open(
      agentView({
        page: {
          items: [reply("a1", "```js\nconst a = 1; // x\n```"), reply("a2", "```\nplain\n```")],
        },
      }),
    );
    const [withLang, without] = [...s.host.querySelectorAll<HTMLElement>(".ac-codebox")];
    expect(withLang?.querySelector(".ac-codebox__lang")?.textContent).toBe("js");
    expect(withLang?.querySelector(".ac-tok--keyword")?.textContent).toBe("const");
    expect(withLang?.querySelector(".ac-tok--comment")?.textContent).toBe("// x");
    expect(without?.querySelector(".ac-codebox__bar")).toBeNull();
    expect(without?.querySelector(".ac-copy--overlay")).not.toBeNull();
  });

  it("reads code, commands, output and diffs left to right, and isolates +/- counts", async () => {
    const s = await open(
      agentView({
        page: {
          items: [
            reply("a1", "```js\nx\n```"),
            tool("b1", "Bash", { command: "a\nb", output: "o" }),
            tool("e1", "Edit", { path: "/r/a.ts", diff: [{ sign: "+", text: "x" }] }),
          ],
        },
      }),
    );
    for (const sel of [".ac-codebox", ".ac-code", ".ac-cmd", ".ac-output__text", ".ac-diff"]) {
      expect(s.q(sel).getAttribute("dir"), sel).toBe("ltr");
    }
    const count = s.q(".ac-card--edit bdi.agent-chat__add");
    expect(count.getAttribute("dir")).toBe("ltr");
  });

  it("puts the toggle's words in its label only, and orders a header name, target, counts, status", async () => {
    const s = await open();
    const head = s.q<HTMLElement>(".ac-card--edit .ac-card__head");
    expect(head.querySelector(".ac-toggle")?.getAttribute("aria-label")).toBe("Changes, 3 lines");
    expect(head.querySelector(".ac-toggle")?.textContent).toBe("");
    const order = [...head.children].map((n) => n.className.split(" ")[0]);
    expect(order.indexOf("ac-card__name")).toBeLessThan(order.indexOf("ac-card__target"));
    expect(order.indexOf("ac-card__target")).toBeLessThan(order.indexOf("agent-chat__add"));
  });

  it("copies a command and a code block", async () => {
    const s = await open(
      agentView({
        page: {
          items: [
            tool("b1", "Bash", { command: "npm test" }),
            reply("a1", "```\nconst x = 1;\n```"),
          ],
        },
      }),
    );
    s.q<HTMLButtonElement>(".ac-card--bash .ac-copy").click();
    expect(s.copy).toHaveBeenLastCalledWith("npm test");
    s.q<HTMLButtonElement>(".ac-codebox .ac-copy").click();
    expect(s.copy).toHaveBeenLastCalledWith("const x = 1;");
    expect(s.q<HTMLButtonElement>(".ac-codebox .ac-copy").textContent).toBe(t("agentChatCopied"));
    s.q<HTMLButtonElement>(".agent-chat__row--text .ac-copy--message").click();
    expect(s.copy).toHaveBeenLastCalledWith("```\nconst x = 1;\n```");
  });

  it("shows how long a turn took where timestamps exist", async () => {
    const s = await open(
      agentView({
        page: {
          items: [
            user("u1", "go", 0),
            tool("t1", "Bash", { command: "x", at: 1000, endAt: 62000 }),
            reply("a1", "done", 63000),
            user("u2", "next", 70000),
          ],
        },
      }),
    );
    expect(s.q(".ac-turn").textContent).toBe("Worked for 1m 03s");
  });
});

describe("the tokenizer", () => {
  it("splits code into comment, string, number and keyword runs that join back to the input", () => {
    const code = 'const n = 42; // note\nreturn "s";';
    const tokens = tokenize(code, familyOf("ts"));
    expect(tokens.map((t) => t.text).join("")).toBe(code);
    const kinds = Object.fromEntries(tokens.map((t) => [t.text, t.kind]));
    expect(kinds["const"]).toBe("keyword");
    expect(kinds["42"]).toBe("number");
    expect(kinds["// note"]).toBe("comment");
    expect(kinds['"s"']).toBe("string");
  });

  it("leaves unknown languages and huge code plain, and reads shell and json", () => {
    expect(tokenize("whatever 1", familyOf(undefined))).toEqual([
      { kind: "plain", text: "whatever 1" },
    ]);
    expect(tokenize("x".repeat(30_000), "c")).toHaveLength(1);
    expect(tokenize("# hi\nif true", "sh").map((t) => t.kind)).toContain("comment");
    expect(tokenize('{"a": true, "b": 1}', "json").map((t) => t.kind)).toEqual(
      expect.arrayContaining(["string", "keyword", "number"]),
    );
  });
});

describe("paging", () => {
  const ids = (items: { id: string }[]) => items.map((i) => i.id);
  it("keeps older loaded items when the live page slides, and replaces on reset", () => {
    const older = [user("a", "a"), user("b", "b")];
    const live1 = [user("c", "c"), user("d", "d")];
    const merged = mergeLive(prependOlder(live1, older), [user("d", "d"), user("e", "e")], false);
    expect(ids(merged)).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids(mergeLive(merged, [user("z", "z")], true))).toEqual(["z"]);
    expect(ids(prependOlder(live1, [user("c", "c"), user("b", "b")]))).toEqual(["b", "c", "d"]);
  });

  it("takes the finished version of a tool in place of the running one", () => {
    const merged = mergeLive(
      [tool("t", "Bash", { state: "running" })],
      [tool("t", "Bash", { state: "ok" })],
      false,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind === "tool" && merged[0].state).toBe("ok");
  });

  it("loads older items when the reader nears the top, keeping what they were reading in place", async () => {
    const s = await open(
      agentView({ page: { items: [user("c", "c"), reply("d", "d")], older: "cursor-1" } }),
    );
    const feed = s.q<HTMLElement>(".agent-chat__feed");
    const state = geometry(feed, { scrollHeight: 0, clientHeight: 300, scrollTop: 50 });
    // The content grows with its rows, as it would when they are drawn.
    Object.defineProperty(feed, "scrollHeight", {
      configurable: true,
      get: () => 600 + feed.querySelectorAll("[data-item-id]").length * 200,
    });
    s.api.terminalAgentChat.mockImplementationOnce(async (_pane, request) => {
      expect(request).toEqual({ before: "cursor-1" });
      return agentView({ page: { items: [user("a", "a"), reply("b", "b")], older: "cursor-0" } });
    });
    feed.dispatchEvent(new Event("scroll"));
    await settle();
    await settle();
    expect(
      rows(s.host)
        .map((row) => row.dataset["itemId"])
        .filter(Boolean),
    ).toEqual(["a", "b", "c", "d"]);
    expect(state.scrollTop).toBe(450);
    // A refresh of the live page keeps them, and the next cursor is the older page's.
    s.current.view = agentView({
      page: { items: [user("c", "c"), reply("d", "d")], older: "cursor-1" },
    });
    s.chat.refresh();
    await settle();
    expect(
      rows(s.host)
        .map((row) => row.dataset["itemId"])
        .filter(Boolean),
    ).toEqual(["a", "b", "c", "d"]);
    s.api.terminalAgentChat.mockImplementationOnce(async (_pane, request) => {
      expect(request).toEqual({ before: "cursor-0" });
      return agentView({ page: { items: [] } });
    });
    feed.dispatchEvent(new Event("scroll"));
    await settle();
  });

  it("replaces everything when the page says reset", async () => {
    const s = await open(agentView({ page: { items: [user("c", "c")], older: "c1" } }));
    s.current.view = agentView({ reset: true, page: { items: [user("z", "z")] } });
    s.chat.refresh();
    await settle();
    expect(rows(s.host).map((row) => row.dataset["itemId"])).toEqual(["z"]);
  });

  it("offers Load older to the keyboard and shows a loading line while it loads", async () => {
    const s = await open(agentView({ page: { items: [user("c", "c")], older: "c1" } }));
    const button = s.q<HTMLButtonElement>(".ac-older .ac-link-button");
    let release: () => void = () => {};
    s.api.terminalAgentChat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(agentView({ page: { items: [user("a", "a")] } }));
        }),
    );
    button.click();
    await settle();
    expect(s.q(".ac-older").textContent).toBe(t("agentChatLoadingOlder"));
    release();
    await settle();
    expect(s.host.querySelector(".ac-older")).toBeNull();
  });

  it("shows a small loading line in the panel while the whole session is still read", async () => {
    const s = await open(agentView({ deriving: true }));
    expect(s.q(".ac-side .ac-deriving").textContent).toBe(t("agentChatDeriving"));
  });
});

describe("the reader's scroll", () => {
  it("follows new items only from the bottom, and offers Jump to latest when scrolled up", async () => {
    const s = await open();
    const feed = s.q<HTMLElement>(".agent-chat__feed");
    const state = geometry(feed, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
    const more = (n: number) =>
      agentView({ page: { items: [...agentView().page.items, reply(`m${n}`, `more ${n}`)] } });
    s.current.view = more(1);
    s.chat.refresh();
    await settle();
    expect(feed.scrollTop).toBe(1000);
    expect(s.q<HTMLElement>(".ac-jump").hidden).toBe(true);

    state.scrollTop = 100; // the user scrolled up to read
    feed.dispatchEvent(new Event("scroll"));
    s.current.view = more(2);
    s.chat.refresh();
    await settle();
    expect(feed.scrollTop).toBe(100);
    const jump = s.q<HTMLButtonElement>(".ac-jump");
    expect(jump.hidden).toBe(false);
    expect(jump.textContent).toBe(t("agentChatJumpLatest"));
    jump.click();
    expect(feed.scrollTop).toBe(state.scrollHeight);
    expect(jump.hidden).toBe(true);
  });

  it("stays pinned to the bottom when the feed's own height changes (a question card appears), and not when scrolled up", async () => {
    const callbacks: (() => void)[] = [];
    class FakeObserver {
      constructor(cb: () => void) {
        callbacks.push(cb);
      }
      observe() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeObserver;
    try {
      const s = await open();
      const feed = s.q<HTMLElement>(".agent-chat__feed");
      const state = geometry(feed, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });
      feed.dispatchEvent(new Event("scroll"));
      state.clientHeight = 100; // the card took space below
      for (const cb of callbacks) cb();
      expect(state.scrollTop).toBe(1000);
      expect(s.q<HTMLElement>(".ac-jump").hidden).toBe(true);
      state.scrollTop = 100;
      feed.dispatchEvent(new Event("scroll"));
      state.clientHeight = 50;
      for (const cb of callbacks) cb();
      expect(state.scrollTop).toBe(100);
    } finally {
      delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    }
  });
});
