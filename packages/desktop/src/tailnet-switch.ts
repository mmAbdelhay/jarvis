// The Settings "Tailscale access" switch: remote:tailnetEnable and
// remote:tailnetDisable. Unlike the rest of `remote:`, this is not a saved
// draft, because turning it on needs things outside jarvis.yaml (a Funnel
// check, a certificate, Tailscale's forwards) to be true before the file says
// so. Each step that can fail runs before the write, so a refusal leaves the
// config as it was and takes back any forward it added.
import type { JarvisConfig, RemoteConfig } from "./config.js";
import { errorMessage, MESSAGES } from "./messages.js";
import { serialize } from "./serialize.js";
import type { SettingsWriteResult } from "./settings-io.js";
import {
  existingForward,
  funnelExposes,
  relayConfirmed,
  type ExistingForward,
  type RelayResult,
} from "./tailnet-guard.js";
import type { TailscaleCertResult } from "./tailscale-cert.js";

const LOOPBACK = "127.0.0.1";

/** `commands`: lines for the user to run by hand, for a forward Tailscale did
 *  not create or did not confirm removing. On success, the switch still took.
 *  `restoring`: one of those lines puts back a forward the user had.
 *  `warning`: written, but the running bridge did not take it. */
export type TailnetSwitchResult =
  | { ok: true; commands: string[]; restoring?: true; warning?: string }
  | { ok: false; text: string; language: "ar" | "en"; commands: string[] };

export type TailnetSwitch = {
  enable(relay: boolean): Promise<TailnetSwitchResult>;
  disable(): Promise<TailnetSwitchResult>;
};

/** Everything here reaches Tailscale or the bridge from compose.ts. */
export type TailnetSwitchControls = {
  /** The live `remote:` section. */
  config(): RemoteConfig;
  /** The bridge's and the web client's ports. Injected: config.ts must not
   *  load with the dispatch table, ahead of a test's scratch HOME. */
  ports(remote: RemoteConfig): number[];
  /** `tailnet-guard.ts`'s read: `undefined` is a failed one. */
  readServeStatus(): Promise<object | undefined>;
  /** `Self.TailscaleIPs`: `undefined` is a failed read. */
  readTailscaleIps(): Promise<string[] | undefined>;
  enableRelay(ports: number[]): Promise<RelayResult>;
  disableRelay(ports: number[]): Promise<RelayResult>;
  restoreForward(port: number, forward: ExistingForward): Promise<RelayResult>;
  /** Resolves once the file as written has reached the bridge. A write only
   *  queues that, and a verdict sent before it lands would be dropped. */
  applied(): Promise<void>;
  rearm(): Promise<void>;
  reloadCertificate(): Promise<void>;
  checkNow(): Promise<void>;
  log(line: string): void;
};

export type TailnetSwitchDeps = {
  language: "ar" | "en";
  hasOwnerPassword(): boolean;
  obtainCertificate(): Promise<TailscaleCertResult>;
  writeConfig(update: (current: JarvisConfig) => JarvisConfig): Promise<SettingsWriteResult>;
  controls: TailnetSwitchControls;
};

const hasCertificate = ({ tls }: RemoteConfig): boolean =>
  tls.certPath !== undefined && tls.keyPath !== undefined;

/** A port this call changed, and the forward it replaced, if any. */
type ChangedForward = { port: number; earlier: ExistingForward | undefined };

/** A change Tailscale did not confirm undoing, and whether undoing it was a restore. */
type UnconfirmedUndo = { command: string; restore: boolean };

const commandsOf = (left: UnconfirmedUndo[]): string[] => left.map(({ command }) => command);

export function createTailnetSwitch(deps: TailnetSwitchDeps): TailnetSwitch {
  const { language, controls } = deps;

  const refused = (
    text: string,
    commands: string[] = [],
  ): Extract<TailnetSwitchResult, { ok: false }> => ({ ok: false, text, language, commands });

  function certificateRefusal(failure: Extract<TailscaleCertResult, { ok: false }>): string {
    switch (failure.kind) {
      case "no-tailscale":
        return MESSAGES.remoteCertNoTailscale(language);
      case "not-connected":
        return MESSAGES.remoteCertNotConnected(language);
      case "https-disabled": {
        const { before, link, after } = MESSAGES.remoteCertHttpsDisabled(language);
        return `${before}${link}${after}`;
      }
      case "failed":
        return `${MESSAGES.remoteCertFailed(language)} ${failure.detail}`;
    }
  }

  /** The first IPv4 Tailscale says is its own. Never by address range: a
   *  carrier's interface in the same range would get password joins offered to
   *  its whole shared network. */
  async function tailscaleAddress(): Promise<string | undefined> {
    return (await controls.readTailscaleIps())?.find((ip) => !ip.includes(":"));
  }

  /** Takes each port back to what it was: its earlier forward, or none. Tries
   *  them all. Returns the commands for those Tailscale did not confirm, which
   *  are logged and never fatal. */
  async function undoForwards(changed: ChangedForward[]): Promise<UnconfirmedUndo[]> {
    const left: UnconfirmedUndo[] = [];
    for (const { port, earlier } of changed) {
      const result =
        earlier === undefined
          ? await controls.disableRelay([port])
          : await controls.restoreForward(port, earlier);
      if (!result.ok) {
        controls.log(`tailnet switch: forward not confirmed undone: ${result.command}`);
        left.push({ command: result.command, restore: earlier !== undefined });
      }
    }
    return left;
  }

  async function write(
    update: (current: JarvisConfig) => JarvisConfig,
  ): Promise<string | undefined> {
    try {
      const result = await deps.writeConfig(update);
      return result.ok ? undefined : result.detail;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /** After the write nothing is undone: a failed step is logged and the next
   *  still runs, and what became of it shows in RemoteStatus. False if it failed. */
  async function settled(step: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      controls.log(`tailnet switch: ${step} failed: ${errorMessage(error)}`);
      return false;
    }
  }

  const notApplied = (change: "on" | "off", applied: boolean): { warning?: string } =>
    applied ? {} : { warning: MESSAGES.remoteTailnetNotApplied(change, language) };

  async function enable(relay: boolean): Promise<TailnetSwitchResult> {
    if (!deps.hasOwnerPassword()) {
      return refused(MESSAGES.remoteTailnetRefused("no-owner-password", language));
    }

    const remote = controls.config();
    const ports = controls.ports(remote);
    const serve = await controls.readServeStatus();
    if (serve === undefined) {
      return refused(MESSAGES.remoteTailnetRefused("funnel-unread", language));
    }
    if (funnelExposes(serve, ports)) {
      return refused(MESSAGES.remoteTailnetRefused("funnel", language));
    }

    // Without the relay Jarvis binds the Tailscale address itself, and a plain
    // forward on these ports would be left pointing at a loopback port nothing
    // listens on. Only the relay replaces a forward and puts it back.
    if (!relay && ports.some((port) => existingForward(serve, port) !== undefined)) {
      return refused(MESSAGES.remoteTailnetRefused("forward-present", language));
    }

    // Before the certificate, the first step that leaves anything on disk.
    const bindAddress = relay ? LOOPBACK : await tailscaleAddress();
    if (bindAddress === undefined) {
      return refused(MESSAGES.remoteTailnetRefused("no-address", language));
    }

    let issued: { certPath: string; keyPath: string } | undefined;
    if (!hasCertificate(remote)) {
      const certificate = await deps.obtainCertificate();
      if (!certificate.ok) return refused(certificateRefusal(certificate));
      issued = { certPath: certificate.certPath, keyPath: certificate.keyPath };
    }

    // A relay forward already in place (an earlier `off` that did not take)
    // is left alone. Any other forward on the port is replaced, so a rollback
    // puts that one back rather than deleting what the user had.
    const changed: ChangedForward[] = [];
    if (relay) {
      for (const port of ports) {
        if (relayConfirmed(serve, [port])) continue;
        const earlier = existingForward(serve, port);
        const forward = await controls.enableRelay([port]);
        if (!forward.ok) {
          const left = await undoForwards(changed);
          return refused(MESSAGES.remoteTailnetRefused("relay-failed", language), [
            forward.command,
            ...commandsOf(left),
          ]);
        }
        changed.push({ port, earlier });
      }
    }

    // Read inside the serialized write, against the file as it then is. The
    // same paths mean no new key for the bridge to notice the change by.
    let replacedInPlace = false;
    const failure = await write((current) => {
      const { tls, tailnet } = current.remote;
      replacedInPlace =
        issued !== undefined && tls.certPath === issued.certPath && tls.keyPath === issued.keyPath;
      // For the disable. An enable while already on replaces nothing new, and
      // must not forget what the first one replaced.
      const replacedForwards: Record<string, ExistingForward> = {
        ...(tailnet.enabled ? tailnet.replacedForwards : {}),
      };
      for (const { port, earlier } of changed) {
        if (earlier !== undefined) replacedForwards[port] = earlier;
      }
      // The same: what the first enable overwrote, never its own address.
      const bindBeforeEnable = tailnet.enabled
        ? tailnet.bindBeforeEnable
        : current.remote.bindAddress;
      return {
        ...current,
        remote: {
          ...current.remote,
          enabled: true,
          bindAddress,
          web: { ...current.remote.web, enabled: true },
          tailnet: {
            enabled: true,
            relay,
            ...(Object.keys(replacedForwards).length === 0 ? {} : { replacedForwards }),
            ...(bindBeforeEnable === undefined ? {} : { bindBeforeEnable }),
          },
          ...(issued === undefined ? {} : { tls: issued }),
        },
      };
    });
    if (failure !== undefined) {
      const left = await undoForwards(changed);
      return refused(
        MESSAGES.remoteTailnetRefused("write-failed", language, failure),
        commandsOf(left),
      );
    }

    const applied = await settled("apply", () => controls.applied());
    await settled("rearm", () => controls.rearm());
    if (replacedInPlace) await settled("certificate reload", () => controls.reloadCertificate());
    await settled("check", () => controls.checkNow());
    return { ok: true, commands: [], ...notApplied("on", applied) };
  }

  async function disable(): Promise<TailnetSwitchResult> {
    let change: { forwards: ChangedForward[] } | undefined;
    const failure = await write((current) => {
      const { enabled, relay, replacedForwards = {}, bindBeforeEnable } = current.remote.tailnet;
      if (!enabled) return current;
      // Only what Jarvis added is removed: a recorded port goes back to the
      // user's own forward, even if the config has moved off it since.
      const ports = new Set([
        ...(relay ? controls.ports(current.remote) : []),
        ...Object.keys(replacedForwards).map(Number),
      ]);
      change = {
        forwards: [...ports].map((port) => ({ port, earlier: replacedForwards[port] })),
      };
      return {
        ...current,
        remote: {
          ...current.remote,
          bindAddress: bindBeforeEnable ?? current.remote.bindAddress,
          tailnet: { enabled: false, relay },
        },
      };
    });
    if (failure !== undefined) {
      return refused(MESSAGES.remoteTailnetRefused("write-failed", language, failure));
    }
    if (change === undefined) return { ok: true, commands: [] };

    const applied = await settled("apply", () => controls.applied());
    const left = await undoForwards(change.forwards);
    return {
      ok: true,
      commands: commandsOf(left),
      ...(left.some(({ restore }) => restore) ? { restoring: true as const } : {}),
      ...notApplied("off", applied),
    };
  }

  // One at a time: an enable's checks would otherwise answer for a config a
  // disable had already moved on from.
  const oneAtATime = serialize((run: () => Promise<TailnetSwitchResult>) => run());
  return {
    enable: (relay) => oneAtATime(() => enable(relay)),
    disable: () => oneAtATime(disable),
  };
}
