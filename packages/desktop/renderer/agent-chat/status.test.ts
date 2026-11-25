// @vitest-environment jsdom
//
// The status row under the composer, and the panel sections that carry the
// same data in full: usage limits, context, the session and the raw rows.
import { beforeEach, describe, expect, it } from "vitest";
import { agentView, open, settle, t } from "./fixture.js";

beforeEach(() => {
  document.body.replaceChildren();
});

const details = {
  account: "work-account",
  folder: "/repo/app",
  branch: "main",
  model: "Haiku 5.5",
  context: { usedPercent: 6, usedText: "64k", totalText: "1000k" },
};

const status = (extra: object = {}) =>
  agentView({
    status: {
      lines: [
        "work-account someone@example.com",
        "[user@host:/repo/app (main)] [Haiku 5.5 ctx:6%]",
      ],
      limits: [
        { label: "Session", usedPercent: 13, resets: "04:20" },
        { label: "Week", usedPercent: 83, resets: "Wed 22:00" },
        { label: "5h", usedPercent: 97, resets: "23:10" },
        { label: "Plan", usedPercent: 4, detail: "1,029/21,900" },
      ],
      details,
      ...extra,
    },
  });

const width = (host: HTMLElement, px: number) =>
  Object.defineProperty(host, "clientWidth", { configurable: true, get: () => px });

describe("the status row", () => {
  it("is one row under the composer: who on the left, each limit on the right", async () => {
    const s = await open(status());
    const strip = s.q<HTMLElement>(".ac-status");
    expect(strip.hidden).toBe(false);
    expect(strip.previousElementSibling).toBe(s.q(".ac-composer"));
    expect(s.q(".ac-status__who").textContent).toBe("work-account · main");
    const chips = [...strip.querySelectorAll<HTMLElement>(".ac-limit")];
    expect(chips.map((c) => c.dataset["level"])).toEqual(["ok", "warn", "danger", "ok"]);
    expect(chips[0]?.textContent).toBe("Session13%");
    expect(chips[0]?.title).toBe("Session 13% used, resets 04:20");
    expect(chips[0]?.getAttribute("aria-label")).toBe("Session 13% used, resets 04:20");
    expect(chips[1]?.textContent).toContain("83%");
    expect(chips[1]?.textContent).toContain("resets Wed 22:00");
    expect(chips[1]?.textContent).toContain(t("agentChatLimitHigh"));
    expect(chips[2]?.textContent).toContain(t("agentChatLimitAlmostOut"));
    expect(chips[3]?.title).toBe("Plan 4% used, 1,029/21,900");
    expect(chips[3]?.textContent).not.toContain("resets");
    const bar = chips[1]?.querySelector("[role='progressbar']");
    expect(bar?.getAttribute("aria-valuenow")).toBe("83");
    expect(strip.querySelector(".ac-status__line, .ac-status__more")).toBeNull();
  });

  it("names the account by its short name and the folder only without a branch", async () => {
    const s = await open(
      status({ details: { account: "someone@example.com", folder: "/repo/app" } }),
    );
    expect(s.q(".ac-status__who").textContent).toBe("someone · app");
    expect(s.q<HTMLElement>(".ac-status__who").title).toContain("/repo/app");
  });

  it("updates in place: the same nodes stay when the numbers change", async () => {
    const s = await open(status());
    const chip = s.q<HTMLElement>(".ac-limit");
    const who = s.q<HTMLElement>(".ac-status__who");
    s.current.view = status({
      limits: [{ label: "Session", usedPercent: 99, resets: "05:00" }],
      details: { ...details, branch: "dev" },
    });
    s.chat.refresh();
    await settle();
    expect(s.q(".ac-limit")).toBe(chip);
    expect(s.q(".ac-status__who")).toBe(who);
    expect(who.textContent).toBe("work-account · dev");
    expect(chip.dataset["level"]).toBe("danger");
    expect(chip.textContent).toContain("99%");
    expect(s.host.querySelectorAll(".ac-limit")).toHaveLength(1);
  });

  it("never turns the agent's text into markup", async () => {
    const s = await open(
      status({
        lines: ["<img src=x onerror=alert(1)>"],
        limits: [{ label: "<b>x</b>", usedPercent: 5, resets: "<i>" }],
        details: { account: "<u>a</u>" },
      }),
    );
    expect(
      s.host.querySelector(".ac-status img, .ac-status b, .ac-status i, .ac-status u"),
    ).toBeNull();
  });

  it("is absent when nothing is known, even with raw rows nobody could read", async () => {
    const s = await open(status());
    s.current.view = agentView({ status: { lines: ["raw only"], limits: [], details: {} } });
    s.chat.refresh();
    await settle();
    expect(s.q<HTMLElement>(".ac-status").hidden).toBe(true);
    s.current.view = agentView();
    s.chat.refresh();
    await settle();
    expect(s.q<HTMLElement>(".ac-status").hidden).toBe(true);
  });

  it("marks a kept (stale) status", async () => {
    const s = await open(status({ stale: true }));
    expect(s.q<HTMLElement>(".ac-status").dataset["stale"]).toBe("true");
  });

  it("opens the side panel from a limit, even after it was hidden", async () => {
    const s = await open(status());
    s.q<HTMLButtonElement>(".ac-hide-panel").click();
    expect(s.q<HTMLElement>(".ac-side").hidden).toBe(true);
    s.q<HTMLButtonElement>(".ac-limit").click();
    expect(s.q<HTMLElement>(".ac-side").hidden).toBe(false);
  });

  it("opens the limits popover in a narrow pane", async () => {
    const s = await open(agentView());
    width(s.host, 700);
    s.current.view = status();
    s.chat.refresh();
    await settle();
    expect(s.host.querySelector('.ac-chip[data-section="limits"]')).toBeNull();
    s.q<HTMLButtonElement>(".ac-limit").click();
    const pop = s.q<HTMLElement>(".ac-popover");
    expect(pop.hidden).toBe(false);
    expect(pop.querySelectorAll("[role='progressbar']")).toHaveLength(4);
  });
});

describe("the context in the status row", () => {
  const ctx = (extra: object = {}) => agentView(extra);
  it("shows alone, with nothing else known, and not when nothing is", async () => {
    const s = await open(ctx({ context: { used: 38000, leftPercent: 62 } }));
    expect(s.q<HTMLElement>(".ac-status").hidden).toBe(false);
    expect(s.q<HTMLElement>(".ac-status__who").hidden).toBe(true);
    expect(s.q<HTMLElement>(".ac-status .ac-context").hidden).toBe(false);
    s.current.view = agentView();
    s.chat.refresh();
    await settle();
    expect(s.q<HTMLElement>(".ac-status").hidden).toBe(true);
  });
  it("sits first beside the limits in the same chip style, with a level and its words", async () => {
    const s = await open({
      ...status({ details: { account: "a", context: { usedPercent: 83 } } }),
    });
    const chip = s.q<HTMLElement>(".ac-status__limits .ac-context");
    expect(chip.parentElement?.firstElementChild).toBe(chip);
    expect(chip.dataset["level"]).toBe("warn");
    expect(chip.textContent).toContain(t("agentChatLimitHigh"));
    expect(chip.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("83");
    expect(chip.querySelector(".ac-meter")).not.toBeNull();
  });
  it("keeps its node when the number changes, so the row never jumps", async () => {
    const s = await open(ctx({ context: { used: 1, leftPercent: 90 } }));
    const chip = s.q<HTMLElement>(".ac-context");
    s.current.view = ctx({ context: { used: 2, leftPercent: 40 } });
    s.chat.refresh();
    await settle();
    expect(s.q(".ac-context")).toBe(chip);
    expect(chip.textContent).toContain("40% left");
  });
  it("opens the panel's Context section", async () => {
    const s = await open(ctx({ context: { used: 38000, leftPercent: 62 } }));
    s.q<HTMLButtonElement>(".ac-hide-panel").click();
    s.q<HTMLButtonElement>(".ac-context").click();
    expect(s.q<HTMLElement>(".ac-side").hidden).toBe(false);
  });
  it("opens the Context popover in a narrow pane", async () => {
    const s = await open(agentView());
    width(s.host, 700);
    s.current.view = ctx({ context: { used: 38000, leftPercent: 62 } });
    s.chat.refresh();
    await settle();
    s.q<HTMLButtonElement>(".ac-context").click();
    expect(s.q<HTMLElement>(".ac-popover").hidden).toBe(false);
    expect(
      s.q<HTMLElement>(".ac-popover").dataset["section"] ?? s.q(".ac-popover").innerHTML,
    ).toBeTruthy();
  });
});

describe("the status sections of the panel", () => {
  it("pin context then limits above the work, then session and the raw rows", async () => {
    const s = await open({
      ...status(),
      context: { used: 38000, leftPercent: 62 },
      todos: [{ text: "a", state: "open" }],
    });
    const side = s.q<HTMLElement>(".ac-side");
    const kinds = [...side.querySelectorAll<HTMLElement>("section, details")].map(
      (n) => n.dataset["section"],
    );
    expect(kinds).toEqual(["context", "limits", "todo", "session", "raw"]);
    const pinned = [...side.querySelectorAll<HTMLElement>(".ac-side__pin [data-section]")];
    expect(pinned.map((n) => n.dataset["section"])).toEqual(["context", "limits"]);
    const limits = s.q<HTMLElement>('.ac-side [data-section="limits"]');
    expect(limits.querySelector(".ac-section__title")?.textContent).toBe(t("agentChatPanelLimits"));
    expect(limits.querySelectorAll("[role='progressbar']")).toHaveLength(4);
    expect(limits.textContent).toContain("resets Wed 22:00");
  });

  it("shows the context as a heading, a right-aligned value and a bar of what is used", async () => {
    const s = await open(status());
    const section = s.q<HTMLElement>('.ac-side [data-section="context"]');
    expect(section.querySelector(".ac-section__title")?.textContent).toBe("Context");
    expect(section.querySelector(".ac-section__value")?.textContent).toBe("6% used");
    expect(section.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("6");
    const chip = s.q<HTMLElement>(".ac-context");
    expect(chip.getAttribute("aria-label")).toBe("Context 6% used");
    expect(chip.textContent).toBe("Context6%");
  });

  it("keeps the left wording when the screen gives no statusline context", async () => {
    const s = await open({
      ...status({ details: { account: "a" } }),
      context: { used: 38000, leftPercent: 62 },
    });
    const chip = s.q<HTMLElement>(".ac-context");
    expect(chip.getAttribute("aria-label")).toBe("Context 62% left");
    expect(chip.textContent).toBe("Context62% left");
    // A figure that says "left" is not a used percent: no meter, no warning colour.
    expect(chip.dataset["level"]).toBe("ok");
    expect(chip.querySelector("[role='progressbar']")).toBeNull();
    const section = s.q<HTMLElement>('.ac-side [data-section="context"]');
    expect(section.querySelector(".ac-section__value")?.textContent).toBe("62% left");
    expect(section.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("62");
  });

  it("lists the session as key and value rows, the folder cut to its last two parts", async () => {
    const s = await open(status({ details: { ...details, folder: "/home/me/code/app" } }));
    const rows = [
      ...s.host.querySelectorAll<HTMLElement>('.ac-side [data-section="session"] .ac-kv'),
    ];
    expect(rows.map((r) => r.textContent)).toEqual([
      "Accountwork-account",
      "Foldercode/app",
      "Branchmain",
      "ModelHaiku 5.5",
    ]);
    expect(rows[1]?.querySelector(".ac-kv__value")?.getAttribute("title")).toBe(
      "/home/me/code/app",
    );
  });

  it("keeps the raw rows in a closed section, and its open state across a refresh", async () => {
    const s = await open(status());
    const toggle = () =>
      s.q<HTMLButtonElement>('.ac-side [data-section="raw"] .ac-section__toggle');
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain(t("agentChatPanelRaw"));
    expect(s.q('.ac-side [data-section="raw"]').querySelectorAll(".ac-raw__line")).toHaveLength(2);
    expect(s.q<HTMLElement>('.ac-side [data-section="raw"] .ac-section__body').hidden).toBe(true);
    toggle().click();
    s.current.view = status({ lines: ["changed"] });
    s.chat.refresh();
    await settle();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(s.q<HTMLElement>('.ac-side [data-section="raw"] .ac-section__body').hidden).toBe(false);
  });

  it("leaves out a section with no data, and shows no empty Usage limits", async () => {
    const s = await open(agentView({ status: { lines: ["raw only"], limits: [], details: {} } }));
    const kinds = [...s.host.querySelectorAll<HTMLElement>(".ac-side section")].map(
      (n) => n.dataset["section"],
    );
    expect(kinds).toEqual(["raw"]);
  });
});
