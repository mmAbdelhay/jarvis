// The machine switcher's decisions. Screens stay thin: MachineSwitcher.tsx only
// lays out what these answer.

import type { ConnectionView } from "./connection-store";
import type { MachineId } from "./machine-index";
import type { MachineOnline } from "./machine-probe";
import type { MachineEntry } from "./machine-store";
import type { PairingRecord } from "./pairing-record";

/** A machine the tailnet reports and this phone does not hold. Left unfilled
 *  until step 3. */
export type DiscoveredMachine = { name: string; label: string };

export type SwitcherRow = {
  id: MachineId;
  label: string;
  subtitle: string;
  online: MachineOnline;
  active: boolean;
};

/** What a machine is called wherever one is named. */
export function machineLabel(record: PairingRecord): string {
  return record.laptopName ?? record.name?.split(".")[0] ?? record.host;
}

/** The active machine reads its own connection: `locked` has reached it. */
function activeOnline(connection: ConnectionView): MachineOnline {
  return connection.state === "open" || connection.state === "locked" ? "online" : "offline";
}

/** In index order, with the active row marked and never moved. */
export function switcherRows(input: {
  entries: MachineEntry[];
  activeId: MachineId | undefined;
  activeConnection: ConnectionView;
  online: ReadonlyMap<MachineId, MachineOnline>;
  discovered?: readonly DiscoveredMachine[];
}): SwitcherRow[] {
  return input.entries.map(({ id, record }) => {
    const active = id === input.activeId;
    return {
      id,
      label: machineLabel(record),
      subtitle: record.name ?? record.host,
      online: active ? activeOnline(input.activeConnection) : (input.online.get(id) ?? "checking"),
      active,
    };
  });
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

/** The sheet closes either way, and never waits for the switch. */
export function tapSwitcherRow(
  row: SwitcherRow,
  deps: {
    switchTo(id: MachineId): Promise<unknown>;
    close(): void;
    log(line: string): void;
  },
): void {
  deps.close();
  if (row.active) return;
  deps.switchTo(row.id).catch(() => deps.log("machines: switching from the switcher failed"));
}
