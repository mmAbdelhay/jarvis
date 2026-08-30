import si from "systeminformation";
import type { SystemMetrics } from "@jarvis/core";

export type MetricsSource = {
  currentLoad(): Promise<{ currentLoad: number }>;
  mem(): Promise<{ used: number; total: number }>;
  fsSize(): Promise<{ used: number; size: number }[]>;
  networkStats(): Promise<{ rx_sec: number; tx_sec: number }[]>;
  time(): { uptime: number };
};

const BITS_PER_BYTE = 8;
const BITS_PER_MEGABIT = 1_000_000;

export async function readMetrics(source: MetricsSource): Promise<SystemMetrics> {
  const [load, memory, filesystems, network] = await Promise.all([
    source.currentLoad(),
    source.mem(),
    source.fsSize(),
    source.networkStats(),
  ]);

  const primary = filesystems[0];
  const down = sum(network.map((n) => n.rx_sec));
  const up = sum(network.map((n) => n.tx_sec));

  return {
    cpuPercent: round1(load.currentLoad),
    memoryUsedBytes: memory.used,
    memoryTotalBytes: memory.total,
    diskUsedBytes: primary?.used ?? 0,
    diskTotalBytes: primary?.size ?? 0,
    networkDownMbps: toMbps(down),
    networkUpMbps: toMbps(up),
    uptimeSeconds: source.time().uptime,
  };
}

export function createMetricsReader(): () => Promise<SystemMetrics> {
  const source: MetricsSource = {
    currentLoad: () => si.currentLoad(),
    mem: () => si.mem(),
    fsSize: () => si.fsSize(),
    networkStats: () => si.networkStats(),
    time: () => si.time(),
  };
  return () => readMetrics(source);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function toMbps(bytesPerSecond: number): number {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return 0;
  return round1((bytesPerSecond * BITS_PER_BYTE) / BITS_PER_MEGABIT);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
