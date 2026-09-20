import type { AgentConfig, ProviderVendor } from "../registry/types.js";
import {
  type CapacityReading,
  capacitySupported,
  type HealthReading,
  type ProviderStatus,
} from "./types.js";

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
        capacity: capacitySupported(agent)
          ? { state: "unknown", reason: "never-read" }
          : { state: "unknown", reason: "unsupported" },
        health: { state: "unknown", detail: "", readAt: undefined },
      },
    }));
  }

  snapshot(): ProviderStatus[] {
    return this.#rows.map((row) => row.status);
  }

  replace(agents: readonly AgentConfig[]): void {
    const existing = new Map(this.#rows.map((row) => [row.id, row]));
    this.#rows.splice(
      0,
      this.#rows.length,
      ...agents.map(
        (agent) =>
          existing.get(agent.id) ?? {
            id: agent.id,
            vendor: agent.vendor,
            configDir: agent.configDir,
            lastCapacityAttemptAt: undefined,
            status: {
              id: agent.id,
              vendor: agent.vendor,
              capacity: capacitySupported(agent)
                ? { state: "unknown" as const, reason: "never-read" as const }
                : { state: "unknown" as const, reason: "unsupported" as const },
              health: { state: "unknown" as const, detail: "", readAt: undefined },
            },
          },
      ),
    );
    this.#emit();
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
    // An account with no capacity source can never have a real reading — a
    // caller offering one is confused, and accepting it would put a number on
    // a row whose whole point is that no number exists.
    if (!capacitySupported(row)) return;

    row.lastCapacityAttemptAt = at;
    row.status = {
      ...row.status,
      capacity: reading.ok
        ? {
            state: "known",
            primary: reading.primary,
            secondary: reading.secondary,
            readAt: reading.readAt ?? at,
          }
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
    // Iterate a copy, same as ChangeTracker#emit: a listener added or
    // removed (by itself or another listener) during this emit must not
    // corrupt or extend the iteration in progress.
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Same isolation rule ChangeTracker applies: the panel, the startup
        // report and the voice tool all subscribe here, and one throwing
        // subscriber must not starve the others.
      }
    }
  }
}
