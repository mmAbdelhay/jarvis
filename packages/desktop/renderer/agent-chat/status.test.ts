// @vitest-environment jsdom
//
// The status strip under the composer, and the Limits section of the panel.
import { beforeEach, describe, expect, it } from "vitest";
import { agentView, open, settle, t } from "./fixture.js";

beforeEach(() => {
  document.body.replaceChildren();
});

const status = (extra: object = {}) =>
  agentView({
    status: {
      lines: ["work-account someone@example.com", "[user@host:/repo (main)] [Haiku 5.5]"],
      limits: [
        { label: "Session", usedPercent: 13, resets: "04:20" },
        { label: "Week", usedPercent: 83, resets: "Wed 22:00" },
        { label: "5h", usedPercent: 97 },
        { label: "Plan", usedPercent: 4, detail: "1,029/21,900" },
      ],
      ...extra,
    },
  });

const width = (host: HTMLElement, px: number) =>
  Object.defineProperty(host, "clientWidth", { configurable: true, get: () => px });

describe("the status strip", () => {
  it("sits directly under the composer, limits first, with a level in words", async () => {
    const s = await open(status());
    const strip = s.q<HTMLElement>(".ac-status");
    expect(strip.hidden).toBe(false);
    expect(strip.previousElementSibling).toBe(s.q(".ac-composer"));
    const chips = [...strip.querySelectorAll<HTMLElement>(".ac-limit")];
    expect(chips.map((c) => c.dataset["level"])).toEqual(["ok", "warn", "danger", "ok"]);
    expect(chips[0]?.textContent).toContain("Session");
    expect(chips[0]?.textContent).toContain("13%");
    expect(chips[0]?.title).toBe("Session 13% used, resets 04:20");
    expect(chips[1]?.textContent).toContain(t("agentChatLimitHigh"));
    expect(chips[2]?.textContent).toContain(t("agentChatLimitAlmostOut"));
    expect(chips[3]?.title).toBe("Plan 4% used, 1,029/21,900");
    const bar = chips[1]?.querySelector("[role='progressbar']");
    expect(bar?.getAttribute("aria-valuenow")).toBe("83");
    expect(bar?.getAttribute("aria-label")).toBe("83% used");
    expect(strip.compareDocumentPosition(s.q(".agent-chat__note")) & 2).toBeTruthy();
  });

  it("shows the raw lines as selectable, tooltipped text, two rows then More", async () => {
    const lines = ["one", "two", "three", "four"];
    const s = await open(status({ lines }));
    const rows = () => [...s.host.querySelectorAll<HTMLElement>(".ac-status__line")];
    expect(rows().map((r) => r.textContent)).toEqual(["one", "two"]);
    expect(rows()[0]?.title).toBe("one");
    expect(rows()[0]?.dir).toBe("auto");
    const more = s.q<HTMLButtonElement>(".ac-status__more");
    expect(more.textContent).toBe(t("agentChatStatusMore"));
    more.click();
    expect(rows().map((r) => r.textContent)).toEqual(lines);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(more.textContent).toBe(t("agentChatStatusLess"));
  });

  it("updates in place: the same nodes stay when the numbers change", async () => {
    const s = await open(status());
    const chip = s.q<HTMLElement>(".ac-limit");
    const line = s.q<HTMLElement>(".ac-status__line");
    s.current.view = status({
      lines: ["work-account someone@example.com", "changed"],
      limits: [{ label: "Session", usedPercent: 99, resets: "05:00" }],
    });
    s.chat.refresh();
    await settle();
    expect(s.q(".ac-limit")).toBe(chip);
    expect(s.q(".ac-status__line")).toBe(line);
    expect(chip.dataset["level"]).toBe("danger");
    expect(chip.textContent).toContain("99%");
    expect(s.host.querySelectorAll(".ac-limit")).toHaveLength(1);
  });

  it("never turns the agent's text into markup, and is hidden when there is nothing", async () => {
    const s = await open(
      status({
        lines: ["<img src=x onerror=alert(1)>"],
        limits: [{ label: "<b>x</b>", usedPercent: 5, resets: "<i>" }],
      }),
    );
    expect(s.host.querySelector(".ac-status img, .ac-status b, .ac-status i")).toBeNull();
    s.current.view = agentView();
    s.chat.refresh();
    await settle();
    expect(s.q<HTMLElement>(".ac-status").hidden).toBe(true);
  });

  it("marks a kept (stale) status", async () => {
    const s = await open(status({ stale: true }));
    expect(s.q<HTMLElement>(".ac-status").dataset["stale"]).toBe("true");
  });
});

describe("the Limits section", () => {
  it("is first in the side panel, with the same data in full", async () => {
    const s = await open(status());
    const side = s.q<HTMLElement>(".ac-side");
    const titles = [...side.querySelectorAll(".ac-section__title")].map((n) => n.textContent);
    expect(titles[0]).toBe(t("agentChatPanelLimits"));
    const section = s.q<HTMLElement>('.ac-side [data-section="limits"]');
    expect(section.querySelectorAll("[role='progressbar']")).toHaveLength(4);
    expect(section.textContent).toContain("resets Wed 22:00");
    expect(section.textContent).toContain("1,029/21,900");
    expect(section.textContent).toContain("work-account someone@example.com");
  });

  it("is a chip in a narrow pane that opens the same section", async () => {
    const s = await open(agentView());
    width(s.host, 700);
    s.current.view = status();
    s.chat.refresh();
    await settle();
    const chip = s.q<HTMLButtonElement>('.ac-chip[data-section="limits"]');
    expect(chip.textContent).toBe(`${t("agentChatChipLimits")} 97%`);
    chip.click();
    expect(s.q(".ac-popover").querySelectorAll("[role='progressbar']")).toHaveLength(4);
  });
});
