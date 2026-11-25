// @vitest-environment jsdom
//
// The side panel and, in a narrow pane, the chips above the composer.
import { beforeEach, describe, expect, it } from "vitest";
import { fileIconFor } from "../file-icons.js";
import { createPanel } from "./panel.js";
import { agentView, open, press, settle, t } from "./fixture.js";

beforeEach(() => {
  document.body.replaceChildren();
});

const data = () =>
  agentView({
    todos: [
      { text: "Find the bug", state: "done" },
      { text: "Move the discount", state: "done" },
      { text: "Add a coupon test", state: "active" },
      { text: "Run the suite", state: "open" },
    ],
    agents: [{ id: "g1", label: "Check other totals", state: "running", startedAt: 0 }],
    files: [
      { path: "/repo/src/total.js", added: 2, removed: 1 },
      { path: "/repo/src/total.test.js", added: 18 },
    ],
    context: { used: 38000, leftPercent: 62 },
  });

const width = (host: HTMLElement, px: number) =>
  Object.defineProperty(host, "clientWidth", { configurable: true, get: () => px });

describe("the side panel", () => {
  it("shows To-do, Sub-agents, Changed files and Context with their data", async () => {
    const s = await open(data());
    const side = s.q<HTMLElement>(".ac-side");
    expect(side.hidden).toBe(false);
    const titles = [...side.querySelectorAll(".ac-section__title")].map(
      (n) => n.querySelector(".ac-section__name")?.textContent ?? n.textContent,
    );
    expect(titles).toEqual(["Context", "To-do", "Sub-agents", "Changed files"]);
    const summaries = [...side.querySelectorAll(".ac-section__summary")].map((n) => n.textContent);
    expect(summaries).toEqual(["2 of 4", "1 running", "2 \u00b7 +20 \u22121"]);
    expect(side.querySelector(".ac-section__value")?.textContent).toBe("62% left");
    expect(side.querySelector(".ac-agent")?.textContent).toContain("Check other totals");
    expect(side.querySelector(".ac-agent__state")?.textContent).toBe("Running 0s");
    const files = [...side.querySelectorAll<HTMLButtonElement>(".ac-file")];
    expect(files.map((f) => f.textContent)).toEqual([
      "total.js/repo/src+2−1",
      "total.test.js/repo/src+18",
    ]);
    expect(files.map((f) => f.querySelector(".file-icon")?.getAttribute("src"))).toEqual([
      `vendor/material-icons/icons/${fileIconFor("total.js")}`,
      `vendor/material-icons/icons/${fileIconFor("total.test.js")}`,
    ]);
    // The label says "62% left", so the bar is 62% full, not 38%.
    expect(side.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("62");
    expect(side.querySelector<HTMLElement>(".ac-meter__fill")?.style.inlineSize).toBe("62%");
    expect(side.querySelectorAll(".ac-todo--done")).toHaveLength(2);
  });

  it("hides a section with no data, and the whole panel when there is none", async () => {
    const some = await open(agentView({ context: { used: 5000 } }));
    expect(
      [...some.host.querySelectorAll(".ac-side .ac-section__title")].map((n) => n.textContent),
    ).toEqual(["Context"]);
    expect(some.host.querySelector(".ac-section__value")?.textContent).toBe("5k tokens used");
    expect(some.host.querySelector(".ac-side [role='progressbar']")).toBeNull();
    const none = await open(agentView());
    expect(none.q<HTMLElement>(".ac-side").hidden).toBe(true);
  });

  it("opens a changed file in the editor", async () => {
    const s = await open(data());
    s.q<HTMLButtonElement>(".ac-file").click();
    await settle();
    expect(s.api.terminalAgentOpenFile).toHaveBeenCalledWith("t1", "/repo/src/total.js");
  });

  it("can be hidden and shown again, and remembers it", async () => {
    const s = await open(data());
    s.q<HTMLButtonElement>(".ac-hide-panel").click();
    expect(s.q<HTMLElement>(".ac-side").hidden).toBe(true);
    expect(s.storage.store.get("jarvis.agentChatPanel")).toBe("hidden");
    const toggle = s.q<HTMLButtonElement>(".ac-panel-toggle");
    expect(toggle.getAttribute("aria-label")).toBe(t("agentChatShowPanel"));
    const again = await open(data(), { storage: s.storage });
    expect(again.q<HTMLElement>(".ac-side").hidden).toBe(true);
    toggle.click();
    expect(s.q<HTMLElement>(".ac-side").hidden).toBe(false);
    expect(s.storage.store.get("jarvis.agentChatPanel")).toBe("shown");
  });

  it("repaints only the clocks when its data did not change, so a focused button keeps the focus", async () => {
    const s = await open(data());
    const button = s.q<HTMLButtonElement>(".ac-file");
    button.focus();
    s.timers.advance(40_000);
    s.chat.refresh();
    await settle();
    expect(s.q(".ac-file")).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(s.q(".ac-agent__state").textContent).toBe("Running 40s");
    expect(s.q(".ac-agent__time").textContent).toBe("40s");
    expect(s.q<HTMLElement>(".ac-agent").title).toBe("Running 40s");
  });

  it("labels the panel for a screen reader", async () => {
    const s = await open(data());
    expect(s.q(".ac-side").getAttribute("aria-label")).toBe(t("agentChatPanelLabel"));
  });
});

const agent = (n: number, state: "running" | "done" | "failed", extra = {}) => ({
  id: `a${n}`,
  label: `Agent ${n}`,
  state,
  startedAt: n * 1000,
  ...(state === "running" ? {} : { endedAt: n * 1000 + 5000 }),
  ...extra,
});

describe("the redesigned side panel", () => {
  it("keeps Context and Usage limits pinned above a scrolling area, with the hide button", async () => {
    const s = await open(data());
    const side = s.q<HTMLElement>(".ac-side");
    const kids = [...side.children].map((n) => n.className);
    expect(kids).toEqual(["ac-side__pin", "ac-side__scroll"]);
    expect(side.querySelector(".ac-side__pin .ac-hide-panel")?.getAttribute("aria-label")).toBe(
      t("agentChatHidePanel"),
    );
    expect(side.querySelector(".ac-side__pin [data-section='context']")).not.toBeNull();
    expect(side.querySelector(".ac-side__scroll [data-section='context']")).toBeNull();
  });

  it("has the hide button even with no context or limits", async () => {
    const s = await open(agentView({ todos: [{ text: "a", state: "open" }] }));
    expect(s.q(".ac-side__pin .ac-hide-panel")).not.toBeNull();
  });

  it("collapses a section with a labelled button and remembers it", async () => {
    const s = await open(data());
    const button = () => s.q<HTMLButtonElement>('[data-section="files"] .ac-section__toggle');
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const body = s.q<HTMLElement>('[data-section="files"] .ac-section__body');
    expect(button().getAttribute("aria-controls")).toBe(body.id);
    button().focus();
    button().click();
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(s.q<HTMLElement>('[data-section="files"] .ac-section__body').hidden).toBe(true);
    expect(document.activeElement).toBe(button());
    const again = await open(data(), { storage: s.storage });
    expect(
      again
        .q<HTMLButtonElement>('[data-section="files"] .ac-section__toggle')
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("orders sub-agents running first, then failed, then done, one line each", async () => {
    const s = await open(
      agentView({
        agents: [
          agent(1, "done"),
          agent(2, "running"),
          agent(3, "failed"),
          agent(4, "done"),
          agent(5, "running"),
        ],
      }),
    );
    const rows = [...s.host.querySelectorAll<HTMLElement>(".ac-agent")];
    expect(rows.map((r) => r.querySelector(".ac-agent__name")?.textContent)).toEqual([
      "Agent 5",
      "Agent 2",
      "Agent 3",
      "Agent 4",
      "Agent 1",
    ]);
    expect(rows[2]?.querySelector(".ac-agent__time")?.textContent).toBe("Failed");
    expect(rows[3]?.querySelector(".ac-agent__time")?.textContent).toBe("5s");
    expect(s.q('[data-section="agents"] .ac-section__summary').textContent).toBe(
      "2 running \u00b7 2 done \u00b7 1 failed",
    );
  });

  it("caps sub-agents at 5 and files at 6, and Show all keeps the focus", async () => {
    const s = await open(
      agentView({
        agents: Array.from({ length: 12 }, (_v, i) => agent(i, "done")),
        files: Array.from({ length: 9 }, (_v, i) => ({ path: `/r/f${i}.ts`, added: 1 })),
      }),
    );
    expect(s.host.querySelectorAll(".ac-agent")).toHaveLength(5);
    expect(s.host.querySelectorAll(".ac-file")).toHaveLength(6);
    const more = () => s.q<HTMLButtonElement>('[data-section="agents"] .ac-more');
    expect(more().textContent).toBe("Show all 12");
    more().focus();
    more().click();
    expect(s.host.querySelectorAll(".ac-agent")).toHaveLength(12);
    expect(more().textContent).toBe("Show fewer");
    expect(document.activeElement).toBe(more());
    more().click();
    expect(s.host.querySelectorAll(".ac-agent")).toHaveLength(5);
  });

  it("shows every running agent up to 8", async () => {
    const s = await open(
      agentView({ agents: Array.from({ length: 7 }, (_v, i) => agent(i, "running")) }),
    );
    expect(s.host.querySelectorAll(".ac-agent")).toHaveLength(7);
    expect(s.host.querySelector('[data-section="agents"] .ac-more')).toBeNull();
  });

  it("collapses finished to-dos behind a button when there are more than three", async () => {
    const todos = [
      { text: "d1", state: "done" },
      { text: "d2", state: "done" },
      { text: "d3", state: "done" },
      { text: "d4", state: "done" },
      { text: "now", state: "active" },
      { text: "later", state: "open" },
    ] as const;
    const s = await open(agentView({ todos: [...todos] }));
    expect([...s.host.querySelectorAll(".ac-todo__text")].map((n) => n.textContent)).toEqual([
      "now",
      "later",
    ]);
    const more = s.q<HTMLButtonElement>('[data-section="todo"] .ac-more');
    expect(more.textContent).toBe("Show 4 done");
    more.click();
    expect(s.host.querySelectorAll(".ac-todo")).toHaveLength(6);
  });

  it("keeps the scroll position of the lists across a repaint", async () => {
    const s = await open(
      agentView({ files: Array.from({ length: 9 }, (_v, i) => ({ path: `/r/f${i}.ts` })) }),
    );
    s.q<HTMLElement>(".ac-side__scroll").scrollTop = 120;
    s.q<HTMLButtonElement>('[data-section="files"] .ac-more').click();
    expect(s.q<HTMLElement>(".ac-side__scroll").scrollTop).toBe(120);
  });

  it("reveal shows a hidden panel and opens a collapsed section", () => {
    let hidden = true;
    const panel = createPanel({
      t,
      openFile: () => undefined,
      hidden: () => hidden,
      setHidden: (value) => {
        hidden = value;
      },
    });
    document.body.append(panel.aside, panel.chips);
    panel.update(
      {
        agents: [],
        files: [],
        now: 0,
        status: { limits: [], lines: ["raw"], details: {} },
      },
      false,
    );
    expect(panel.aside.hidden).toBe(true);
    panel.reveal("raw");
    expect(hidden).toBe(false);
    expect(panel.aside.hidden).toBe(false);
    expect(
      panel.aside
        .querySelector('[data-section="raw"] .ac-section__toggle')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("a narrow pane", () => {
  async function narrow() {
    const s = await open(agentView());
    width(s.host, 700);
    s.current.view = data();
    s.chat.refresh();
    await settle();
    return s;
  }

  it("hides the panel under 1000px and shows chips above the composer", async () => {
    const s = await narrow();
    expect(s.q<HTMLElement>(".ac-side").hidden).toBe(true);
    expect(s.q<HTMLElement>(".agent-chat").dataset["narrow"]).toBe("true");
    const chips = [...s.host.querySelectorAll(".ac-chip")].map((c) => c.textContent);
    expect(chips).toEqual(["To-do 2 of 4", "Sub-agents 1", "Changed files 2", "Context 62% left"]);
    expect(s.q<HTMLElement>(".ac-panel-toggle").hidden).toBe(true);
  });

  it("opens the same section in a popover, closes on a second click and on Escape", async () => {
    const s = await narrow();
    const chip = s.q<HTMLButtonElement>('.ac-chip[data-section="todo"]');
    chip.click();
    const popover = s.q<HTMLElement>(".ac-popover");
    expect(popover.hidden).toBe(false);
    expect(popover.querySelector(".ac-section__title")?.textContent).toBe("To-do, 2 of 4");
    expect(popover.querySelector(".ac-section__toggle")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    chip.click();
    expect(popover.hidden).toBe(true);
    chip.click();
    press(chip, "Escape");
    expect(popover.hidden).toBe(true);
    expect(document.activeElement).toBe(chip);
    s.q<HTMLButtonElement>('.ac-chip[data-section="files"]').click();
    s.q<HTMLButtonElement>(".ac-popover .ac-file").click();
    await settle();
    expect(s.api.terminalAgentOpenFile).toHaveBeenCalledWith("t1", "/repo/src/total.js");
  });

  it("Show all inside the popover keeps it open and the focus on the button", async () => {
    const s = await open(agentView());
    width(s.host, 700);
    s.current.view = agentView({
      files: Array.from({ length: 9 }, (_v, i) => ({ path: `/r/f${i}.ts` })),
    });
    s.chat.refresh();
    await settle();
    s.q<HTMLButtonElement>('.ac-chip[data-section="files"]').click();
    const more = () => s.q<HTMLButtonElement>(".ac-popover .ac-more");
    expect(s.host.querySelectorAll(".ac-popover .ac-file")).toHaveLength(6);
    more().focus();
    more().click();
    expect(s.q<HTMLElement>(".ac-popover").hidden).toBe(false);
    expect(s.host.querySelectorAll(".ac-popover .ac-file")).toHaveLength(9);
    expect(document.activeElement).toBe(more());
  });

  it("returns to the panel when the pane widens", async () => {
    const s = await narrow();
    width(s.host, 1400);
    s.chat.refresh();
    await settle();
    expect(s.q<HTMLElement>(".ac-side").hidden).toBe(false);
    expect(s.q<HTMLElement>(".ac-chips").hidden).toBe(true);
  });
});
