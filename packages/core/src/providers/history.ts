import type { ProviderStatus } from "./types.js";

/** One capacity reading, kept: how much of an account's primary window was
 *  used, and when the provider says that was true. */
export type CapacitySample = { id: string; at: number; usedPercent: number };

/** Where capacity readings are kept over time. */
export interface UsageStore {
  /** Keeps a reading. The same (id, at) twice is one reading. */
  record(sample: CapacitySample): void;
  /** Every reading taken at or after `since`, oldest first. */
  samples(since: number): CapacitySample[];
}

/**
 * Keeps every new capacity reading the status store publishes. A reading is
 * new when its `readAt` differs from the last one kept for that account —
 * the store re-emits on health changes and refresh attempts too, and none
 * of those is a new reading. Nothing here spends a query: it only keeps
 * what was already read. Returns the unsubscribe.
 */
export function recordCapacityHistory(
  statuses: { onChange(listener: (statuses: ProviderStatus[]) => void): () => void },
  store: UsageStore,
): () => void {
  const lastKept = new Map<string, number>();
  return statuses.onChange((current) => {
    for (const status of current) {
      if (status.capacity.state !== "known") continue;
      const at = status.capacity.readAt;
      if (lastKept.get(status.id) === at) continue;
      lastKept.set(status.id, at);
      try {
        store.record({ id: status.id, at, usedPercent: status.capacity.primary.usedPercent });
      } catch {
        // A history that could not be written is a gap in a chart, never a
        // reason for the provider panel itself to stop updating.
      }
    }
  });
}
