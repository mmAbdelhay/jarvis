import type { SystemMetrics } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { metricPercents } from "./home-metrics";

const GB = 1024 ** 3;

function metrics(overrides: Partial<SystemMetrics>): SystemMetrics {
  return {
    cpuPercent: 12,
    memoryUsedBytes: 8 * GB,
    memoryTotalBytes: 16 * GB,
    diskUsedBytes: 450 * GB,
    diskTotalBytes: 500 * GB,
    networkDownMbps: 0,
    networkUpMbps: 0,
    uptimeSeconds: 0,
    ...overrides,
  };
}

describe("metricPercents", () => {
  it("is all unknown before the laptop has reported", () => {
    expect(metricPercents(undefined)).toEqual({
      cpu: undefined,
      memory: undefined,
      disk: undefined,
    });
  });

  it("turns used/total bytes into percents", () => {
    expect(metricPercents(metrics({}))).toEqual({ cpu: 12, memory: 50, disk: 90 });
  });

  it("leaves a zero total unknown rather than dividing by it", () => {
    const percents = metricPercents(metrics({ memoryTotalBytes: 0, diskTotalBytes: 0 }));
    expect(percents.memory).toBeUndefined();
    expect(percents.disk).toBeUndefined();
  });
});
