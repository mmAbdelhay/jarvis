// The Jarvis machines the connected machine found on the tailnet, from
// `tailnet:peers` (its core caches the answer for 30 s). The reply is rebuilt
// field by field from `unknown` (awake-store.ts's discipline): a bad entry is
// dropped alone and a bad or failed reply is no machines, never a throw. Each
// name must be an exact tailnet address, as a found row reaches the join form
// and, in the browser, `window.location.assign`.

import type { Clock } from "./clock";
import { DEFAULT_BRIDGE_PORT, DEFAULT_WEB_PORT, parseMachineAddress } from "./machine-address";
import type { DiscoveredMachine } from "./machine-switcher";
import type { RpcClient } from "./rpc-client";

export const DISCOVER_INTERVAL_MS = 30_000;

function isExactAddress(name: unknown, port: unknown, defaultPort: number): name is string {
  if (typeof name !== "string" || typeof port !== "number") return false;
  const address = parseMachineAddress(`${name}:${port}`, defaultPort);
  return address.kind === "ok" && address.name === name && address.port === port;
}

function parseMachine(value: unknown): DiscoveredMachine | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { name, label, bridgePort, webPort } = value as Record<string, unknown>;
  if (!isExactAddress(name, bridgePort, DEFAULT_BRIDGE_PORT)) return undefined;
  if (!isExactAddress(name, webPort, DEFAULT_WEB_PORT)) return undefined;
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim();
  return {
    name,
    label: trimmed.length > 0 ? trimmed : (name.split(".")[0] as string),
    port: bridgePort as number,
    webPort: webPort as number,
  };
}

/** Only an `ok` answer lists machines. */
export function parseDiscovered(value: unknown): DiscoveredMachine[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const { state, machines } = value as Record<string, unknown>;
  if (state !== "ok" || !Array.isArray(machines)) return [];
  const kept: DiscoveredMachine[] = [];
  for (const entry of machines) {
    const machine = parseMachine(entry);
    if (machine === undefined) continue;
    if (kept.some((other) => other.name === machine.name && other.port === machine.port)) continue;
    kept.push(machine);
  }
  return kept;
}

export async function fetchDiscovered(
  client: Pick<RpcClient, "call">,
): Promise<DiscoveredMachine[]> {
  try {
    const result = await client.call("tailnet:peers", []);
    return result.ok ? parseDiscovered(result.value) : [];
  } catch {
    return [];
  }
}

/** Asks at once and every `DISCOVER_INTERVAL_MS` until the returned stop, after
 *  which a reply still on its way is ignored. The caller starts it only while
 *  `shouldProbe` holds. */
export function startDiscoveredPoll(deps: {
  fetch(): Promise<DiscoveredMachine[]>;
  clock: Clock;
  onFound(machines: DiscoveredMachine[]): void;
}): () => void {
  let stopped = false;
  let timer: unknown;

  function round(): void {
    if (stopped) return;
    timer = deps.clock.setTimeout(round, DISCOVER_INTERVAL_MS);
    void deps.fetch().then(
      (machines) => {
        if (!stopped) deps.onFound(machines);
      },
      () => undefined,
    );
  }

  round();
  return () => {
    stopped = true;
    deps.clock.clearTimeout(timer);
  };
}
