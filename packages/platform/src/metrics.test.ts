import { describe, expect, it } from "vitest";
import { readMetrics } from "./metrics.js";
import type { MetricsSource } from "./metrics.js";

const source: MetricsSource = {
  currentLoad: async () => ({ currentLoad: 23.4 }),
  mem: async () => ({ used: 38_000_000_000, total: 38_654_705_664, available: 17_179_869_184 }),
  fsSize: async () => [
    { mount: "/", used: 335_007_449_088, size: 1_067_000_000_000, available: 700_000_000_000 },
    { mount: "/boot", used: 1_000, size: 2_000, available: 1_000 },
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

  it("passes the memory total through in bytes", async () => {
    const metrics = await readMetrics(source);
    expect(metrics.memoryTotalBytes).toBe(38_654_705_664);
  });

  it("reports one filesystem, not the sum of every mount", async () => {
    const metrics = await readMetrics(source);
    expect(metrics.diskTotalBytes).toBe(1_067_000_000_000);
    expect(metrics.diskUsedBytes).toBe(1_067_000_000_000 - 700_000_000_000);
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

describe("readMetrics: what the numbers mean", () => {
  // macOS counts cached and compressed pages as "used", so `used` reads 99%
  // on a machine that is working perfectly. `available` is what is free or
  // freeable, and total minus it is what a person means by memory in use.
  it("measures memory as total minus what is available", async () => {
    const metrics = await readMetrics(source);

    // Deliberately different from the `used` field, which on this fixture
    // reads 98% — the number that was on screen.
    expect(metrics.memoryUsedBytes).toBe(21_474_836_480);
    expect(metrics.memoryUsedBytes).not.toBe(38_000_000_000);
  });

  it("falls back to the used figure when nothing reports availability", async () => {
    const metrics = await readMetrics({
      ...source,
      mem: async () => ({ used: 21_474_836_480, total: 38_654_705_664 }),
    });

    expect(metrics.memoryUsedBytes).toBe(21_474_836_480);
  });

  // On an APFS Mac, "/" is a sealed system snapshot holding ~17GB while the
  // user's 400GB lives on the Data volume that shares its container. Reading
  // the first filesystem's `used` reported 3% on a disk with 9GB left.
  it("measures disk from what is free, not from one volume's used bytes", async () => {
    const metrics = await readMetrics({
      ...source,
      fsSize: async () => [
        { mount: "/", used: 17_000_000_000, size: 494_000_000_000, available: 10_000_000_000 },
        {
          mount: "/System/Volumes/Data",
          used: 439_000_000_000,
          size: 494_000_000_000,
          available: 10_000_000_000,
        },
      ],
    });

    expect(metrics.diskTotalBytes).toBe(494_000_000_000);
    expect(metrics.diskUsedBytes).toBe(484_000_000_000);
    expect(Math.round((metrics.diskUsedBytes / metrics.diskTotalBytes) * 100)).toBe(98);
  });

  it("prefers the root filesystem over whatever happens to be listed first", async () => {
    const metrics = await readMetrics({
      ...source,
      fsSize: async () => [
        { mount: "/Volumes/USB", used: 1_000, size: 2_000, available: 1_000 },
        { mount: "/", used: 50, size: 1_000, available: 400 },
      ],
    });

    expect(metrics.diskTotalBytes).toBe(1_000);
    expect(metrics.diskUsedBytes).toBe(600);
  });

  it("falls back to a volume's used bytes when it reports no availability", async () => {
    const metrics = await readMetrics({
      ...source,
      fsSize: async () => [{ mount: "/", used: 400, size: 1_000 }],
    });

    expect(metrics.diskUsedBytes).toBe(400);
  });

  it("reports nothing rather than guessing when there are no filesystems", async () => {
    const metrics = await readMetrics({ ...source, fsSize: async () => [] });

    expect(metrics.diskUsedBytes).toBe(0);
    expect(metrics.diskTotalBytes).toBe(0);
  });
});
