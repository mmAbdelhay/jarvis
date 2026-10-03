// Phone Home's metrics strip: the laptop's CPU, memory and disk as percents.
// Pure, so the byte maths and the "not reported yet" cases are unit tested.
import type { SystemMetrics } from "@jarvis/core";

export type MetricPercents = {
  cpu: number | undefined;
  memory: number | undefined;
  disk: number | undefined;
};

function share(used: number, total: number): number | undefined {
  return total > 0 ? (used / total) * 100 : undefined;
}

/** Each meter's percent; undefined until known (no metrics, or a zero total). */
export function metricPercents(metrics: SystemMetrics | undefined): MetricPercents {
  if (metrics === undefined) return { cpu: undefined, memory: undefined, disk: undefined };
  return {
    cpu: metrics.cpuPercent,
    memory: share(metrics.memoryUsedBytes, metrics.memoryTotalBytes),
    disk: share(metrics.diskUsedBytes, metrics.diskTotalBytes),
  };
}
