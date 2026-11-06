// Watches what Tailscale itself is doing with Jarvis's ports while Tailscale
// access is on: Funnel would put them on the public internet, and a relay
// whose forward went away (or lost PROXY) would report every peer as loopback.
// Also keeps the certificate renewed. Every `tailscale` call goes through the
// injected `TailscaleExec`, so no test runs the real CLI.
import { join } from "node:path";
import type { Timers } from "@jarvis/remote";
import { errorMessage } from "./messages.js";
import { serialize } from "./serialize.js";
import {
  defaultCertDir,
  findTailscaleCli,
  issueCertificate,
  tailnetName,
  type TailscaleCertDeps,
} from "./tailscale-cert.js";

const POLL_INTERVAL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Renew when less than this is left. */
const RENEW_UNDER_MS = 30 * DAY_MS;
/** Stop waiting for connected devices to leave when this much is left. */
const FORCE_RELOAD_AT_MS = 7 * DAY_MS;
const SERVE_LIMITS = { timeoutMs: 10_000, maxOutputBytes: 1_000_000 };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The port of a Tailscale target in any form it accepts: `http://host:port`,
 * `https://host:port`, `https+insecure://host:port`, `host:port` or a bare
 * port. Not `URL`, which hides a scheme's default port and reads `localhost:`
 * as a scheme.
 */
function targetPort(target: unknown): number | undefined {
  if (typeof target !== "string") return undefined;
  const text = target.trim();
  const afterScheme = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const afterHost = /^(?:\[[^\]]*\]|[^:]*):(\d+)$/.exec(hostPort)?.[1];
  // With a scheme a lone number is a host: `http://7717` says nothing of a port.
  const bare = afterScheme === text && /^\d+$/.test(hostPort) ? hostPort : undefined;
  const port = Number(afterHost ?? bare);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/**
 * Whether Funnel carries a port in `ports`: for each `AllowFunnel` key
 * `host:port`, its `TCP[port].TCPForward` and every `Web[host:port]` handler's
 * `Proxy`. An unknown shape is false, never a throw.
 */
export function funnelExposes(serveStatus: unknown, ports: number[]): boolean {
  const status = asRecord(serveStatus);
  const allowed = asRecord(status?.["AllowFunnel"]);
  if (status === undefined || allowed === undefined) return false;
  const tcp = asRecord(status["TCP"]);
  const web = asRecord(status["Web"]);
  const carried = (target: unknown): boolean => {
    const port = targetPort(target);
    return port !== undefined && ports.includes(port);
  };

  for (const [hostPort, allow] of Object.entries(allowed)) {
    if (allow !== true) continue;
    const funnelPort = /:(\d+)$/.exec(hostPort)?.[1];
    if (funnelPort !== undefined && carried(asRecord(tcp?.[funnelPort])?.["TCPForward"])) {
      return true;
    }
    const handlers = asRecord(asRecord(web?.[hostPort])?.["Handlers"]);
    for (const handler of Object.values(handlers ?? {})) {
      if (carried(asRecord(handler)?.["Proxy"])) return true;
    }
  }
  return false;
}

/** Whether each port forwards to itself on loopback, with PROXY v2 on. */
export function relayConfirmed(serveStatus: unknown, ports: number[]): boolean {
  const tcp = asRecord(asRecord(serveStatus)?.["TCP"]);
  return ports.every((port) => {
    const entry = asRecord(tcp?.[String(port)]);
    return entry?.["TCPForward"] === `127.0.0.1:${port}` && entry["ProxyProtocol"] === 2;
  });
}

export type RelayResult = { ok: true } | { ok: false; command: string };

const enableArgs = (port: number): string[] => [
  "serve",
  "--bg",
  `--tcp=${port}`,
  "--proxy-protocol=2",
  `tcp://127.0.0.1:${port}`,
];
const disableArgs = (port: number): string[] => ["serve", `--tcp=${port}`, "off"];
/** The line for a person to run: `tailscale` by name, whatever path found it here. */
const byHand = (args: string[]): string => `tailscale ${args.join(" ")}`;

async function ran(deps: TailscaleCertDeps, cli: string, args: string[]): Promise<boolean> {
  try {
    return (await deps.exec(cli, args, SERVE_LIMITS)).code === 0;
  } catch {
    return false;
  }
}

/** Forwards each port to itself with PROXY v2, stopping at the first refusal. */
export async function enableRelay(deps: TailscaleCertDeps, ports: number[]): Promise<RelayResult> {
  const cli = await findTailscaleCli(deps);
  for (const port of ports) {
    const args = enableArgs(port);
    if (cli === undefined || !(await ran(deps, cli, args))) {
      return { ok: false, command: byHand(args) };
    }
  }
  return { ok: true };
}

/** Removes the forward of each given port and no other, trying them all. */
export async function disableRelay(deps: TailscaleCertDeps, ports: number[]): Promise<RelayResult> {
  const cli = await findTailscaleCli(deps);
  let failed: string | undefined;
  for (const port of ports) {
    const args = disableArgs(port);
    if (cli === undefined || !(await ran(deps, cli, args))) failed ??= byHand(args);
  }
  return failed === undefined ? { ok: true } : { ok: false, command: failed };
}

type Verdict = "funnel" | "relay-missing" | undefined;

export type TailnetGuardDeps = {
  tailscale: TailscaleCertDeps;
  /** `remote.tailnet.enabled`. While false the guard does nothing at all. */
  enabled(): boolean;
  /** `remote.tailnet.relay`. */
  relay(): boolean;
  /** The bridge's and the web client's ports. */
  ports(): number[];
  setTailnetBlock(reason: Verdict): Promise<void>;
  reloadCertificate(): Promise<void>;
  connectedDevices(): number;
  certificate(): { certPath?: string; keyPath?: string };
  /** Epoch milliseconds; rejects when the file cannot be read or parsed. */
  certificateExpiry(certPath: string): Promise<number>;
  timers: Timers;
  now(): number;
  log(line: string): void;
};

export type TailnetGuard = {
  start(): void;
  stop(): void;
  /** Reads Tailscale now and sends the verdict even if it has not changed.
   *  For after every enable: the bridge drops a verdict that arrives with its
   *  switch off, and off-then-on clears its Funnel latch, so what was last
   *  sent says nothing about what it holds. Never rejects. */
  checkNow(): Promise<void>;
};

/** Reads `serve status --json` (Funnel settings are in the same document).
 *  `undefined` is a failed read. No config at all is a successful read of an
 *  empty one, which Tailscale's JSON can spell `null`. */
async function readServeStatus(deps: TailscaleCertDeps): Promise<object | undefined> {
  const cli = await findTailscaleCli(deps);
  if (cli === undefined) return undefined;
  try {
    const result = await deps.exec(cli, ["serve", "status", "--json"], SERVE_LIMITS);
    if (result.code !== 0) return undefined;
    const parsed: unknown = JSON.parse(result.stdout);
    return parsed === null ? {} : asRecord(parsed);
  } catch {
    return undefined;
  }
}

export function createTailnetGuard(deps: TailnetGuardDeps): TailnetGuard {
  // No verdict the bridge can be assumed to hold, so the next one is sent.
  const UNSENT = Symbol("unsent");
  let lastSent: Verdict | typeof UNSENT = UNSENT;
  let readFailureLogged = false;

  let started = false;
  let stopped = false;
  let timer: unknown;

  let nextRenewalCheckAt = 0;
  // Set once the files are renewed and until the bridge has reloaded them.
  // Holds the expiry of the certificate still being served: the one on disk
  // is fresh by then, so it cannot say when the reload stops being optional.
  let pendingReload: { servedNotAfter: number } | undefined;

  // One read and verdict at a time, so a checkNow during a poll reads afresh
  // after it, and that poll's older answer cannot land last.
  const evaluate = serialize(async (force: boolean): Promise<void> => {
    if (force) lastSent = UNSENT;
    if (stopped) return;
    if (!deps.enabled()) {
      lastSent = UNSENT;
      return;
    }
    const status = await readServeStatus(deps.tailscale);
    if (stopped || !deps.enabled()) return;
    if (status === undefined) {
      if (!readFailureLogged) {
        readFailureLogged = true;
        deps.log("tailnet guard: cannot read Tailscale serve status; keeping the last verdict");
      }
      return;
    }
    readFailureLogged = false;

    const ports = deps.ports();
    const verdict: Verdict = funnelExposes(status, ports)
      ? "funnel"
      : deps.relay() && !relayConfirmed(status, ports)
        ? "relay-missing"
        : undefined;
    if (verdict === lastSent) return;
    try {
      await deps.setTailnetBlock(verdict);
      lastSent = verdict;
    } catch (error) {
      lastSent = UNSENT;
      deps.log(`tailnet guard: could not apply the verdict: ${errorMessage(error)}`);
    }
  });

  /** Only into the pair Tailscale issued here, which Settings also manages:
   *  any other files named in the config are the user's own. */
  async function renew(certPath: string, keyPath: string): Promise<boolean> {
    const tailscale = deps.tailscale;
    const cli = await findTailscaleCli(tailscale);
    const name = cli === undefined ? undefined : await tailnetName(tailscale, cli);
    if (cli === undefined || name === undefined) {
      deps.log("tailnet guard: cannot renew the certificate: Tailscale is not available");
      return false;
    }
    const dir = defaultCertDir(tailscale);
    if (join(dir, `${name}.crt`) !== certPath || join(dir, `${name}.key`) !== keyPath) {
      deps.log("tailnet guard: not renewing a certificate Jarvis did not issue");
      return false;
    }
    const result = await issueCertificate(tailscale, cli, { name, dir });
    if (!result.ok) {
      deps.log(`tailnet guard: certificate renewal failed: ${result.detail}`);
    }
    return result.ok;
  }

  async function dailyRenewalCheck(): Promise<void> {
    const now = deps.now();
    nextRenewalCheckAt = now + DAY_MS;
    const { certPath, keyPath } = deps.certificate();
    if (certPath === undefined || keyPath === undefined) return;
    let servedNotAfter: number;
    try {
      servedNotAfter = await deps.certificateExpiry(certPath);
    } catch (error) {
      deps.log(`tailnet guard: cannot read the certificate's expiry: ${errorMessage(error)}`);
      return;
    }
    if (stopped || !deps.enabled() || servedNotAfter - now >= RENEW_UNDER_MS) return;
    if (await renew(certPath, keyPath)) pendingReload = { servedNotAfter };
  }

  async function reloadIfDue(): Promise<void> {
    if (pendingReload === undefined || stopped || !deps.enabled()) return;
    const forced = deps.now() >= pendingReload.servedNotAfter - FORCE_RELOAD_AT_MS;
    if (!forced && deps.connectedDevices() !== 0) return;
    try {
      await deps.reloadCertificate();
      pendingReload = undefined;
    } catch (error) {
      deps.log(`tailnet guard: certificate reload failed: ${errorMessage(error)}`);
    }
  }

  async function renewalStep(): Promise<void> {
    if (stopped || !deps.enabled()) return;
    if (pendingReload === undefined && deps.now() >= nextRenewalCheckAt) {
      await dailyRenewalCheck();
    }
    await reloadIfDue();
  }

  /** The next one is armed only when this one is done, so polls cannot overlap. */
  async function poll(): Promise<void> {
    try {
      await evaluate(false);
      await renewalStep();
    } catch (error) {
      deps.log(`tailnet guard: poll failed: ${errorMessage(error)}`);
    }
    if (!stopped) {
      timer = deps.timers.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    }
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      void poll();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) deps.timers.clearTimeout(timer);
    },
    async checkNow() {
      try {
        await evaluate(true);
      } catch (error) {
        deps.log(`tailnet guard: check failed: ${errorMessage(error)}`);
      }
    },
  };
}
