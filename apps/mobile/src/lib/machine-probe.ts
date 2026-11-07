// Whether a machine other than the one on screen answers (decision 10). A probe
// opens `/rpc` with the pairing's own trust and closes on the `open` event, with
// no `hello`: `connection.ts` fires no auth failure before hello, so it adds no
// backoff, no audit line and no idle activity, and it works for pinned pairings,
// where fetching a peer file cannot. A pin mismatch reads as offline until the
// user opens that machine and sees the banner.

import { CLOSE } from "@jarvis/wire";
import type { Clock } from "./clock";
import { endpointOf } from "./connect-stored";
import type { MachineId } from "./machine-index";
import type { MachineEntry } from "./machine-store";
import type { PairingRecord } from "./pairing-record";
import { type Transport, type TransportSocket, type Trust, socketUrl } from "./transport";

export const PROBE_TIMEOUT_MS = 2_000;
export const PROBE_INTERVAL_MS = 30_000;
export const PROBE_CONCURRENCY = 4;

export type MachineOnline = "checking" | "online" | "offline";

export function probeMachine(
  deps: { transport: Transport; clock: Clock },
  record: PairingRecord,
): Promise<"online" | "offline"> {
  const endpoint = endpointOf(record);
  const url = socketUrl(endpoint.name ?? endpoint.host, endpoint.port, "/rpc");
  const trust: Trust =
    endpoint.name === undefined
      ? { kind: "pin", fingerprint: endpoint.fingerprint }
      : { kind: "system" };

  return new Promise((resolve) => {
    let socket: TransportSocket | undefined;
    let answered = false;
    let timer: unknown;

    function closeSocket(): void {
      try {
        socket?.close(CLOSE.normal);
      } catch {
        // Gone already: it was only being closed.
      }
    }

    function finish(answer: "online" | "offline"): void {
      if (answered) return;
      answered = true;
      if (timer !== undefined) deps.clock.clearTimeout(timer);
      closeSocket();
      resolve(answer);
    }

    try {
      timer = deps.clock.setTimeout(() => finish("offline"), PROBE_TIMEOUT_MS);
      socket = deps.transport.open(url, trust, (event) => {
        if (event.kind === "open") finish("online");
        else if (event.kind === "close") finish("offline");
      });
      // Answered during the open itself: there was no socket to close yet.
      if (answered) closeSocket();
    } catch {
      finish("offline");
    }
  });
}

/** The other machines' online state, worked out only while someone listens. A
 *  round that is no longer the current one starts nothing and changes nothing,
 *  so a late answer after the last listener left is dropped. */
export function createOnlineStore(deps: {
  list(): Promise<MachineEntry[]>;
  activeId(): MachineId | undefined;
  probe(record: PairingRecord): Promise<"online" | "offline">;
  clock: Clock;
}): {
  get(): ReadonlyMap<MachineId, MachineOnline>;
  subscribe(cb: () => void): () => void;
} {
  const listeners = new Set<() => void>();
  let online: ReadonlyMap<MachineId, MachineOnline> = new Map();
  let round = 0;
  let timer: unknown;

  // A new map each time: a screen's state update sees it as a change.
  function publish(next: ReadonlyMap<MachineId, MachineOnline>): void {
    online = next;
    for (const listener of [...listeners]) listener();
  }

  function isActive(id: MachineId): boolean {
    return deps.activeId() === id;
  }

  async function probeAll(thisRound: number, entries: MachineEntry[]): Promise<void> {
    const queue = [...entries];
    async function worker(): Promise<void> {
      for (;;) {
        if (thisRound !== round) return;
        const entry = queue.shift();
        if (entry === undefined) return;
        // Asked again for each: a switch can move the active machine mid-round.
        if (isActive(entry.id)) continue;
        let answer: "online" | "offline";
        try {
          answer = await deps.probe(entry.record);
        } catch {
          answer = "offline";
        }
        if (thisRound !== round) return;
        publish(new Map(online).set(entry.id, answer));
      }
    }
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  }

  async function runRound(thisRound: number): Promise<void> {
    const startedAt = deps.clock.now();
    try {
      const entries = await deps.list();
      if (thisRound !== round) return;
      const next = new Map<MachineId, MachineOnline>();
      for (const { id } of entries) {
        if (!isActive(id)) next.set(id, online.get(id) ?? "checking");
      }
      publish(next);
      await probeAll(thisRound, entries);
    } catch {
      // A store that cannot list, or that closed: the next round asks again.
    }
    if (thisRound !== round) return;
    const wait = Math.max(0, PROBE_INTERVAL_MS - (deps.clock.now() - startedAt));
    timer = deps.clock.setTimeout(() => void runRound(thisRound), wait);
  }

  function stop(): void {
    round += 1;
    if (timer !== undefined) deps.clock.clearTimeout(timer);
    timer = undefined;
    online = new Map();
  }

  return {
    get: () => online,
    subscribe(cb) {
      listeners.add(cb);
      if (listeners.size === 1) void runRound(round);
      return () => {
        if (!listeners.delete(cb)) return;
        if (listeners.size === 0) stop();
      };
    },
  };
}
