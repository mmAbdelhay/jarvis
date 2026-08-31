import type { AgentConfig, ProviderVendor } from "../registry/types.js";
import type { CapacityReading, HealthReading, ProviderStatus } from "./types.js";

type Row = {
  id: string;
  vendor: ProviderVendor | undefined;
  configDir: string | undefined;
  status: ProviderStatus;
  /** Time of the last capacity *attempt* (success or failure); see `lastCapacityReadAt`. */
  lastCapacityAttemptAt: number | undefined;
};

/**
 * Last-known provider state, in memory, for the life of the process. Pure:
 * no timers, no network, no persistence — the same shape as ChangeTracker's
 * cache. Everything that costs money lives outside it (ProviderMonitor).
 *
 * Nothing here is written to disk: a reading's value is its freshness, the
 * startup refresh replaces it within seconds of a launch, and it is a slice
 * of the user's account telemetry.
 */
export class ProviderStatusStore {
  readonly #rows: Row[];
  readonly #listeners = new Set<(statuses: ProviderStatus[]) => void>();

  constructor(agents: readonly AgentConfig[]) {
    this.#rows = agents.map((agent) => ({
      id: agent.id,
      vendor: agent.vendor,
      configDir: agent.configDir,
      lastCapacityAttemptAt: undefined,
      status: {
        id: agent.id,
        vendor: agent.vendor,
        capacity:
          agent.configDir === undefined
            ? { state: "unknown", reason: "unsupported" }
            : { state: "unknown", reason: "never-read" },
        health: { state: "unknown", detail: "", readAt: undefined },
      },
    }));
  }

  snapshot(): ProviderStatus[] {
    return this.#rows.map((row) => row.status);
  }

  /**
   * The time of the last capacity *attempt* on this account, success or
   * failure — not just the last success. A failed read still spent a real,
   * billed round trip, and Task 6's refresh policy needs to know that so it
   * does not pay for another one within the same throttle window. A failure
   * clears `capacity` to `{ state: "unknown", reason: "unavailable" }`, which
   * carries no timestamp of its own, so this is tracked independently of
   * `capacity.readAt`.
   */
  lastCapacityReadAt(id: string): number | undefined {
    const row = this.#rows.find((candidate) => candidate.id === id);
    return row?.lastCapacityAttemptAt;
  }

  recordCapacity(id: string, reading: CapacityReading, at: number): void {
    const row = this.#rows.find((candidate) => candidate.id === id);
    if (row === undefined) return;
    // An account with no config dir can never have a real reading — a caller
    // offering one is confused, and accepting it would put a number on a row
    // whose whole point is that no number exists.
    if (row.configDir === undefined) return;

    row.lastCapacityAttemptAt = at;
    row.status = {
      ...row.status,
      capacity: reading.ok
        ? { state: "known", fiveHour: reading.fiveHour, sevenDay: reading.sevenDay, readAt: at }
        : { state: "unknown", reason: "unavailable" },
    };
    this.#emit();
  }

  recordHealth(vendor: ProviderVendor, reading: HealthReading, at: number): void {
    let changed = false;
    for (const row of this.#rows) {
      if (row.vendor !== vendor) continue;
      row.status = { ...row.status, health: { ...reading, readAt: at } };
      changed = true;
    }
    if (changed) this.#emit();
  }

  onChange(listener: (statuses: ProviderStatus[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}
