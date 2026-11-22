// Finds the other Jarvis machines on this user's tailnet for `tailnet:peers`.
// Tailscale says which peers exist; each candidate's own web listener says
// whether it is a Jarvis machine (`/jarvis-peer.json`), and only a reply that
// names the very machine that was asked is kept. Probes always address the
// DNS name, never an IP: the web listener checks `Host` exactly, and the
// name is what the certificate is issued for.
import { get } from "node:https";
import { HOSTNAME_PATTERN, type TailnetMachine, type TailnetPeers } from "@jarvis/wire";
import { findTailscaleCli, type TailscaleCertDeps } from "./tailscale-cert.js";

export type TailnetPeersDeps = {
  tailscale: TailscaleCertDeps;
  /** Resolves with the parsed `/jarvis-peer.json` body, rejects on any
   *  failure — probePeerFile below is the real one. */
  probe: (name: string, port: number, timeoutMs: number) => Promise<unknown>;
  now: () => number;
};

export type TailnetPeersFinder = { list(): Promise<TailnetPeers> };

// The full status, peers included: a big tailnet's list is far larger than
// the `--peers=false` reads in tailscale-cert.ts.
const STATUS_LIMITS = { timeoutMs: 10_000, maxOutputBytes: 4_000_000 };
const WEB_PORT = 7718;
const PROBE_TIMEOUT_MS = 2_000;
const CACHE_MS = 30_000;
const MAX_PEER_FILE_BYTES = 4_096;
const TAILNET_SUFFIX = ".ts.net";
// The machine, its tailnet, "ts", "net".
const MIN_TAILNET_LABELS = 4;
const MAX_PORT = 65_535;

const NOT_RUNNING: TailnetPeers = { state: "not-running", machines: [] };

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PORT;
}

/** A tailnet name a phone's join would accept (apps/mobile's machine-address.ts). */
function isTailnetName(name: string): boolean {
  return (
    HOSTNAME_PATTERN.test(name) &&
    name.endsWith(TAILNET_SUFFIX) &&
    name.split(".").length >= MIN_TAILNET_LABELS
  );
}

/** The same checks as apps/mobile's web-machines.ts `peerFrom`, plus the
 *  reply naming the machine that was asked. */
function machineFrom(value: unknown, expectedName: string): TailnetMachine | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, label, v, bridgePort, webPort } = value as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    typeof label !== "string" ||
    typeof v !== "number" ||
    !isPort(bridgePort) ||
    !isPort(webPort) ||
    name !== expectedName ||
    !isTailnetName(name)
  ) {
    return undefined;
  }
  return { name, label, v, bridgePort, webPort };
}

function stripDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The DNS names worth probing, or `undefined` when the status says
 *  Tailscale is not up. */
function candidatesFrom(stdout: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const status = asRecord(parsed);
  if (status === undefined || status["BackendState"] !== "Running") return undefined;
  const self = asRecord(status["Self"]);
  const userId = self?.["UserID"];
  if (self === undefined || typeof userId !== "number") return undefined;
  const selfName = typeof self["DNSName"] === "string" ? stripDot(self["DNSName"]) : undefined;

  const names = new Set<string>();
  for (const value of Object.values(asRecord(status["Peer"]) ?? {})) {
    const entry = asRecord(value);
    if (entry === undefined) continue;
    const tags = entry["Tags"];
    const dnsName = entry["DNSName"];
    if (entry["UserID"] !== userId) continue;
    if (tags !== undefined && tags !== null && !(Array.isArray(tags) && tags.length === 0)) {
      continue;
    }
    if (entry["Online"] !== true) continue;
    if (typeof dnsName !== "string") continue;
    const name = stripDot(dnsName);
    if (name === "" || name === selfName) continue;
    names.add(name);
  }
  return [...names];
}

function byLabelThenName(a: TailnetMachine, b: TailnetMachine): number {
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function findPeers(deps: TailnetPeersDeps): Promise<TailnetPeers> {
  const cli = await findTailscaleCli(deps.tailscale);
  if (cli === undefined) return { state: "no-cli", machines: [] };

  let result: { code: number; stdout: string };
  try {
    result = await deps.tailscale.exec(cli, ["status", "--json"], STATUS_LIMITS);
  } catch {
    return NOT_RUNNING;
  }
  if (result.code !== 0) return NOT_RUNNING;
  const candidates = candidatesFrom(result.stdout);
  if (candidates === undefined) return NOT_RUNNING;

  const found = await Promise.all(
    candidates.map(async (name) => {
      try {
        return machineFrom(await deps.probe(name, WEB_PORT, PROBE_TIMEOUT_MS), name);
      } catch {
        return undefined;
      }
    }),
  );
  const machines = found.filter((m): m is TailnetMachine => m !== undefined);
  machines.sort(byLabelThenName);
  return { state: "ok", machines };
}

/**
 * The last answer is reused for 30 s, and callers that arrive while a run is
 * in flight share it: one `tailscale status` and one probe round each time.
 */
export function createTailnetPeers(deps: TailnetPeersDeps): TailnetPeersFinder {
  let cached: { at: number; value: TailnetPeers } | undefined;
  let inFlight: Promise<TailnetPeers> | undefined;

  return {
    list() {
      if (cached !== undefined && deps.now() - cached.at <= CACHE_MS) {
        return Promise.resolve(cached.value);
      }
      if (inFlight !== undefined) return inFlight;
      const run = findPeers(deps)
        .catch((): TailnetPeers => NOT_RUNNING)
        .then((value) => {
          cached = { at: deps.now(), value };
          return value;
        })
        .finally(() => {
          inFlight = undefined;
        });
      inFlight = run;
      return run;
    },
  };
}

/**
 * GETs `https://<name>:<port>/jarvis-peer.json` with the system trust store
 * (no custom CA, certificate checks left on) and parses it. Rejects on a
 * non-200 answer, a body over 4 KB, bad JSON, or no answer within
 * `timeoutMs`.
 */
export function probePeerFile(name: string, port: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(value);
      else reject(error);
    };
    const request = get(
      { host: name, port, path: "/jarvis-peer.json", headers: { accept: "application/json" } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          request.destroy();
          finish(new Error(`peer file: status ${response.statusCode ?? "unknown"}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PEER_FILE_BYTES) {
            request.destroy();
            finish(new Error("peer file: too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            finish(new Error("peer file: not JSON"));
          }
        });
        response.on("error", (error) => finish(error));
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish(new Error("peer file: timed out"));
    }, timeoutMs);
    request.on("error", (error) => finish(error));
  });
}
