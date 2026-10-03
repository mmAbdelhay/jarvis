import { describe, expect, it } from "vitest";
import type { CapacityCard } from "./home-capacity";
import { STRINGS } from "./i18n";
import { ICONS } from "./icon-paths";
import {
  activeNavKey,
  capacityRows,
  navBadge,
  sidebarCard,
  sidebarMode,
  waitingCountOf,
  wideNavItems,
} from "./wide-shell-model";

describe("wideNavItems", () => {
  it("lists the desktop order with routes", () => {
    const items = wideNavItems("en");
    expect(items.map((item) => item.key)).toEqual([
      "dashboard",
      "sessions",
      "workspace",
      "changes",
      "history",
      "voice",
      "settings",
    ]);
    expect(items.map((item) => item.href)).toEqual([
      "/dashboard",
      "/sessions",
      "/workspace",
      "/changes",
      "/history",
      "/voice",
      "/settings",
    ]);
    expect(items[0]?.label).toBe("Home");
  });

  it("uses the Arabic labels in ar", () => {
    const items = wideNavItems("ar");
    expect(items.map((item) => item.label)).toEqual([
      STRINGS["nav.dashboard"].ar,
      STRINGS["nav.sessions"].ar,
      STRINGS["nav.workspace"].ar,
      STRINGS["nav.changes"].ar,
      STRINGS["nav.history"].ar,
      STRINGS["nav.voice"].ar,
      STRINGS["nav.settings"].ar,
    ]);
    for (const item of items) expect(item.label).toMatch(/^[؀-ۿ\s]+$/);
  });
});

describe("wideNavItems icons", () => {
  it("gives every nav item an icon that exists", () => {
    for (const item of wideNavItems("en")) expect(ICONS).toHaveProperty(item.icon);
  });
});

describe("activeNavKey", () => {
  it("derives the active item from the pathname", () => {
    expect(activeNavKey("/sessions?id=x")).toBe("sessions");
    expect(activeNavKey("/settings")).toBe("settings");
    expect(activeNavKey("/dashboard")).toBe("dashboard");
    expect(activeNavKey("/workspace")).toBe("workspace");
    expect(activeNavKey("/voice")).toBe("voice");
  });

  it("maps detail routes to their owning section", () => {
    expect(activeNavKey("/session/abc")).toBe("sessions");
    expect(activeNavKey("/terminal/pane-1")).toBe("workspace");
    expect(activeNavKey("/docker/jarvis")).toBe("workspace");
    expect(activeNavKey("/history")).toBe("history");
    expect(activeNavKey("/transcript/abc")).toBe("history");
    expect(activeNavKey("/changes")).toBe("changes");
  });

  it("has no active item for an unknown route", () => {
    expect(activeNavKey("/unlock")).toBeUndefined();
  });
});

describe("sidebarMode", () => {
  it("is a rail when compact or in the workspace, full otherwise", () => {
    expect(sidebarMode({ compact: true, section: "dashboard" })).toBe("rail");
    expect(sidebarMode({ compact: false, section: "workspace" })).toBe("rail");
    expect(sidebarMode({ compact: false, section: "sessions" })).toBe("full");
    expect(sidebarMode({ compact: false, section: undefined })).toBe("full");
  });
});

describe("navBadge", () => {
  it("shows a number only for sessions above zero", () => {
    expect(navBadge("sessions", 2)).toBe(2);
    expect(navBadge("sessions", 0)).toBeUndefined();
    expect(navBadge("history", 3)).toBeUndefined();
  });
});

describe("waitingCountOf", () => {
  it("counts waiting sessions and ignores external ones", () => {
    expect(
      waitingCountOf([
        { state: "waiting" },
        { state: "waiting", origin: "jarvis" },
        { state: "waiting", origin: "external" },
        { state: "running" },
      ]),
    ).toBe(2);
  });
});

const CARD: CapacityCard = { id: "Claude", window: "5h", left: 62, resetsAt: 1 };

describe("sidebarCard", () => {
  it("shows the capacity card except on Home or without capacity", () => {
    expect(sidebarCard("sessions", [CARD])).toBe("capacity");
    expect(sidebarCard("dashboard", [CARD])).toBeUndefined();
    expect(sidebarCard("sessions", [])).toBeUndefined();
  });
});

describe("capacityRows", () => {
  it("labels the account and window, and picks the bar tone", () => {
    const rows = capacityRows(
      [CARD, { id: "Copilot", window: "month", left: 80, resetsAt: 1 }],
      "en",
    );
    expect(rows).toEqual([
      { id: "Claude", label: "Claude 5h", percent: 62, tone: "accent" },
      { id: "Copilot", label: "Copilot month", percent: 80, tone: "success" },
    ]);
    expect(capacityRows([CARD], "ar")[0]?.label).not.toBe("Claude 5h");
  });
});
