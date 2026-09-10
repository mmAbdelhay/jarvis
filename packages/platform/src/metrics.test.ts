import { describe, expect, it } from "vitest";
import { cacheSource, readMetrics } from "./metrics.js";
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
  cpuTemperature: async () => ({ main: 45 }),
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

describe("cacheSource", () => {
  function counting() {
    const calls = {
      currentLoad: 0,
      mem: 0,
      fsSize: 0,
      networkStats: 0,
      time: 0,
      cpuTemperature: 0,
    };
    const base: MetricsSource = {
      currentLoad: async () => {
        calls.currentLoad += 1;
        return { currentLoad: 10 };
      },
      cpuTemperature: async () => {
        calls.cpuTemperature += 1;
        return { main: 45 };
      },
      mem: async () => {
        calls.mem += 1;
        return { used: 1, total: 10, available: 4 };
      },
      fsSize: async () => {
        calls.fsSize += 1;
        return [{ mount: "/", used: 1, size: 10, available: 4 }];
      },
      networkStats: async () => {
        calls.networkStats += 1;
        return [{ rx_sec: 0, tx_sec: 0 }];
      },
      time: () => {
        calls.time += 1;
        return { uptime: 100 };
      },
    };
    return { calls, base };
  }

  // A full sample costs about 240ms and the dashboard polls every two
  // seconds; disk alone was 113ms of it, re-read every tick for a number
  // that changes over hours.
  it("reads disk once across many samples inside its window", async () => {
    const { calls, base } = counting();
    let clock = 0;
    const source = cacheSource(base, () => clock);

    for (let i = 0; i < 10; i += 1) {
      await readMetrics(source);
      clock += 2000;
    }

    expect(calls.fsSize).toBe(1);
  });

  it("still reads CPU and network every single sample", async () => {
    const { calls, base } = counting();
    let clock = 0;
    const source = cacheSource(base, () => clock);

    for (let i = 0; i < 5; i += 1) {
      await readMetrics(source);
      clock += 2000;
    }

    expect(calls.currentLoad).toBe(5);
    expect(calls.networkStats).toBe(5);
  });

  it("re-reads once the value has gone stale", async () => {
    const { calls, base } = counting();
    let clock = 0;
    const source = cacheSource(base, () => clock, { memoryMs: 5000, diskMs: 10_000, uptimeMs: 10_000 });

    await readMetrics(source);
    clock = 4000;
    await readMetrics(source);
    expect(calls.mem).toBe(1);

    clock = 6000;
    await readMetrics(source);
    expect(calls.mem).toBe(2);
  });

  // Uptime is a clock: a cached one has to be corrected by how long it was
  // held, or the display sits still for a minute at a time.
  it("advances a cached uptime instead of repeating it", async () => {
    const { base } = counting();
    let clock = 0;
    const source = cacheSource(base, () => clock, { memoryMs: 1, diskMs: 1, uptimeMs: 60_000 });

    expect(source.time().uptime).toBe(100);
    clock = 30_000;
    expect(source.time().uptime).toBe(130);
  });

  it("returns the same values a plain source would", async () => {
    const { base } = counting();
    const direct = await readMetrics(base);
    const cached = await readMetrics(cacheSource(base, () => 0));

    expect(cached).toEqual(direct);
  });
});

describe("cpu temperature", () => {
  const base = {
    currentLoad: async () => ({ currentLoad: 10 }),
    mem: async () => ({ used: 1, total: 10, available: 4 }),
    fsSize: async () => [{ mount: "/", used: 1, size: 10, available: 9 }],
    networkStats: async () => [{ rx_sec: 0, tx_sec: 0 }],
    time: () => ({ uptime: 60 }),
  };

  it("reports the reading when the machine has a sensor", async () => {
    // A desktop Linux box answers from /sys/class/thermal with no privileges.
    const metrics = await readMetrics({ ...base, cpuTemperature: async () => ({ main: 66.4 }) });
    expect(metrics.cpuTemperatureC).toBe(66.4);
  });

  it("reports nothing at all when it has none", async () => {
    // Apple Silicon without a privileged helper, and most VMs. Undefined, not
    // zero — 0 °C is a reading, and the tile would show it as one.
    const metrics = await readMetrics({ ...base, cpuTemperature: async () => ({ main: null }) });
    expect(metrics.cpuTemperatureC).toBeUndefined();
    expect("cpuTemperatureC" in metrics).toBe(false);
  });

  it("treats a non-finite reading as no reading", async () => {
    const metrics = await readMetrics({
      ...base,
      cpuTemperature: async () => ({ main: Number.NaN }),
    });
    expect(metrics.cpuTemperatureC).toBeUndefined();
  });

  it("is not cached, because it is one of the readings that actually moves", async () => {
    let reads = 0;
    const source = cacheSource(
      {
        ...base,
        cpuTemperature: async () => {
          reads += 1;
          return { main: 50 };
        },
      },
      () => 0,
    );
    await source.cpuTemperature();
    await source.cpuTemperature();
    expect(reads).toBe(2);
  });
});
