import { describe, expect, it } from "vitest";
import { readMetrics } from "./metrics.js";
import type { MetricsSource } from "./metrics.js";

const source: MetricsSource = {
  currentLoad: async () => ({ currentLoad: 23.4 }),
  mem: async () => ({ used: 21_474_836_480, total: 38_654_705_664 }),
  fsSize: async () => [
    { used: 335_007_449_088, size: 1_067_000_000_000 },
    { used: 1_000, size: 2_000 },
  ],
  networkStats: async () => [{ rx_sec: 10_525_000, tx_sec: 1_575_000 }],
  time: () => ({ uptime: 367_200 }),
};

describe("readMetrics", () => {
  it("rounds cpu load to one decimal", async () => {
    const metrics = await readMetrics(source);
    expect(metrics.cpuPercent).toBe(23.4);
  });

  it("rounds a cpu load with more than one decimal place", async () => {
    const jittery: MetricsSource = { ...source, currentLoad: async () => ({ currentLoad: 23.449 }) };
    const metrics = await readMetrics(jittery);
    expect(metrics.cpuPercent).toBe(23.4);
  });

  it("passes memory through in bytes", async () => {
    const metrics = await readMetrics(source);
    expect(metrics.memoryUsedBytes).toBe(21_474_836_480);
    expect(metrics.memoryTotalBytes).toBe(38_654_705_664);
  });

  it("uses the first filesystem only", async () => {
    const metrics = await readMetrics(source);
    expect(metrics.diskTotalBytes).toBe(1_067_000_000_000);
  });

  it("passes the first filesystem's used bytes through, not the second's", async () => {
    const metrics = await readMetrics(source);
    expect(metrics.diskUsedBytes).toBe(335_007_449_088);
  });

  it("converts network bytes per second to megabits per second", async () => {
    const metrics = await readMetrics(source);
    expect(metrics.networkDownMbps).toBeCloseTo(84.2, 1);
    expect(metrics.networkUpMbps).toBeCloseTo(12.6, 1);
  });

  it("sums every interface's throughput", async () => {
    const multi: MetricsSource = {
      ...source,
      networkStats: async () => [
        { rx_sec: 1_250_000, tx_sec: 0 },
        { rx_sec: 1_250_000, tx_sec: 0 },
      ],
    };
    const metrics = await readMetrics(multi);
    expect(metrics.networkDownMbps).toBeCloseTo(20, 1);
  });

  it("keeps download and upload figures independent", async () => {
    const asymmetric: MetricsSource = {
      ...source,
      networkStats: async () => [{ rx_sec: 1_250_000, tx_sec: 2_500_000 }],
    };
    const metrics = await readMetrics(asymmetric);
    expect(metrics.networkDownMbps).toBeCloseTo(10, 1);
    expect(metrics.networkUpMbps).toBeCloseTo(20, 1);
  });

  it("reports zero rather than NaN when an interface has no samples yet", async () => {
    const cold: MetricsSource = { ...source, networkStats: async () => [] };
    const metrics = await readMetrics(cold);
    expect(metrics.networkDownMbps).toBe(0);
    expect(metrics.networkUpMbps).toBe(0);
  });

  it("reports zero rather than negative when a counter resets below zero", async () => {
    const negative: MetricsSource = {
      ...source,
      networkStats: async () => [{ rx_sec: -500, tx_sec: -500 }],
    };
    const metrics = await readMetrics(negative);
    expect(metrics.networkDownMbps).toBe(0);
    expect(metrics.networkUpMbps).toBe(0);
  });

  it("reports zero disk when no filesystem is returned", async () => {
    const noFs: MetricsSource = { ...source, fsSize: async () => [] };
    const metrics = await readMetrics(noFs);
    expect(metrics.diskUsedBytes).toBe(0);
    expect(metrics.diskTotalBytes).toBe(0);
  });

  it("passes uptime through in seconds", async () => {
    const metrics = await readMetrics(source);
    expect(metrics.uptimeSeconds).toBe(367_200);
  });
});
