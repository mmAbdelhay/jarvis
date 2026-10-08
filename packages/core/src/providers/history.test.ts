import { describe, expect, it } from "vitest";
import { recordCapacityHistory, type CapacitySample } from "./history.js";
import type { ProviderStatus } from "./types.js";

function emitter() {
  let listener: ((statuses: ProviderStatus[]) => void) | undefined;
  return {
    onChange(next: (statuses: ProviderStatus[]) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    emit(statuses: ProviderStatus[]) {
      listener?.(statuses);
    },
  };
}

const known = (id: string, readAt: number, usedPercent: number): ProviderStatus => ({
  id,
  vendor: "anthropic",
  capacity: {
    state: "known",
    primary: { usedPercent, resetsAt: "2026-10-02T00:00:00Z" },
    secondary: undefined,
    readAt,
  },
  health: { state: "ok", detail: "", readAt: undefined },
});

describe("recordCapacityHistory", () => {
  it("keeps each new reading once, however often the store re-emits it", () => {
    const statuses = emitter();
    const kept: CapacitySample[] = [];
    recordCapacityHistory(statuses, { record: (s) => kept.push(s), samples: () => [] });

    statuses.emit([known("claude", 1000, 40)]);
    statuses.emit([known("claude", 1000, 40)]);
    statuses.emit([known("claude", 2000, 55), known("codex", 1500, 10)]);

    expect(kept).toEqual([
      { id: "claude", at: 1000, usedPercent: 40 },
      { id: "claude", at: 2000, usedPercent: 55 },
      { id: "codex", at: 1500, usedPercent: 10 },
    ]);
  });

  it("keeps nothing for an account whose capacity is unknown", () => {
    const statuses = emitter();
    const kept: CapacitySample[] = [];
    recordCapacityHistory(statuses, { record: (s) => kept.push(s), samples: () => [] });
    statuses.emit([
      {
        ...known("copilot", 1, 1),
        capacity: { state: "unknown", reason: "never-read" },
      },
    ]);
    expect(kept).toEqual([]);
  });

  it("survives a store that cannot write", () => {
    const statuses = emitter();
    recordCapacityHistory(statuses, {
      record: () => {
        throw new Error("disk full");
      },
      samples: () => [],
    });
    expect(() => statuses.emit([known("claude", 1, 1)])).not.toThrow();
  });
});
