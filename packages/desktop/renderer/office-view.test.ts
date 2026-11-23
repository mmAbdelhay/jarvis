// @vitest-environment jsdom
//
// The Office view: rooms, employees, hover card, pan and zoom. The model is
// built with the real buildOffice; the stage is measured by an injected size
// because jsdom has no layout.
import { readFileSync } from "node:fs";
import type { Session, WorkspaceTab } from "@jarvis/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../src/messages.js";
import { buildOffice, type OfficeInput, type OfficeTarget } from "./office-model.js";
import { createOfficeView, initOffice, type OfficeView } from "./office-view.js";

const html = readFileSync("packages/desktop/renderer/index.html", "utf8");
const css = readFileSync("packages/desktop/renderer/styles.css", "utf8");
const NOW = 1_000_000_000;

function skeleton(): string {
  const match = /<div class="main main--office"[\s\S]*?<!-- \/Office view -->/.exec(html);
  if (match === null) throw new Error("index.html has no Office skeleton");
  return match[0].replace(" hidden>", ">");
}

function tab(id: string, project: string, overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id,
    project,
    url: "https://example.com",
    kind: "web",
    title: `tab ${id}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    hasPlayingVideo: false,
    pageFullscreen: false,
    suspended: false,
    ...overrides,
  };
}

function modelOf(tabs: WorkspaceTab[], extra: Partial<OfficeInput> = {}) {
  return buildOffice({
    projects: ["alpha", "beta", "gamma"],
    workspace: { tabs, activeTabId: undefined },
    sessions: [] as Session[],
    activity: { panes: {}, sessions: {} },
    runningTabs: new Set<string>(),
    now: NOW,
    ...extra,
  });
}

let root: HTMLElement;
let opened: OfficeTarget[];
let openedTab: number;

function setup(options: { language?: "ar" | "en"; visible?: () => boolean } = {}) {
  document.body.innerHTML = skeleton();
  root = document.getElementById("view-office") as HTMLElement;
  opened = [];
  openedTab = 0;
  const view = createOfficeView({
    root,
    open: (target) => opened.push(target),
    openTab: () => {
      openedTab += 1;
    },
    measure: () => ({ width: 1160, height: 848 }),
    now: () => NOW,
    ...options,
  });
  return view;
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
};
const seats = () => [...root.querySelectorAll<HTMLButtonElement>(".office-seat")];
const signs = () => [...root.querySelectorAll<HTMLButtonElement>(".office-sign")];
const settleTimers = () => vi.advanceTimersByTime(1000);

beforeEach(() => {
  vi.useFakeTimers();
});

describe("the floor", () => {
  it("draws a room with a sign per open project and a seat button per employee, closed ones not at all", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha"), tab("t2", "alpha"), tab("t3", "gamma")]));
    expect(signs().map((sign) => sign.textContent)).toEqual(["alpha 2", "gamma 1"]);
    expect(seats()).toHaveLength(3);
    expect(root.textContent).not.toContain("beta 0");
  });

  it("says who and what in each seat's name, in words as well as colour", () => {
    const view = setup();
    view.update(
      modelOf([tab("t1", "alpha", { kind: "terminal" })], {
        activity: {
          panes: { t1: { agent: "Codex", state: "question", question: "Run it?" } },
          sessions: {},
        },
      }),
    );
    const label = seats()[0]?.getAttribute("aria-label") ?? "";
    expect(label).toContain("Codex");
    expect(label).toContain("alpha");
    expect(label).toContain(MESSAGES.officePose("hand", "en"));
    expect($(".office-hand").textContent).toContain(MESSAGES.officePose("hand", "en"));
    expect($(".office-bubble").textContent).toBe("Run it?");
  });

  it("keeps the same nodes across an update and adds only the new employee", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha"), tab("t2", "alpha")]));
    const before = seats();
    seats()[0]?.focus();
    view.update(
      modelOf([tab("t1", "alpha", { loading: true }), tab("t2", "alpha"), tab("t3", "alpha")]),
    );
    const after = seats();
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(document.activeElement).toBe(before[0]);
    expect(after[2]?.classList.contains("office-seat--in")).toBe(true);
  });

  it("crossfades a pose change inside the same seat", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha")]));
    const seat = seats()[0];
    expect(seat?.querySelectorAll(".office-pose")).toHaveLength(1);
    view.update(modelOf([tab("t1", "alpha", { loading: true })]));
    expect(seats()[0]).toBe(seat);
    expect(seat?.querySelectorAll(".office-pose")).toHaveLength(2);
    expect(seat?.querySelector(".office-pose--out")).not.toBeNull();
    settleTimers();
    expect(seat?.querySelectorAll(".office-pose")).toHaveLength(1);
  });

  it("walks a leaver out for 400 ms, then removes it", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha"), tab("t2", "alpha")]));
    view.update(modelOf([tab("t1", "alpha")]));
    expect(seats()).toHaveLength(2);
    expect(root.querySelectorAll(".office-seat--out")).toHaveLength(1);
    vi.advanceTimersByTime(399);
    expect(seats()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(seats()).toHaveLength(1);
  });

  it("does not animate employees already there on the first draw", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha")]));
    expect(root.querySelector(".office-seat--in")).toBeNull();
  });

  it("shows hostile labels and questions as text, never markup", () => {
    const view = setup();
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    view.update(
      modelOf([tab("t1", hostile, { kind: "terminal", title: hostile })], {
        projects: [hostile],
        activity: {
          panes: { t1: { agent: hostile, state: "question", question: hostile, doing: hostile } },
          sessions: {},
        },
      }),
    );
    seats()[0]?.dispatchEvent(new MouseEvent("mouseenter"));
    expect(root.querySelector("img, script")).toBeNull();
    expect(root.textContent).toContain(hostile);
  });

  it("shows the empty state with an Open a tab button when nobody is in", () => {
    const view = setup();
    view.update(modelOf([]));
    expect($("#office-empty").hidden).toBe(false);
    expect($("#office-empty-title").textContent).toBe("Nobody is in yet");
    $("#office-empty-open").click();
    expect(openedTab).toBe(1);
    view.update(modelOf([tab("t1", "alpha")]));
    expect($("#office-empty").hidden).toBe(true);
  });
});

describe("the label layer", () => {
  const layer = () => $("#office-world .office-labels");
  const asking = {
    panes: { t1: { agent: "Codex", state: "question" as const, question: "Run it?" } },
    sessions: {},
  };

  it("holds every name label, hand badge and bubble in one layer after all rooms, outside every room", () => {
    const view = setup();
    view.update(
      modelOf([tab("t1", "alpha", { kind: "terminal" }), tab("t2", "gamma")], { activity: asking }),
    );
    const world = $("#office-world");
    expect(world.lastElementChild).toBe(layer());
    const rooms = [...world.querySelectorAll(".office-room")];
    expect(rooms).toHaveLength(2);
    expect(layer().querySelectorAll(".office-tag")).toHaveLength(2);
    expect(layer().querySelectorAll(".office-hand")).toHaveLength(1);
    expect(layer().querySelectorAll(".office-bubble")).toHaveLength(1);
    for (const room of rooms) {
      expect(room.querySelector(".office-tag, .office-hand, .office-bubble")).toBeNull();
    }
    expect(layer().getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps the same label nodes across an update, follows a leaver out, and drops the badge when the hand lowers", () => {
    const view = setup();
    view.update(
      modelOf([tab("t1", "alpha", { kind: "terminal" }), tab("t2", "alpha")], { activity: asking }),
    );
    const tags = [...layer().querySelectorAll(".office-tag")];
    const badge = layer().querySelector(".office-hand");
    view.update(
      modelOf([tab("t1", "alpha", { kind: "terminal" }), tab("t2", "alpha")], { activity: asking }),
    );
    expect([...layer().querySelectorAll(".office-tag")]).toEqual(tags);
    expect(layer().querySelector(".office-hand")).toBe(badge);
    view.update(modelOf([tab("t1", "alpha", { kind: "terminal" })], { activity: asking }));
    settleTimers();
    expect(layer().querySelectorAll(".office-tag")).toHaveLength(1);
    view.update(modelOf([tab("t1", "alpha", { kind: "terminal" })]));
    expect(layer().querySelector(".office-hand")).toBeNull();
  });

  it("places a seat's labels at its world position and tints them by pose", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha", { kind: "terminal" })], { activity: asking }));
    const seat = seats()[0] as HTMLElement;
    const room = $(".office-room");
    const group = layer().firstElementChild as HTMLElement;
    expect(group.dataset["pose"]).toBe("hand");
    expect(parseFloat(group.style.left)).toBe(
      parseFloat(room.style.left) + parseFloat(seat.style.left),
    );
    expect(parseFloat(group.style.top)).toBe(
      parseFloat(room.style.top) + parseFloat(seat.style.top),
    );
  });

  it("is stacked above every room, and the old in-room selectors are gone", () => {
    const rule = /\.office-labels\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/z-index:\s*\d{3,}/);
    expect(css).not.toMatch(/\.office-seat\[data-pose="hand"\]\s+\.office-tag/);
  });
});

describe("the sidebar's hands pill", () => {
  it("is hidden and empty for a room with no hands, and hidden again after a hand lowers", () => {
    const view = setup();
    view.update(
      modelOf([tab("t1", "alpha", { kind: "terminal" }), tab("t2", "gamma")], {
        activity: { panes: { t1: { agent: "Codex", state: "question" } }, sessions: {} },
      }),
    );
    const pills = () => [...root.querySelectorAll<HTMLElement>(".office-row__hands")];
    expect(pills().map((pill) => pill.hidden)).toEqual([false, true, true]);
    view.update(modelOf([tab("t1", "alpha", { kind: "terminal" }), tab("t2", "gamma")]));
    for (const pill of pills()) {
      expect(pill.hidden).toBe(true);
      expect(pill.textContent).toBe("");
    }
  });

  it("is never painted when it is hidden or empty, whatever else styles it", () => {
    const rules = [...css.matchAll(/\.office-row__hands([^{]*)\{([^}]*)\}/g)];
    const hides = (selector: string) =>
      rules.some(
        ([, tail, body]) => (tail ?? "").trim() === selector && /display:\s*none/.test(body ?? ""),
      );
    expect(hides("[hidden]")).toBe(true);
    expect(hides(":empty")).toBe(true);
    // Nothing else may set a display on the pill.
    const others = rules.filter(
      ([, tail]) => !["[hidden]", ":empty"].includes((tail ?? "").trim()),
    );
    for (const [, , body] of others) expect(body).not.toMatch(/display\s*:/);
  });
});

describe("opening an employee", () => {
  it("opens the tab, the pane or the session it stands for", () => {
    const view = setup();
    view.update(
      modelOf([tab("t1", "alpha"), tab("t2", "alpha", { kind: "terminal" })], {
        sessions: [
          {
            id: "s1",
            project: "alpha",
            projectPath: "/p",
            agentId: "claude",
            state: "running",
            summary: "x",
            startedAt: NOW - 60_000,
            lastActivityAt: NOW,
          },
        ],
        activity: {
          panes: { "t2:p9": { agent: "Claude Code", state: "question", question: "ok?" } },
          sessions: {},
        },
      }),
    );
    for (const seat of seats()) seat.click();
    expect(opened).toEqual([
      { type: "tab", tabId: "t1" },
      { type: "pane", tabId: "t2", paneKey: "t2:p9" },
      { type: "session", sessionId: "s1" },
    ]);
  });

  it("a room sign zooms to its room instead", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha"), tab("t2", "gamma")]));
    const fit = view.view().k;
    signs()[0]?.click();
    expect(view.view().k).toBeGreaterThan(fit);
    expect(opened).toEqual([]);
  });
});

describe("the hover card", () => {
  it("shows kind, project, agent and model, state, doing, branch, diff, last active and question on hover and focus", () => {
    const view = setup();
    view.update(
      modelOf([tab("t1", "alpha", { kind: "terminal" })], {
        sessions: [
          {
            id: "s1",
            project: "alpha",
            projectPath: "/p",
            agentId: "claude",
            state: "running",
            summary: "x",
            startedAt: NOW - 600_000,
            lastActivityAt: NOW - 120_000,
            origin: "external",
            pid: 4,
            terminalPaneKey: "t1",
            branch: "feat/x",
            insertions: 12,
            deletions: 3,
            changedFiles: 2,
          },
        ],
        activity: {
          panes: {
            t1: {
              agent: "Claude Code",
              state: "question",
              question: "Delete it?",
              doing: "Edit app.ts",
              model: "claude-x",
            },
          },
          sessions: {},
        },
      }),
    );
    const card = $("#office-card");
    expect(card.hidden).toBe(true);
    seats()[0]?.dispatchEvent(new MouseEvent("mouseenter"));
    expect(card.hidden).toBe(false);
    const text = card.textContent ?? "";
    for (const part of [
      "Claude",
      "alpha",
      "Claude Code",
      "claude-x",
      "needs you",
      "Edit app.ts",
      "feat/x",
      "+12",
      "3",
      "2m ago",
      "Delete it?",
      "Click to open this tab",
    ]) {
      expect(text).toContain(part);
    }
    seats()[0]?.dispatchEvent(new MouseEvent("mouseleave"));
    expect(card.hidden).toBe(true);
    seats()[0]?.dispatchEvent(new FocusEvent("focus"));
    expect(card.hidden).toBe(false);
    seats()[0]?.dispatchEvent(new FocusEvent("blur"));
    expect(card.hidden).toBe(true);
  });
});

describe("the hover card's doing row", () => {
  const cardText = (language: "ar" | "en", state: "busy" | "idle") => {
    const view = setup({ language });
    view.update(
      modelOf([tab("t1", "alpha", { kind: "terminal" })], {
        activity: {
          panes: { t1: { agent: "Claude Code", state, doing: "Edit app.ts" } },
          sessions: {},
        },
      }),
    );
    seats()[0]?.dispatchEvent(new MouseEvent("mouseenter"));
    return $("#office-card").textContent ?? "";
  };

  it("labels the line Doing only while the agent is busy, and Last when it is idle", () => {
    expect(cardText("en", "busy")).toContain(MESSAGES.officeCardDoing("en"));
    expect(cardText("en", "idle")).not.toContain(MESSAGES.officeCardDoing("en"));
    expect(cardText("en", "idle")).toContain(MESSAGES.officeCardLast("en"));
    expect(cardText("en", "idle")).toContain("Edit app.ts");
    expect(MESSAGES.officeCardLast("ar")).not.toBe(MESSAGES.officeCardLast("en"));
    expect(cardText("ar", "idle")).toContain(MESSAGES.officeCardLast("ar"));
  });
});

describe("the sidebar", () => {
  it("lists raised hands first, then by count, closed projects last and dim", () => {
    const view = setup();
    view.update(
      modelOf([tab("t1", "alpha"), tab("t2", "gamma", { kind: "terminal" }), tab("t3", "alpha")], {
        activity: { panes: { t2: { agent: "Codex", state: "question" } }, sessions: {} },
      }),
    );
    const rows = [...root.querySelectorAll<HTMLButtonElement>(".office-row")];
    expect(rows.map((row) => row.querySelector(".office-row__name")?.textContent)).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(rows[2]?.disabled).toBe(true);
    expect(rows[2]?.classList.contains("office-row--closed")).toBe(true);
    expect(rows[0]?.textContent).toContain("1 hand");
    expect($("#office-summary").textContent).toBe("3 employees, 2 open projects, 1 closed");
    expect($("#office-hands").textContent).toBe("1 hand raised");
  });

  it("zooms to a room from its row and back out with Show whole office", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha"), tab("t2", "gamma")]));
    const fit = view.view();
    root.querySelector<HTMLButtonElement>(".office-row")?.click();
    expect(view.view().k).toBeGreaterThan(fit.k);
    expect(view.view().fit).toBe(false);
    $("#office-home").click();
    expect(view.view()).toEqual(fit);
  });

  it("writes Arabic when asked", () => {
    const view = setup({ language: "ar" });
    view.update(modelOf([tab("t1", "alpha")]));
    expect($("#office-summary").textContent).toBe(MESSAGES.officeSummary(1, 1, 2, "ar"));
    expect($("#office-home").textContent).toBe(MESSAGES.officeShowAll("ar"));
  });
});

describe("pan and zoom", () => {
  it("opens on fit-all, with the minimap hidden", () => {
    const view = setup();
    const busy = (project: string) =>
      Array.from({ length: 12 }, (_, i) => tab(`${project}${i}`, project));
    view.update(modelOf([...busy("alpha"), ...busy("beta"), ...busy("gamma")]));
    expect(view.view().fit).toBe(true);
    expect($("#office-minimap").hidden).toBe(true);
  });

  it("keeps the user's zoom and pan across updates and a hidden route", () => {
    let visible = true;
    const view = setup({ visible: () => visible });
    view.update(modelOf([tab("t1", "alpha")]));
    view.zoomIn();
    view.zoomIn();
    const kept = view.view();
    expect(kept.fit).toBe(false);
    view.update(modelOf([tab("t1", "alpha"), tab("t2", "alpha")]));
    expect(view.view()).toEqual(kept);
    visible = false;
    view.update(modelOf([tab("t1", "alpha")]));
    visible = true;
    view.show();
    expect(view.view().k).toBe(kept.k);
    expect(view.view().tx).toBe(kept.tx);
  });

  it("shows the minimap and names once zoomed in, and keeps signs a constant screen size", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha")]));
    for (let i = 0; i < 6; i += 1) view.zoomIn();
    expect(view.view().k).toBeGreaterThan(0.7);
    expect($("#office-minimap").hidden).toBe(false);
    expect(root.classList.contains("office--near")).toBe(true);
    expect(Number($("#office-world").style.getPropertyValue("--office-inv"))).toBeCloseTo(
      1 / view.view().k,
      3,
    );
  });

  it("zooms at the pointer from a non-passive wheel listener on the stage only", () => {
    const stageAdd = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const view = setup();
    const wheelCalls = stageAdd.mock.calls.filter(([type]) => type === "wheel");
    expect(wheelCalls).toHaveLength(1);
    expect(wheelCalls[0]?.[2]).toMatchObject({ passive: false });
    expect(docAdd.mock.calls.some(([type]) => type === "wheel")).toBe(false);
    stageAdd.mockRestore();
    docAdd.mockRestore();
    view.update(modelOf([tab("t1", "alpha")]));
    const before = view.view().k;
    const event = new WheelEvent("wheel", {
      deltaY: 200,
      clientX: 100,
      clientY: 100,
      cancelable: true,
      bubbles: true,
    });
    $("#office-stage").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(view.view().k).toBeLessThan(before);
  });

  it("pans by dragging, and a drag never counts as a click on an employee", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha")]));
    const stage = $("#office-stage");
    const before = view.view();
    const fire = (type: string, x: number, y: number, buttons = 1) => {
      const event = new MouseEvent(type, {
        clientX: x,
        clientY: y,
        buttons,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      seats()[0]?.dispatchEvent(event);
    };
    fire("pointerdown", 10, 10);
    fire("pointermove", 60, 40);
    fire("pointerup", 60, 40, 0);
    seats()[0]?.click();
    expect(view.view().tx).toBe(before.tx + 50);
    expect(view.view().ty).toBe(before.ty + 30);
    expect(opened).toEqual([]);
    vi.advanceTimersByTime(1);
    seats()[0]?.click();
    expect(opened).toHaveLength(1);
    expect(stage).toBeTruthy();
  });

  it("pans a focused seat into view", () => {
    const view = setup();
    view.update(modelOf([tab("t1", "alpha")]));
    for (let i = 0; i < 6; i += 1) view.zoomIn();
    const moved = view.view();
    seats()[0]?.dispatchEvent(new FocusEvent("focus"));
    expect(view.view().k).toBe(moved.k);
  });
});

describe("a hidden route", () => {
  it("does no DOM work until it is shown", () => {
    let visible = false;
    const view = setup({ visible: () => visible });
    const observer = new MutationObserver(() => undefined);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    view.update(modelOf([tab("t1", "alpha")]));
    expect(observer.takeRecords()).toHaveLength(0);
    expect(seats()).toHaveLength(0);
    visible = true;
    view.show();
    expect(seats()).toHaveLength(1);
    observer.disconnect();
  });
});

describe("motion", () => {
  it("is CSS only, still under prefers-reduced-motion, and paused for a hidden route or document", () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.main--office[\s\S]*?animation:\s*none/.exec(
        css,
      );
    expect(reduced).not.toBeNull();
    expect(css).toMatch(/\.main--office\[hidden\][^{]*\{[^}]*animation-play-state:\s*paused/);
    expect(css).toMatch(/\.office--paused[^{]*\{[^}]*animation-play-state:\s*paused/);
  });

  it("pauses its animations while the document is hidden", () => {
    setup();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.classList.contains("office--paused")).toBe(true);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.classList.contains("office--paused")).toBe(false);
  });

  it("uses logical properties for the sidebar, so right-to-left mirrors it", () => {
    const side = /\.office-side\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(side).toContain("border-inline-end");
    expect(side).not.toMatch(/border-(left|right)|\bleft:|\bright:/);
  });
});

describe("reading the view", () => {
  it("exposes the stage size to fit with, and refits on show when it was never measured", () => {
    let size = { width: 0, height: 0 };
    document.body.innerHTML = skeleton();
    root = document.getElementById("view-office") as HTMLElement;
    const view: OfficeView = createOfficeView({
      root,
      open: () => undefined,
      openTab: () => undefined,
      measure: () => size,
      now: () => NOW,
    });
    view.update(modelOf([tab("t1", "alpha")]));
    size = { width: 1160, height: 848 };
    view.show();
    expect(view.view().k).toBeGreaterThan(0);
    expect(view.view().fit).toBe(true);
  });
});

describe("the feed", () => {
  it("counts hands for the nav badge while the route is hidden, and draws only when shown", async () => {
    vi.useRealTimers();
    document.body.innerHTML = skeleton();
    root = document.getElementById("view-office") as HTMLElement;
    root.hidden = true;
    const onHands = vi.fn();
    let changed: () => void = () => undefined;
    const activity = { panes: {} as Record<string, never>, sessions: {} };
    const api = {
      officeActivity: vi.fn(async () => activity as never),
      onOfficeChanged: (cb: () => void) => {
        changed = cb;
      },
    };
    const office = initOffice({
      root,
      api,
      open: () => undefined,
      openTab: () => undefined,
      running: () => new Set<string>(),
      onHands,
      measure: () => ({ width: 1160, height: 848 }),
      tickMs: 1_000_000,
    });
    office.setProjects(["alpha"]);
    office.setWorkspace({
      tabs: [tab("t1", "alpha", { kind: "terminal" })],
      activeTabId: undefined,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onHands).toHaveBeenLastCalledWith(0);
    (activity.panes as Record<string, unknown>)["t1"] = { agent: "Codex", state: "question" };
    changed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onHands).toHaveBeenLastCalledWith(1);
    expect(root.querySelectorAll(".office-seat")).toHaveLength(0);
    root.hidden = false;
    office.show();
    expect(root.querySelectorAll(".office-seat")).toHaveLength(1);
    office.dispose();
  });
});
