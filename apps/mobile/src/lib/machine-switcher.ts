// The machine switcher's decisions. Screens stay thin: MachineSwitcher.tsx only
// lays out what these answer.

import type { ClientPlatform } from "./client-platform";
import type { ConnectionView } from "./connection-store";
import type { MachineId } from "./machine-index";
import type { MachineOnline } from "./machine-probe";
import type { SwitchOutcome } from "./machine-sessions";
import type { MachineEntry } from "./machine-store";
import type { PairingRecord } from "./pairing-record";
import { DEFAULT_BRIDGE_PORT } from "./machine-address";
import { isMachineLink, machineLinkUrl } from "./web-machines";

/** A Jarvis machine the connected one found on the tailnet (tailnet-peers-store.ts).
 *  `port` is its bridge port, `webPort` the one a browser opens. */
export type DiscoveredMachine = { name: string; label: string; port: number; webPort: number };

export type SwitcherRow = {
  kind: "machine";
  id: MachineId;
  label: string;
  subtitle: string;
  online: MachineOnline;
  active: boolean;
};

/** A found machine this phone does not hold. Tapping it opens the join form
 *  with `joinText` filled in. */
export type FoundRow = { kind: "found"; label: string; subtitle: string; joinText: string };

/** The join form's name for a found machine: the port only when not the default. */
export function joinTextFor(machine: Pick<DiscoveredMachine, "name" | "port">): string {
  return machine.port === DEFAULT_BRIDGE_PORT ? machine.name : `${machine.name}:${machine.port}`;
}

/** What a machine is called wherever one is named. */
export function machineLabel(record: PairingRecord): string {
  return record.laptopName ?? record.name?.split(".")[0] ?? record.host;
}

/** The active machine reads its own connection: `locked` has reached it. */
function activeOnline(connection: ConnectionView): MachineOnline {
  return connection.state === "open" || connection.state === "locked" ? "online" : "offline";
}

/** In index order, with the active row marked and never moved, then the found
 *  machines this phone does not hold by name and bridge port. The machine on
 *  screen is one it holds, so it is never a found row. */
export function switcherRows(input: {
  entries: MachineEntry[];
  activeId: MachineId | undefined;
  activeConnection: ConnectionView;
  online: ReadonlyMap<MachineId, MachineOnline>;
  discovered?: readonly DiscoveredMachine[];
}): (SwitcherRow | FoundRow)[] {
  const held = input.entries.map(({ id, record }): SwitcherRow => {
    const active = id === input.activeId;
    return {
      kind: "machine",
      id,
      label: machineLabel(record),
      subtitle: record.name ?? record.host,
      online: active ? activeOnline(input.activeConnection) : (input.online.get(id) ?? "checking"),
      active,
    };
  });
  const found = (input.discovered ?? [])
    .filter(
      (machine) =>
        !input.entries.some(
          ({ record }) =>
            (record.name ?? record.host) === machine.name && record.port === machine.port,
        ),
    )
    .map(
      (machine): FoundRow => ({
        kind: "found",
        label: machine.label,
        subtitle: machine.name,
        joinText: joinTextFor(machine),
      }),
    );
  return [...held, ...found];
}

/** `found`: from the tailnet and not saved; it opens as a saved link does. */
export type WebSwitcherRow =
  | { kind: "self"; label: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "found"; label: string; url: string };

/** The browser's sheet: itself, its links, then the found machines it has no
 *  link to. `selfName` is the machine this page is on. No row says whether a
 *  machine is online, as the CSP forbids asking another origin. */
export function webSwitcherRows(input: {
  selfLabel: string;
  selfName?: string;
  links: readonly { name: string; port: number }[];
  discovered?: readonly DiscoveredMachine[];
}): WebSwitcherRow[] {
  const valid = input.links.filter(isMachineLink);
  const links = valid.map(
    (link): WebSwitcherRow => ({
      kind: "link",
      label: link.name.split(".")[0] as string,
      url: machineLinkUrl(link),
    }),
  );
  const found: WebSwitcherRow[] = [];
  for (const machine of input.discovered ?? []) {
    if (machine.name === input.selfName) continue;
    const link = { name: machine.name, port: machine.webPort };
    if (!isMachineLink(link)) continue;
    if (valid.some((held) => held.name === link.name && held.port === link.port)) continue;
    found.push({ kind: "found", label: machine.label, url: machineLinkUrl(link) });
  }
  return [{ kind: "self", label: input.selfLabel }, ...links, ...found];
}

/** /unlock's way out: only with a machine to go to. The one on screen may be
 *  the one that could not be read, so this counts the others rather than the
 *  list. */
export function otherMachinesLinkVisible(
  entries: readonly MachineEntry[],
  activeId: MachineId | undefined,
): boolean {
  return entries.some((entry) => entry.id !== activeId);
}

/** The browser holds one machine per origin: `webSwitcherRows` is its list. */
export function addMachineRowVisible(platform: ClientPlatform): boolean {
  return platform !== "web";
}

/** Probes run only for a sheet someone can see. `appActive` is the sessions'
 *  own answer (`MachineSessions.isAppActive`), so this has no policy of its own
 *  for what counts as the background. */
export function shouldProbe(input: { visible: boolean; appActive: boolean }): boolean {
  return input.visible && input.appActive;
}

/** The sheet closes either way, and never waits for the switch, so `notice` is
 *  all that says a machine could not be opened. */
export function tapSwitcherRow(
  row: SwitcherRow,
  deps: {
    switchTo(id: MachineId): Promise<SwitchOutcome>;
    close(): void;
    notice(): void;
    log(line: string): void;
  },
): void {
  deps.close();
  if (row.active) return;
  deps.switchTo(row.id).then(
    (outcome) => {
      if (outcome === "unknown") deps.notice();
    },
    () => {
      deps.log("machines: switching from the switcher failed");
      deps.notice();
    },
  );
}
