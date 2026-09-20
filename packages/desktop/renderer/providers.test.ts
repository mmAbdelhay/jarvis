// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStatus, RateWindow } from "@jarvis/core";
import { remainingPercent as coreRemainingPercent } from "@jarvis/core";
import {
  remainingPercent as rendererRemainingPercent,
  renderProviders,
  wireProvidersPanel,
} from "./providers.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { formatAgo } from "./format.js";

const NOW = Date.parse("2026-08-31T12:20:00.000Z");

function layoutDom(): void {
  document.body.innerHTML = "";
  for (const id of ["providers", "providers-refresh", "providers-panel", "providers-head"]) {
    const el = document.createElement(id === "providers-refresh" ? "button" : "div");
    el.id = id;
    document.body.append(el);
  }
}

function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    id: "claude-main",
    vendor: "anthropic",
    capacity: {
      state: "known",
      primary: { usedPercent: 62, resetsAt: "2026-08-31T14:30:00.000Z" },
      secondary: undefined,
      readAt: Date.parse("2026-08-31T12:12:00.000Z"),
    },
    health: { state: "ok", detail: "All Systems Operational", readAt: NOW },
    ...overrides,
  };
}

beforeEach(layoutDom);

describe("renderProviders", () => {
  it("shows the account id and the percentage LEFT, not the percentage used", () => {
    renderProviders([status()], NOW);
    const row = document.querySelector(".provider");
    expect(row?.textContent).toContain("claude-main");
    expect(row?.textContent).toContain("38%");
    expect(row?.textContent).not.toContain("62%");
  });

  it("sizes the meter to what is left", () => {
    renderProviders([status()], NOW);
    const fill = document.querySelector(".provider .fill");
    expect(fill instanceof HTMLElement && fill.style.width).toBe("38%");
  });

  it("renders a known zero as a real number WITH a meter", () => {
    renderProviders(
      [
        status({
          capacity: {
            state: "known",
            primary: { usedPercent: 100, resetsAt: "2026-08-31T14:30:00.000Z" },
            secondary: undefined,
            readAt: NOW,
          },
        }),
      ],
      NOW,
    );
    expect(document.querySelector(".provider__value")?.textContent).toBe("0%");
    expect(document.querySelector(".provider .bar")).not.toBeNull();
    expect(
      document.querySelector(".provider__value")?.classList.contains("provider__value--empty"),
    ).toBe(true);
  });

  it("renders an unknown as an em dash with NO meter at all", () => {
    renderProviders([status({ capacity: { state: "unknown", reason: "unsupported" } })], NOW);
    expect(document.querySelector(".provider__value")?.textContent).toBe("—");
    // The absence of the meter is the signal. An empty bar would read as 0%,
    // and "unknown" must never look like "none left" (ruling P21's shape).
    expect(document.querySelector(".provider .bar")).toBeNull();
  });

  // Deviation from the task brief's draft (documented in the task report):
  // the brief's needles ("no capacity reading", "couldn't be read", "not
  // checked yet") are the ENGLISH forms of these messages, but this panel
  // renders through PRIMARY_LANGUAGE, which is Arabic ("ar") — the whole
  // app's convention (see app.ts's history-count badge, changes.ts
  // throughout) and the global brief's own "do not open an English-only
  // lane" rule. Rendering English here to satisfy the literal needles would
  // violate that rule, so the needles below are the Arabic forms of the
  // same three MESSAGES entries instead — same test intent (three reasons,
  // three distinctly worded notes), matching what the panel actually shows.
  it("says which kind of unknown it is", () => {
    for (const [reason, needle] of [
      ["unsupported", MESSAGES.capacityUnsupported(PRIMARY_LANGUAGE)],
      ["unavailable", MESSAGES.capacityUnavailable(PRIMARY_LANGUAGE)],
      ["never-read", MESSAGES.capacityNeverRead(PRIMARY_LANGUAGE)],
    ] as const) {
      layoutDom();
      renderProviders([status({ capacity: { state: "unknown", reason } })], NOW);
      expect(document.querySelector(".provider__note")?.textContent).toContain(needle);
    }
  });

  it("dates every known reading with an absolute clock time", () => {
    renderProviders([status()], NOW);
    expect(document.querySelector(".provider__note")?.textContent).toMatch(/\d{2}:\d{2}/);
  });

  it("shows a reset more than a day away as a day, not a clock (Copilot's monthly window)", () => {
    const monthly = status({
      capacity: {
        state: "known",
        primary: { usedPercent: 1, resetsAt: new Date(NOW + 9 * 24 * 60 * 60_000).toISOString() },
        secondary: undefined,
        readAt: NOW,
      },
    });
    renderProviders([monthly], NOW);
    const expected = new Date(NOW + 9 * 24 * 60 * 60_000).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
    expect(document.querySelector(".provider__note")?.textContent).toContain(expected);
  });

  it("marks a reading older than 30 minutes as stale, with its age", () => {
    const old = status({
      capacity: {
        state: "known",
        primary: { usedPercent: 62, resetsAt: "2026-08-31T14:30:00.000Z" },
        secondary: undefined,
        readAt: NOW - 90 * 60_000,
      },
    });
    renderProviders([old], NOW);
    const note = document.querySelector(".provider__note");
    expect(note?.classList.contains("provider__note--stale")).toBe(true);
    // Reuses formatAgo, which is already bilingual and P30-correct — so
    // this asserts through it rather than against one language's literal.
    expect(note?.textContent).toContain(formatAgo(NOW - 90 * 60_000, NOW, PRIMARY_LANGUAGE));
  });

  it("colours the health dot by state and never drops the row when health is unknown", () => {
    renderProviders(
      [
        status({ health: { state: "outage", detail: "Major Outage", readAt: NOW } }),
        status({ id: "copilot", health: { state: "unknown", detail: "", readAt: undefined } }),
      ],
      NOW,
    );
    const dots = document.querySelectorAll(".provider .dot");
    expect(dots).toHaveLength(2);
    expect(dots[0]?.classList.contains("dot--outage")).toBe(true);
    expect(dots[1]?.classList.contains("dot--unknown")).toBe(true);
  });

  it("builds every node with createElement — no markup is ever assigned as text", () => {
    renderProviders([status({ id: "<img src=x onerror=alert(1)>" })], NOW);
    expect(document.querySelector("#providers img")).toBeNull();
    expect(document.querySelector(".provider__id")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });

  it("says so plainly when no accounts are configured", () => {
    renderProviders([], NOW);
    expect(document.querySelector("#providers")?.textContent).toContain(
      MESSAGES.providersEmpty(PRIMARY_LANGUAGE),
    );
  });
});

// Controller ruling S1: the renderer cannot import a VALUE from
// @jarvis/core (no bundler — a bare specifier fails to resolve when
// index.html loads app.js as a plain ES module), so remainingPercent is
// re-implemented locally rather than imported. Duplication is forced, not
// chosen — but two copies of one arithmetic rule can silently diverge, so
// this test imports BOTH implementations side by side and asserts they
// agree on every input, including core's floor (ruling S11).
describe("remainingPercent — core and the renderer's local copy agree (ruling S1)", () => {
  const table: Array<{ label: string; window: RateWindow }> = [
    {
      label: "0% used (100% left)",
      window: { usedPercent: 0, resetsAt: "2026-08-31T14:30:00.000Z" },
    },
    {
      label: "100% used (0% left)",
      window: { usedPercent: 100, resetsAt: "2026-08-31T14:30:00.000Z" },
    },
    {
      label: "a fractional usedPercent (62.5), which must floor rather than round",
      window: { usedPercent: 62.5, resetsAt: "2026-08-31T14:30:00.000Z" },
    },
    {
      // "A missing window": a provider-reported value outside the 0-100
      // contract the type promises but the wire format does not enforce —
      // the same defensive case both implementations clamp before
      // flooring, exercised here because it is exactly the kind of input
      // where two independently-written clamp expressions are most likely
      // to diverge.
      label: "usedPercent outside the documented 0-100 range (missing/bad reading)",
      window: { usedPercent: 140, resetsAt: "2026-08-31T14:30:00.000Z" },
    },
  ];

  it.each(table)("agrees for $label", ({ window }) => {
    expect(rendererRemainingPercent(window)).toBe(coreRemainingPercent(window));
  });

  it("both floor a fractional result down, never up", () => {
    const window = { usedPercent: 62.5, resetsAt: "2026-08-31T14:30:00.000Z" };
    expect(coreRemainingPercent(window)).toBe(37);
    expect(rendererRemainingPercent(window)).toBe(37);
  });
});

describe("wireProvidersPanel", () => {
  it("asks the main process for a refresh when the refresh control is clicked", () => {
    const refreshProviders = vi.fn(async () => {});
    Object.defineProperty(window, "jarvis", { value: { refreshProviders }, configurable: true });

    wireProvidersPanel();
    document.getElementById("providers-refresh")?.click();

    expect(refreshProviders).toHaveBeenCalledTimes(1);
  });

  it("collapses and expands the panel from its header", () => {
    Object.defineProperty(window, "jarvis", {
      value: { refreshProviders: async () => {} },
      configurable: true,
    });
    wireProvidersPanel();
    const panel = document.getElementById("providers-panel");

    document.getElementById("providers-head")?.click();
    expect(panel?.classList.contains("providers-panel--collapsed")).toBe(true);

    document.getElementById("providers-head")?.click();
    expect(panel?.classList.contains("providers-panel--collapsed")).toBe(false);
  });
});
