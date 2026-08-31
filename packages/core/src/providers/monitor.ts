import type { AgentConfig, ProviderVendor } from "../registry/types.js";
import type { ProviderStatusStore } from "./store.js";
import type { CapacityReading, HealthReading, ProviderStatus } from "./types.js";

/**
 * The floor between two PAID capacity reads of the same account. It is not a
 * poll interval — nothing in this codebase polls capacity — it is the guard
 * that stops a user holding down the refresh button, or two refresh triggers
 * landing together, from spending a query per click.
 */
export const MIN_CAPACITY_REFRESH_MS = 60_000;

export type ProviderMonitorDeps = {
  agents: readonly AgentConfig[];
  store: ProviderStatusStore;
  /** Costs a real, billed API round trip. See platform/capacity.ts. */
  readCapacity(configDir: string): Promise<CapacityReading>;
  /** Free: an unauthenticated public JSON endpoint. */
  readHealth(vendor: ProviderVendor): Promise<HealthReading>;
  now?(): number;
};

/**
 * Owns the refresh POLICY, and nothing else — no timers (intervals belong to
 * desktop's buildWiring, following ChangeTracker), no network, no formatting.
 *
 * The policy, in full — the only place a billed capacity call may happen:
 *  - once at startup (the app's first refreshCapacity() call),
 *  - on explicit user demand (refreshCapacity({ force: true })),
 *  - free, as a side effect of a query someone else already paid for
 *    (recordPiggyback — Task 7's brain queries), and
 *  - a routine, non-forced refreshCapacity() re-reads an account only once
 *    MIN_CAPACITY_REFRESH_MS has passed since its last attempt.
 *  Capacity is NEVER put on a timer. Health is free (a public status page),
 *  so desktop is free to poll refreshHealth() on an interval.
 */
export class ProviderMonitor {
  readonly #deps: ProviderMonitorDeps;
  readonly #lastAttempt = new Map<string, number>();
  #refreshing: Promise<void> | undefined;

  constructor(deps: ProviderMonitorDeps) {
    this.#deps = deps;
  }

  snapshot(): ProviderStatus[] {
    return this.#deps.store.snapshot();
  }

  onChange(listener: (statuses: ProviderStatus[]) => void): () => void {
    return this.#deps.store.onChange(listener);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  async refreshHealth(): Promise<void> {
    const vendors = [
      ...new Set(
        this.#deps.agents
          .map((agent) => agent.vendor)
          .filter((vendor): vendor is ProviderVendor => vendor !== undefined),
      ),
    ];

    await Promise.all(
      vendors.map(async (vendor) => {
        let reading: HealthReading;
        try {
          reading = await this.#deps.readHealth(vendor);
        } catch {
          // readStatusPage already contracts never to reject; this is the
          // same house rule ChangeTracker.refresh applies (ruling P15) — do
          // not trust a contract at the call site when the cost of being
          // wrong is an unhandled rejection in the main process.
          reading = { state: "unknown", detail: "" };
        }
        this.#deps.store.recordHealth(vendor, reading, this.#now());
      }),
    );
  }

  /**
   * Spends one billed query per readable, due account. Concurrent calls
   * share one in-flight refresh rather than doubling the bill: a second
   * caller rides the first's result instead of starting its own round of
   * paid reads. Rejecting the second call instead would only push the
   * problem onto every caller (a startup refresh racing a user's explicit
   * refresh, or two piggyback-adjacent triggers) to serialize themselves by
   * hand, and still leaves them wanting the same answer moments apart — so
   * coalescing, not rejecting, is the correct choice here, same as
   * ChangeTracker.
   */
  async refreshCapacity(options: { force?: boolean } = {}): Promise<void> {
    if (this.#refreshing !== undefined) return this.#refreshing;
    const run = this.#refreshCapacity(options.force === true).finally(() => {
      this.#refreshing = undefined;
    });
    this.#refreshing = run;
    return run;
  }

  async #refreshCapacity(force: boolean): Promise<void> {
    const now = this.#now();
    // `force: true` bypasses only the MIN_CAPACITY_REFRESH_MS throttle. It
    // does not bypass the re-entrancy guard above (a forced call still
    // coalesces with one already in flight) and it does not read an account
    // that has no configDir — there is nothing honest to force there.
    const due = this.#deps.agents.filter((agent) => {
      if (agent.configDir === undefined) return false;
      if (force) return true;
      const last = this.#lastAttempt.get(agent.id);
      return last === undefined || now - last >= MIN_CAPACITY_REFRESH_MS;
    });

    await Promise.all(
      due.map(async (agent) => {
        const configDir = agent.configDir;
        if (configDir === undefined) return;
        // Recorded before the call resolves: a failing account must not be
        // retried (and rebilled) every cycle just because it never earns a
        // "last success" timestamp (store.lastCapacityReadAt tracks
        // attempts, not successes, for the same reason).
        this.#lastAttempt.set(agent.id, this.#now());

        let reading: CapacityReading;
        try {
          reading = await this.#deps.readCapacity(configDir);
        } catch {
          // readCapacity is contracted to resolve with { ok: false } rather
          // than throw, but Phase 1's Task 4 fix round and P11's hardening
          // of ChangeTracker both exist because a call site that trusted
          // that contract anyway took down every other account's reading
          // with it. Catch per-account so one throw never costs the others.
          reading = { ok: false, reason: "unavailable" };
        }
        this.#deps.store.recordCapacity(agent.id, reading, this.#now());
      }),
    );
  }

  /**
   * A reading obtained for free, as a side effect of a query someone already
   * paid for (Task 7's brain query). It is a real reading, so it also resets
   * that account's paid-refresh clock — otherwise the very next refresh
   * would spend a query buying the number we were just handed for free.
   */
  recordPiggyback(agentId: string, reading: CapacityReading): void {
    const agent = this.#deps.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined || agent.configDir === undefined) return;
    this.#lastAttempt.set(agentId, this.#now());
    this.#deps.store.recordCapacity(agentId, reading, this.#now());
  }
}
