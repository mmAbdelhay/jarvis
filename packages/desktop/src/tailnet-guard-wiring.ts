// How the core connects the Tailscale guard to the bridge. Apart from
// compose.ts, which cannot be built in a test, so that
// tailnet-guard-wiring.test.ts drives this exact wiring over a real bridge.
import { effectiveWebPort, type RemoteConfig } from "./config.js";
import type { RemoteAccess } from "./remote-access.js";
import { createTailnetGuard, type TailnetGuard, type TailnetGuardDeps } from "./tailnet-guard.js";

export type RemoteTailnetGuardDeps = Pick<
  TailnetGuardDeps,
  "tailscale" | "certificateExpiry" | "timers" | "now" | "log"
> & {
  /** The live `remote:` section. */
  remote(): RemoteConfig;
  access: Pick<
    RemoteAccess,
    "setTailnetBlock" | "tailnetReadFailed" | "retryListener" | "reloadCertificate" | "status"
  >;
};

export function createRemoteTailnetGuard(deps: RemoteTailnetGuardDeps): TailnetGuard {
  const { remote, access, tailscale, certificateExpiry, timers, now, log } = deps;
  return createTailnetGuard({
    tailscale,
    // The bridge's own switch: it drops a Funnel verdict and clears the latch
    // when either one is off.
    enabled: () => remote().enabled && remote().tailnet.enabled,
    relay: () => remote().tailnet.relay,
    ports: () => [remote().port, effectiveWebPort(remote())],
    setTailnetBlock: (reason) => access.setTailnetBlock(reason),
    unverified: () => {
      const { tailnet } = access.status();
      return tailnet.kind === "blocked" && tailnet.reason === "unverified";
    },
    readFailed: () => access.tailnetReadFailed(),
    retryListener: () => access.retryListener(),
    reloadCertificate: () => access.reloadCertificate(),
    connectedDevices: () => access.status().devices.filter((device) => device.connected).length,
    certificate: () => remote().tls,
    certificateExpiry,
    timers,
    now,
    log,
  });
}

/** Every apply can clear the bridge's Funnel latch, so each one is followed
 *  by a fresh verdict. Awaited, so the next apply cannot pass it. */
export async function applyRemoteThenCheck(
  access: Pick<RemoteAccess, "apply">,
  guard: Pick<TailnetGuard, "checkNow">,
  next: RemoteConfig,
): Promise<void> {
  await access.apply(next);
  await guard.checkNow();
}
