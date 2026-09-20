import type { AgentConfig, ProviderVendor } from "../registry/types.js";
import type { ProviderStatusStore } from "./store.js";
import {
  type CapacityReading,
  type CapacityTarget,
  capacitySupported,
  type HealthReading,
  type ProviderStatus,
} from "./types.js";

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
  /** Free — a local file, a local log, or one signed-in API call; see platform/capacity-reader.ts. */
  readCapacity(target: CapacityTarget): Promise<CapacityReading>;
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
  #agents: readonly AgentConfig[];
  #refreshing: Promise<void> | undefined;
  // Whether the in-flight #refreshing pass (if any) was itself a forced
  // pass. Only relevant while #refreshing is defined; read alongside it to
  // decide whether a new forced caller has the same intent as the pass
  // already running, or needs one of its own — see refreshCapacity below.
  #refreshingForce = false;

  constructor(deps: ProviderMonitorDeps) {
    this.#deps = deps;
    this.#agents = deps.agents;
  }

  replaceAgents(agents: readonly AgentConfig[]): void {
    this.#agents = agents;
    this.#deps.store.replace(agents);
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
        this.#agents
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
   * Spends one billed query per readable, due account. Concurrent calls of
   * the *same* intent share one in-flight refresh rather than doubling the
   * bill: a second unforced caller rides the first unforced result, and a
   * second forced caller rides the first forced one, instead of starting
   * its own round of paid reads. Rejecting the second call instead would
   * only push the problem onto every caller (a startup refresh racing a
   * user's explicit refresh, or two piggyback-adjacent triggers) to
   * serialize themselves by hand, and still leaves them wanting the same
   * answer moments apart — so coalescing, not rejecting, is the correct
   * choice here, same as ChangeTracker.
   *
   * A forced call arriving while an *unforced* pass is in flight is the one
   * case that does not coalesce: riding the unforced pass would hand the
   * caller who explicitly asked for fresh data whatever the unforced pass's
   * due-list happened to include, silently dropping the force for every
   * account that pass judged not yet due. Instead the forced call awaits
   * the unforced pass, then runs its own — bypassing the throttle for every
   * readable account, same as any other forced call. This can pay twice for
   * an account the unforced pass was already fetching; that is the accepted
   * trade, favouring truth over spend for an explicit request.
   */
  async refreshCapacity(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force === true;
    const inFlight = this.#refreshing;
    if (inFlight !== undefined) {
      if (!force || this.#refreshingForce) return inFlight;
      // Mixed intent: let the unforced pass finish, then re-check state —
      // another forced call may have started its own pass while we waited.
      await inFlight;
      return this.refreshCapacity(options);
    }

    this.#refreshingForce = force;
    const run = this.#refreshCapacity(force).finally(() => {
      this.#refreshing = undefined;
    });
    this.#refreshing = run;
    return run;
  }

  async #refreshCapacity(force: boolean): Promise<void> {
    const now = this.#now();
    // `force: true` bypasses the MIN_CAPACITY_REFRESH_MS throttle and (per
    // refreshCapacity above) coalescing with an in-flight *unforced* pass.
    // It does not bypass coalescing with another in-flight *forced* pass
    // (same intent, so riding it is correct) and it does not read an
    // account that has no capacity source — there is nothing honest to
    // force there.
    const due = this.#agents.filter((agent) => {
      if (!capacitySupported(agent)) return false;
      if (force) return true;
      const last = this.#deps.store.lastCapacityReadAt(agent.id);
      return last === undefined || now - last >= MIN_CAPACITY_REFRESH_MS;
    });

    await Promise.all(
      due.map(async (agent) => {
        const vendor = agent.vendor;
        if (vendor === undefined) return;

        let reading: CapacityReading;
        try {
          reading = await this.#deps.readCapacity({
            id: agent.id,
            vendor,
            configDir: agent.configDir,
          });
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
    const agent = this.#agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined || !capacitySupported(agent)) return;
    // recordCapacity itself resets the store's lastCapacityAttemptAt, which
    // is the single source of truth refreshCapacity's due-filter reads —
    // there is no separate clock here to keep in sync with it.
    this.#deps.store.recordCapacity(agentId, reading, this.#now());
  }
}
