import si from "systeminformation";
import type { SystemMetrics } from "@jarvis/core";

export type MetricsSource = {
  currentLoad(): Promise<{ currentLoad: number }>;
  /** `available` is what is free or freeable. It is the meaningful figure:
   *  macOS counts cached and compressed pages as `used`, which reads ~99% on
   *  a machine that is working perfectly. */
  mem(): Promise<{ used: number; total: number; available?: number }>;
  fsSize(): Promise<{ mount?: string; used: number; size: number; available?: number }[]>;
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

  const primary = primaryFilesystem(filesystems);
  const down = sum(network.map((n) => n.rx_sec));
  const up = sum(network.map((n) => n.tx_sec));

  return {
    cpuPercent: round1(load.currentLoad),
    memoryUsedBytes: inUse(memory.total, memory.available, memory.used),
    memoryTotalBytes: memory.total,
    diskUsedBytes: primary === undefined ? 0 : inUse(primary.size, primary.available, primary.used),
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

/**
 * What is actually in use: the total minus what is free or freeable.
 *
 * Both of this module's `used` fields lie in the same way. macOS counts
 * cached and compressed pages as memory in use, so `mem.used` reads 99% on a
 * healthy machine. And on an APFS Mac the volumes of a container share their
 * free space, so a volume's own `used` describes only that volume — the
 * sealed system snapshot at "/" holds ~17GB while the user's data lives
 * elsewhere in the same 500GB, which is how a disk with 9GB left reported 3%.
 *
 * `total - available` is right for both, and is what df and Activity Monitor
 * show. The `used` figure is kept only as a fallback for a source that
 * reports no availability at all.
 */
function inUse(total: number, available: number | undefined, used: number): number {
  if (!Number.isFinite(available) || available === undefined) return used;
  const value = total - available;
  return value >= 0 ? value : used;
}

/**
 * The filesystem the number is about: the one holding the user's data.
 *
 * Not `[0]`, which is whatever the platform happened to list first — on this
 * Mac a read-only system snapshot, and on any machine a mounted USB stick
 * could take the slot.
 */
function primaryFilesystem<T extends { mount?: string }>(filesystems: T[]): T | undefined {
  return (
    filesystems.find((entry) => entry.mount === "/System/Volumes/Data") ??
    filesystems.find((entry) => entry.mount === "/") ??
    filesystems[0]
  );
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
