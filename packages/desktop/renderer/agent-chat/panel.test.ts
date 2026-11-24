// @vitest-environment jsdom
//
// The side panel and, in a narrow pane, the chips above the composer.
import { beforeEach, describe, expect, it } from "vitest";
import { fileIconFor } from "../file-icons.js";
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
    const titles = [...side.querySelectorAll(".ac-section__title")].map((n) => n.textContent);
    expect(titles).toEqual(["To-do, 2 of 4", "Sub-agents", "Changed files", "Context, 62% left"]);
    expect(side.querySelector(".ac-agent")?.textContent).toContain("Check other totals");
    expect(side.querySelector(".ac-agent__state")?.textContent).toBe("Running 0s");
    const files = [...side.querySelectorAll<HTMLButtonElement>(".ac-file")];
    expect(files.map((f) => f.textContent)).toEqual(["total.js+2−1", "total.test.js+18"]);
    expect(files.map((f) => f.querySelector(".file-icon")?.getAttribute("src"))).toEqual([
      `vendor/material-icons/icons/${fileIconFor("total.js")}`,
      `vendor/material-icons/icons/${fileIconFor("total.test.js")}`,
    ]);
    expect(side.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("38");
    expect(side.querySelectorAll(".ac-todo--done")).toHaveLength(2);
  });

  it("hides a section with no data, and the whole panel when there is none", async () => {
    const some = await open(agentView({ context: { used: 5000 } }));
    expect(
      [...some.host.querySelectorAll(".ac-side .ac-section__title")].map((n) => n.textContent),
    ).toEqual(["Context, 5k tokens used"]);
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
  });

  it("labels the panel for a screen reader", async () => {
    const s = await open(data());
    expect(s.q(".ac-side").getAttribute("aria-label")).toBe(t("agentChatPanelLabel"));
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
    expect(chips).toEqual(["To-do 2 of 4", "Sub-agents 1", "Changed files 2", "Context 62%"]);
    expect(s.q<HTMLElement>(".ac-panel-toggle").hidden).toBe(true);
  });

  it("opens the same section in a popover, closes on a second click and on Escape", async () => {
    const s = await narrow();
    const chip = s.q<HTMLButtonElement>('.ac-chip[data-section="todo"]');
    chip.click();
    const popover = s.q<HTMLElement>(".ac-popover");
    expect(popover.hidden).toBe(false);
    expect(popover.querySelector(".ac-section__title")?.textContent).toBe("To-do, 2 of 4");
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

  it("returns to the panel when the pane widens", async () => {
    const s = await narrow();
    width(s.host, 1400);
    s.chat.refresh();
    await settle();
    expect(s.q<HTMLElement>(".ac-side").hidden).toBe(false);
    expect(s.q<HTMLElement>(".ac-chips").hidden).toBe(true);
  });
});
