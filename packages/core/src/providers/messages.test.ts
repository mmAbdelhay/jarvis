// Pinned so `clock()` in messages.ts (which formats with the host's local
// timezone) renders the same digits on every machine that runs this file —
// otherwise a whole-sentence `.toBe` assertion below would pass on the
// author's machine and fail in CI (or vice versa) purely from TZ drift.
// Vitest gives each test file its own worker (thread or fork), so this does
// not leak into other test files running in the same process.
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "./types.js";
import { capacityReportText, providerReportText, providerStatusLine } from "./messages.js";

/**
 * Duplicates messages.ts's private `clock()` formatting exactly, so the
 * literal digit strings pasted below (and asserted with `.toBe`) can be
 * sanity-checked against this helper without exporting a test-only symbol
 * from the production module. Both are `new Date(iso).toLocaleTimeString(
 * "en-GB", { hour: "2-digit", minute: "2-digit" })`.
 */
function clock(iso: string | number): string {
  const date = typeof iso === "number" ? new Date(iso) : new Date(iso);
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// --- capacity "known" fixtures, at several percentages -------------------

/** Ordinary case: 62% used, 38% remaining. */
const known: ProviderStatus = {
  id: "claude-main",
  vendor: "anthropic",
  capacity: {
    state: "known",
    fiveHour: { usedPercent: 62, resetsAt: "2026-08-31T14:30:00.000Z" },
    sevenDay: { usedPercent: 33, resetsAt: "2026-09-02T11:00:00.000Z" },
    readAt: Date.parse("2026-08-31T12:12:00.000Z"),
  },
  health: { state: "ok", detail: "All Systems Operational", readAt: 1 },
};

/** Edge case: 100% used, 0% remaining. */
const knownZeroRemaining: ProviderStatus = {
  id: "claude-zero",
  vendor: "anthropic",
  capacity: {
    state: "known",
    fiveHour: { usedPercent: 100, resetsAt: "2026-09-01T00:00:00.000Z" },
    sevenDay: undefined,
    readAt: Date.parse("2026-08-31T23:59:00.000Z"),
  },
  health: { state: "ok", detail: "", readAt: undefined },
};

/** Edge case: 0% used, 100% remaining. */
const knownFullRemaining: ProviderStatus = {
  id: "claude-full",
  vendor: "anthropic",
  capacity: {
    state: "known",
    fiveHour: { usedPercent: 0, resetsAt: "2026-09-02T09:05:00.000Z" },
    sevenDay: undefined,
    readAt: Date.parse("2026-08-31T08:00:00.000Z"),
  },
  health: { state: "ok", detail: "", readAt: undefined },
};

/**
 * A fractional `usedPercent` (62.5). Ruling S11: `remainingPercent` floors
 * rather than rounds, so 100 - 62.5 = 37.5 renders as "37%", never "38%" —
 * flooring never overstates what's left.
 */
const knownFractional: ProviderStatus = {
  id: "claude-half",
  vendor: "anthropic",
  capacity: {
    state: "known",
    fiveHour: { usedPercent: 62.5, resetsAt: "2026-08-31T18:45:00.000Z" },
    sevenDay: undefined,
    readAt: Date.parse("2026-08-31T17:30:00.000Z"),
  },
  health: { state: "ok", detail: "", readAt: undefined },
};

// --- capacity "unknown" fixtures, one per reason, health held at "ok" so
// the capacity clause is the only thing under test -------------------------

const capUnsupported: ProviderStatus = {
  id: "copilot-x",
  vendor: "github",
  capacity: { state: "unknown", reason: "unsupported" },
  health: { state: "ok", detail: "", readAt: undefined },
};

const capUnavailable: ProviderStatus = {
  id: "claude-unavail",
  vendor: "anthropic",
  capacity: { state: "unknown", reason: "unavailable" },
  health: { state: "ok", detail: "", readAt: undefined },
};

const capNeverRead: ProviderStatus = {
  id: "claude-never",
  vendor: "anthropic",
  capacity: { state: "unknown", reason: "never-read" },
  health: { state: "ok", detail: "", readAt: undefined },
};

// --- health fixtures, capacity held at `known`'s reading so the health
// note is the only thing under test -----------------------------------------

const healthDegraded: ProviderStatus = {
  ...known,
  id: "claude-d",
  health: { state: "degraded", detail: "Partially Degraded Service", readAt: 1 },
};

const healthOutage: ProviderStatus = {
  ...known,
  id: "claude-o",
  health: { state: "outage", detail: "Major Outage", readAt: 1 },
};

const healthUnknown: ProviderStatus = {
  ...known,
  id: "claude-u",
  health: { state: "unknown", detail: "", readAt: undefined },
};

describe("providerStatusLine — capacity known", () => {
  it("renders the ordinary case exactly, in both languages", () => {
    expect(providerStatusLine(known, "en")).toBe(
      `claude-main — 38% left · resets ${clock("2026-08-31T14:30:00.000Z")} · as of ${clock("2026-08-31T12:12:00.000Z")}`,
    );
    expect(providerStatusLine(known, "ar")).toBe(
      `claude-main — المتبقي 38% · يتجدد ${clock("2026-08-31T14:30:00.000Z")} · حتى ${clock("2026-08-31T12:12:00.000Z")}`,
    );
  });

  it("renders 0% remaining exactly, in both languages", () => {
    expect(providerStatusLine(knownZeroRemaining, "en")).toBe(
      `claude-zero — 0% left · resets ${clock("2026-09-01T00:00:00.000Z")} · as of ${clock("2026-08-31T23:59:00.000Z")}`,
    );
    expect(providerStatusLine(knownZeroRemaining, "ar")).toBe(
      `claude-zero — المتبقي 0% · يتجدد ${clock("2026-09-01T00:00:00.000Z")} · حتى ${clock("2026-08-31T23:59:00.000Z")}`,
    );
  });

  it("renders 100% remaining exactly, in both languages", () => {
    expect(providerStatusLine(knownFullRemaining, "en")).toBe(
      `claude-full — 100% left · resets ${clock("2026-09-02T09:05:00.000Z")} · as of ${clock("2026-08-31T08:00:00.000Z")}`,
    );
    expect(providerStatusLine(knownFullRemaining, "ar")).toBe(
      `claude-full — المتبقي 100% · يتجدد ${clock("2026-09-02T09:05:00.000Z")} · حتى ${clock("2026-08-31T08:00:00.000Z")}`,
    );
  });

  it("renders a fractional remaining percentage floored, in both languages", () => {
    expect(providerStatusLine(knownFractional, "en")).toBe(
      `claude-half — 37% left · resets ${clock("2026-08-31T18:45:00.000Z")} · as of ${clock("2026-08-31T17:30:00.000Z")}`,
    );
    expect(providerStatusLine(knownFractional, "ar")).toBe(
      `claude-half — المتبقي 37% · يتجدد ${clock("2026-08-31T18:45:00.000Z")} · حتى ${clock("2026-08-31T17:30:00.000Z")}`,
    );
  });

  it("never composes a counted duration in Arabic, across every known fixture", () => {
    for (const status of [known, knownZeroRemaining, knownFullRemaining, knownFractional]) {
      expect(providerStatusLine(status, "ar")).not.toMatch(/ساعات|ساعتان|ساعتين|أيام|يومين/);
    }
  });
});

describe("providerStatusLine — capacity unknown", () => {
  it("renders 'unsupported' exactly, in both languages", () => {
    expect(providerStatusLine(capUnsupported, "en")).toBe("copilot-x — no capacity reading available");
    expect(providerStatusLine(capUnsupported, "ar")).toBe("copilot-x — لا يوفّر قراءة للسعة");
  });

  it("renders 'unavailable' exactly, in both languages", () => {
    expect(providerStatusLine(capUnavailable, "en")).toBe("claude-unavail — capacity couldn't be read");
    expect(providerStatusLine(capUnavailable, "ar")).toBe("claude-unavail — تعذّرت قراءة السعة");
  });

  it("renders 'never-read' exactly, in both languages", () => {
    expect(providerStatusLine(capNeverRead, "en")).toBe("claude-never — capacity not checked yet");
    expect(providerStatusLine(capNeverRead, "ar")).toBe("claude-never — لم تُقرأ السعة بعد");
  });

  it("keeps the three unknown reasons distinct from one another, pairwise", () => {
    const unsupportedEn = providerStatusLine(capUnsupported, "en");
    const unavailableEn = providerStatusLine(capUnavailable, "en");
    const neverReadEn = providerStatusLine(capNeverRead, "en");
    expect(neverReadEn).not.toBe(unavailableEn);
    expect(neverReadEn).not.toBe(unsupportedEn);
    expect(unavailableEn).not.toBe(unsupportedEn);
    // never-read must not read like unavailable, or vice versa, in either language.
    expect(neverReadEn).not.toContain("couldn't be read");
    expect(unavailableEn).not.toContain("not checked yet");
    const unsupportedAr = providerStatusLine(capUnsupported, "ar");
    const unavailableAr = providerStatusLine(capUnavailable, "ar");
    const neverReadAr = providerStatusLine(capNeverRead, "ar");
    expect(neverReadAr).not.toBe(unavailableAr);
    expect(neverReadAr).not.toBe(unsupportedAr);
    expect(unavailableAr).not.toBe(unsupportedAr);
  });
});

describe("providerStatusLine — health", () => {
  it("says nothing about health when it's ok — silence is exact, not merely wordless", () => {
    // The full line is exactly the capacity clause with no trailing " — ...":
    // this is a stronger claim than "doesn't contain a health word", since a
    // rendering bug that appended a *different* trailing clause (or an extra
    // separator with nothing after it) would still pass a not.toContain check.
    expect(providerStatusLine(known, "en")).toBe(
      `claude-main — 38% left · resets ${clock("2026-08-31T14:30:00.000Z")} · as of ${clock("2026-08-31T12:12:00.000Z")}`,
    );
    expect(providerStatusLine(known, "ar")).toBe(
      `claude-main — المتبقي 38% · يتجدد ${clock("2026-08-31T14:30:00.000Z")} · حتى ${clock("2026-08-31T12:12:00.000Z")}`,
    );
  });

  it("renders 'degraded' exactly, in both languages", () => {
    expect(providerStatusLine(healthDegraded, "en")).toBe(
      `claude-d — 38% left · resets ${clock("2026-08-31T14:30:00.000Z")} · as of ${clock("2026-08-31T12:12:00.000Z")} — service degraded`,
    );
    expect(providerStatusLine(healthDegraded, "ar")).toBe(
      `claude-d — المتبقي 38% · يتجدد ${clock("2026-08-31T14:30:00.000Z")} · حتى ${clock("2026-08-31T12:12:00.000Z")} — الخدمة متعثرة`,
    );
  });

  it("renders 'outage' exactly, in both languages", () => {
    expect(providerStatusLine(healthOutage, "en")).toBe(
      `claude-o — 38% left · resets ${clock("2026-08-31T14:30:00.000Z")} · as of ${clock("2026-08-31T12:12:00.000Z")} — service down`,
    );
    expect(providerStatusLine(healthOutage, "ar")).toBe(
      `claude-o — المتبقي 38% · يتجدد ${clock("2026-08-31T14:30:00.000Z")} · حتى ${clock("2026-08-31T12:12:00.000Z")} — الخدمة متوقفة`,
    );
  });

  it("renders 'unknown' exactly, in both languages", () => {
    expect(providerStatusLine(healthUnknown, "en")).toBe(
      `claude-u — 38% left · resets ${clock("2026-08-31T14:30:00.000Z")} · as of ${clock("2026-08-31T12:12:00.000Z")} — service status unknown`,
    );
    expect(providerStatusLine(healthUnknown, "ar")).toBe(
      `claude-u — المتبقي 38% · يتجدد ${clock("2026-08-31T14:30:00.000Z")} · حتى ${clock("2026-08-31T12:12:00.000Z")} — حالة الخدمة غير معروفة`,
    );
  });
});

describe("providerReportText", () => {
  it("gives one line per provider, in registry order, rendered exactly", () => {
    expect(providerReportText([known, capUnsupported], "en")).toBe(
      `claude-main — 38% left · resets ${clock("2026-08-31T14:30:00.000Z")} · as of ${clock("2026-08-31T12:12:00.000Z")}\ncopilot-x — no capacity reading available`,
    );
    expect(providerReportText([known, capUnsupported], "ar")).toBe(
      `claude-main — المتبقي 38% · يتجدد ${clock("2026-08-31T14:30:00.000Z")} · حتى ${clock("2026-08-31T12:12:00.000Z")}\ncopilot-x — لا يوفّر قراءة للسعة`,
    );
  });

  it("renders the empty-accounts line exactly, in both languages", () => {
    expect(providerReportText([], "en")).toBe("No providers are configured.");
    expect(providerReportText([], "ar")).toBe("لا توجد حسابات مُعرّفة.");
  });
});

describe("capacityReportText", () => {
  it("is exactly empty when nothing was actually read, so startup stays quiet", () => {
    expect(capacityReportText([capUnsupported], "en")).toBe("");
    expect(capacityReportText([capUnsupported], "ar")).toBe("");
  });

  it("renders the label plus only the accounts with a reading, exactly, in both languages", () => {
    expect(capacityReportText([known, capUnsupported], "en")).toBe(
      `Capacity left:\nclaude-main — 38% left · resets ${clock("2026-08-31T14:30:00.000Z")} · as of ${clock("2026-08-31T12:12:00.000Z")}`,
    );
    expect(capacityReportText([known, capUnsupported], "ar")).toBe(
      `السعة المتبقية:\nclaude-main — المتبقي 38% · يتجدد ${clock("2026-08-31T14:30:00.000Z")} · حتى ${clock("2026-08-31T12:12:00.000Z")}`,
    );
  });
});
