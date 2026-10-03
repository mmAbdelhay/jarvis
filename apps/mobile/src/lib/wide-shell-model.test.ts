import type { SystemMetrics } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import type { ConnectionView } from "./connection-store";
import { STRINGS } from "./i18n";
import {
  activeNavKey,
  clockText,
  runningCountOf,
  shellLaptopName,
  topBarModel,
  wideNavItems,
} from "./wide-shell-model";

const METRICS: SystemMetrics = {
  cpuPercent: 12.4,
  memoryUsedBytes: 8,
  memoryTotalBytes: 16,
  diskUsedBytes: 1,
  diskTotalBytes: 4,
  networkDownMbps: 84.25,
  networkUpMbps: 0,
  uptimeSeconds: 100,
};
const OPEN: ConnectionView = { state: "open", stale: false };

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

describe("topBarModel", () => {
  it("hides the metrics when compact", () => {
    const model = topBarModel({
      metrics: METRICS,
      runningCount: 2,
      connection: OPEN,
      compact: true,
    });
    expect(model.showMetrics).toBe(false);
  });

  it("keeps only the connection dot when compact so the bar never overlaps the nav", () => {
    const compact = topBarModel({ runningCount: 0, connection: OPEN, compact: true });
    const full = topBarModel({ runningCount: 0, connection: OPEN, compact: false });
    expect(compact.showPillLabel).toBe(false);
    expect(full.showPillLabel).toBe(true);
  });

  it("formats the readout when not compact", () => {
    const model = topBarModel({
      metrics: METRICS,
      runningCount: 2,
      connection: OPEN,
      compact: false,
    });
    expect(model.showMetrics).toBe(true);
    expect(model.readout).toEqual({
      cpu: "12%",
      ram: "50%",
      disk: "25%",
      net: "↓84.3 ↑0.0 Mbps",
    });
  });

  it("shows placeholders while metrics are unknown", () => {
    const model = topBarModel({ runningCount: 0, connection: OPEN, compact: false });
    expect(model.readout).toEqual({ cpu: "--%", ram: "--%", disk: "--%", net: "↓0.0 ↑0.0 Mbps" });
  });

  it("dims the running pill at zero and reuses the connection pill", () => {
    const model = topBarModel({
      runningCount: 0,
      connection: { state: "reconnecting", stale: false },
      compact: false,
    });
    expect(model.running).toEqual({ count: 0, idle: true });
    expect(model.pill).toEqual({ key: "conn.reconnecting", tone: "warning" });
  });
});

describe("topBarModel laptop name", () => {
  it("shows the paired laptop's name, trimmed", () => {
    const model = topBarModel({
      runningCount: 0,
      connection: OPEN,
      compact: false,
      laptopName: "  Studio Mac ",
    });
    expect(model.laptopName).toBe("Studio Mac");
  });

  it("hides a missing or blank name", () => {
    expect(topBarModel({ runningCount: 0, connection: OPEN, compact: false }).laptopName).toBe(
      undefined,
    );
    expect(
      topBarModel({ runningCount: 0, connection: OPEN, compact: false, laptopName: "  " })
        .laptopName,
    ).toBe(undefined);
  });

  it("keeps the name when compact, in a narrower slot", () => {
    const compact = topBarModel({
      runningCount: 0,
      connection: OPEN,
      compact: true,
      laptopName: "M",
    });
    const full = topBarModel({
      runningCount: 0,
      connection: OPEN,
      compact: false,
      laptopName: "M",
    });
    expect(compact.laptopName).toBe("M");
    expect(compact.laptopNameMaxWidth).toBeLessThan(full.laptopNameMaxWidth);
  });
});

describe("runningCountOf", () => {
  it("counts starting, running and waiting sessions", () => {
    expect(
      runningCountOf([
        { state: "starting" },
        { state: "running" },
        { state: "waiting" },
        { state: "done" },
        { state: "dead" },
      ]),
    ).toBe(3);
  });
});

describe("clockText", () => {
  it("shows 24-hour minutes", () => {
    expect(clockText(new Date(2026, 8, 28, 7, 5, 59))).toBe("07:05");
    expect(clockText(new Date(2026, 8, 28, 18, 12))).toBe("18:12");
  });
});

describe("shellLaptopName", () => {
  it("uses the laptop's display name when the pairing record has one", () => {
    expect(shellLaptopName({ laptopName: "Studio Mac", name: "studio.tail1.ts.net" })).toBe(
      "Studio Mac",
    );
  });

  it("falls back to the machine label of the certificate name (what pairing stores today)", () => {
    expect(shellLaptopName({ name: "e1089167.tailfee19e.ts.net" })).toBe("e1089167");
  });

  it("shows nothing for a pinned (IP) pairing with no name", () => {
    expect(shellLaptopName({})).toBeUndefined();
    expect(shellLaptopName(undefined)).toBeUndefined();
  });
});
