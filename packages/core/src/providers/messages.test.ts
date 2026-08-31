import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "./types.js";
import { capacityReportText, providerReportText, providerStatusLine } from "./messages.js";

const known: ProviderStatus = {
  id: "claude-mm",
  vendor: "anthropic",
  capacity: {
    state: "known",
    fiveHour: { usedPercent: 62, resetsAt: "2026-08-31T14:30:00.000Z" },
    sevenDay: { usedPercent: 33, resetsAt: "2026-09-02T11:00:00.000Z" },
    readAt: Date.parse("2026-08-31T12:12:00.000Z"),
  },
  health: { state: "ok", detail: "All Systems Operational", readAt: 1 },
};

const unsupported: ProviderStatus = {
  id: "copilot",
  vendor: "github",
  capacity: { state: "unknown", reason: "unsupported" },
  health: { state: "degraded", detail: "Partially Degraded Service", readAt: 1 },
};

describe("providerStatusLine", () => {
  it("names the account, then the remaining percentage, then the reset clock time", () => {
    const line = providerStatusLine(known, "en");
    expect(line).toContain("claude-mm");
    expect(line).toContain("38%");
    // Remaining, not used: the question is "how much can I use".
    expect(line).not.toContain("62%");
    // An absolute clock time, never a counted duration like "in 3 hours".
    expect(line).toMatch(/\d{2}:\d{2}/);
  });

  it("puts every number at a clause tail in Arabic and counts no nouns", () => {
    const line = providerStatusLine(known, "ar");
    expect(line).toContain("المتبقي 38%");
    expect(line).toContain("claude-mm");
    // Ruling P30: no composed counted duration in either grammatical position.
    expect(line).not.toMatch(/ساعات|ساعتان|ساعتين|أيام|يومين/);
  });

  it("says a provider has no capacity reading at all, in both languages", () => {
    expect(providerStatusLine(unsupported, "en")).toContain("no capacity reading");
    expect(providerStatusLine(unsupported, "ar")).toContain("لا يوفّر قراءة للسعة");
    expect(providerStatusLine(unsupported, "en")).not.toContain("0%");
  });

  it("keeps the three unknown reasons distinct", () => {
    const never = providerStatusLine(
      { ...unsupported, id: "claude-personal", capacity: { state: "unknown", reason: "never-read" } },
      "en",
    );
    const failed = providerStatusLine(
      { ...unsupported, id: "claude-personal", capacity: { state: "unknown", reason: "unavailable" } },
      "en",
    );
    expect(never).toContain("not checked yet");
    expect(failed).toContain("couldn't be read");
    expect(never).not.toBe(failed);
  });

  it("names a degraded or down provider on the same line", () => {
    expect(providerStatusLine(unsupported, "en")).toContain("degraded");
    expect(providerStatusLine(unsupported, "ar")).toContain("متعثرة");
    // A healthy provider says nothing about health — silence is the good news.
    expect(providerStatusLine(known, "en")).not.toContain("operational");
  });

  it("dates a reading with an absolute clock time, not a relative age", () => {
    expect(providerStatusLine(known, "en")).toContain("as of");
    expect(providerStatusLine(known, "ar")).toContain("حتى");
  });
});

describe("providerReportText", () => {
  it("gives one line per provider, in registry order", () => {
    const lines = providerReportText([known, unsupported], "en").split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("claude-mm");
    expect(lines[1]).toContain("copilot");
  });

  it("says so plainly when there are no providers at all", () => {
    expect(providerReportText([], "en")).toContain("No providers");
    expect(providerReportText([], "ar")).toContain("لا توجد");
  });
});

describe("capacityReportText", () => {
  it("is empty when nothing was actually read, so startup stays quiet", () => {
    expect(capacityReportText([unsupported], "en")).toBe("");
  });

  it("leads with a label and lists only the accounts that have a reading", () => {
    const text = capacityReportText([known, unsupported], "en");
    expect(text).toContain("Capacity");
    expect(text).toContain("claude-mm");
    expect(text).not.toContain("copilot");
  });
});
