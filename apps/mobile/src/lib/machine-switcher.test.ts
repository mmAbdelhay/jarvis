import { describe, expect, it } from "vitest";
import type { ConnectionView } from "./connection-store";
import type { MachineOnline } from "./machine-probe";
import type { SwitchOutcome } from "./machine-sessions";
import type { MachineEntry } from "./machine-store";
import {
  type SwitcherRow,
  addMachineRowVisible,
  machineLabel,
  otherMachinesLinkVisible,
  shouldProbe,
  switcherRows,
  tapSwitcherRow,
} from "./machine-switcher";
import type { PairingRecord } from "./pairing-record";

const OPEN: ConnectionView = { state: "open", stale: false };

function record(overrides: Partial<PairingRecord> = {}): PairingRecord {
  return {
    deviceId: "a".repeat(32),
    host: "192.168.1.5",
    port: 4317,
    fingerprint: "f".repeat(64),
    pairedAt: 1,
    ...overrides,
  };
}

const ENTRIES: MachineEntry[] = [
  { id: "a_1", record: record({ laptopName: "Studio" }) },
  { id: "b_1", record: record({ host: "0.0.0.0", name: "mac.tail.ts.net", port: 7717 }) },
  { id: "c_1", record: record({ host: "10.0.0.9", port: 4318 }) },
];

function rows(
  input: Partial<Parameters<typeof switcherRows>[0]> = {},
): ReturnType<typeof switcherRows> {
  return switcherRows({
    entries: ENTRIES,
    activeId: "a_1",
    activeConnection: OPEN,
    online: new Map<string, MachineOnline>(),
    ...input,
  });
}

describe("machineLabel", () => {
  it("falls back from laptopName to the first DNS label to host", () => {
    expect(machineLabel(record({ laptopName: "Studio", name: "mac.tail.ts.net" }))).toBe("Studio");
    expect(machineLabel(record({ name: "mac.tail.ts.net" }))).toBe("mac");
    expect(machineLabel(record())).toBe("192.168.1.5");
  });
});

describe("switcherRows", () => {
  it("rows keep index order with the active marked, not moved", () => {
    const result = rows({ activeId: "b_1" });
    expect(result.map((row) => row.id)).toEqual(["a_1", "b_1", "c_1"]);
    expect(result.map((row) => row.active)).toEqual([false, true, false]);
  });

  it("the label and the subtitle: the name wins over the host", () => {
    const result = rows();
    expect(result[0]?.label).toBe("Studio");
    expect(result[0]?.subtitle).toBe("192.168.1.5");
    expect(result[1]?.label).toBe("mac");
    expect(result[1]?.subtitle).toBe("mac.tail.ts.net");
    expect(result[2]?.label).toBe("10.0.0.9");
  });

  it("active open and locked show online", () => {
    expect(rows()[0]?.online).toBe("online");
    expect(rows({ activeConnection: { state: "locked", stale: true } })[0]?.online).toBe("online");
  });

  it("active reconnecting and the rest show offline", () => {
    for (const state of ["reconnecting", "connecting", "closed", "idle", "unpaired"] as const) {
      expect(rows({ activeConnection: { state, stale: true } })[0]?.online).toBe("offline");
    }
  });

  it("the active row ignores whatever the online map says", () => {
    const online = new Map<string, MachineOnline>([["a_1", "offline"]]);
    expect(rows({ online })[0]?.online).toBe("online");
  });

  it("another row reads the online map, and is checking until it has an answer", () => {
    const online = new Map<string, MachineOnline>([
      ["b_1", "online"],
      ["c_1", "offline"],
    ]);
    const result = rows({ online });
    expect(result[1]?.online).toBe("online");
    expect(result[2]?.online).toBe("offline");
    expect(rows()[1]?.online).toBe("checking");
  });

  it("a discovered list is accepted and adds no row yet", () => {
    const result = rows({ discovered: [{ name: "new.tail.ts.net", label: "new" }] });
    expect(result.map((row) => row.id)).toEqual(["a_1", "b_1", "c_1"]);
  });

  it("one machine is one row", () => {
    expect(rows({ entries: ENTRIES.slice(0, 1) })).toHaveLength(1);
  });

  it("no active id marks nothing", () => {
    expect(rows({ activeId: undefined }).some((row) => row.active)).toBe(false);
  });
});

describe("the unlock link's visibility", () => {
  it("hidden with one machine", () => {
    expect(otherMachinesLinkVisible(ENTRIES.slice(0, 1), "a_1")).toBe(false);
  });

  it("shown with two", () => {
    expect(otherMachinesLinkVisible(ENTRIES.slice(0, 2), "a_1")).toBe(true);
  });

  it("hidden before anything is read", () => {
    expect(otherMachinesLinkVisible([], "a_1")).toBe(false);
  });

  it("shown when the machine on screen is the one that could not be read: there is a way out", () => {
    expect(otherMachinesLinkVisible(ENTRIES.slice(1, 2), "a_1")).toBe(true);
  });
});

describe("the add row", () => {
  it("shows on a phone, and not in the browser", () => {
    expect(addMachineRowVisible("native")).toBe(true);
    expect(addMachineRowVisible("web")).toBe(false);
  });
});

describe("shouldProbe", () => {
  it("only with the sheet visible and the app active", () => {
    expect(shouldProbe({ visible: true, appActive: true })).toBe(true);
    expect(shouldProbe({ visible: true, appActive: false })).toBe(false);
    expect(shouldProbe({ visible: false, appActive: true })).toBe(false);
    expect(shouldProbe({ visible: false, appActive: false })).toBe(false);
  });
});

describe("tapSwitcherRow", () => {
  function harness(switchTo?: (id: string) => Promise<SwitchOutcome>) {
    const events: string[] = [];
    const logs: string[] = [];
    return {
      events,
      logs,
      deps: {
        switchTo:
          switchTo ??
          (async (id: string): Promise<SwitchOutcome> => {
            events.push(`switch ${id}`);
            return "switched";
          }),
        close: () => events.push("close"),
        notice: () => events.push("notice"),
        log: (line: string) => logs.push(line),
      },
    };
  }

  async function settled(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const row = (active: boolean): SwitcherRow => ({
    id: "b_1",
    label: "mac",
    subtitle: "mac.tail.ts.net",
    online: "online",
    active,
  });

  it("the active row only closes", () => {
    const h = harness();
    tapSwitcherRow(row(true), h.deps);
    expect(h.events).toEqual(["close"]);
  });

  it("another row switches and closes at once, without waiting for the switch", () => {
    let finish: (outcome: SwitchOutcome) => void = () => {};
    const h = harness((id) => {
      h.events.push(`switch ${id}`);
      return new Promise<SwitchOutcome>((resolve) => {
        finish = resolve;
      });
    });
    tapSwitcherRow(row(false), h.deps);
    expect(h.events).toEqual(["close", "switch b_1"]);
    finish("switched");
  });

  it('a switch answering "unknown" gives the notice', async () => {
    const h = harness(async () => "unknown");
    tapSwitcherRow(row(false), h.deps);
    await settled();
    expect(h.events).toEqual(["close", "notice"]);
  });

  it("the other answers give no notice", async () => {
    for (const outcome of ["switched", "same", "superseded"] as const) {
      const h = harness(async () => outcome);
      tapSwitcherRow(row(false), h.deps);
      await settled();
      expect(h.events).toEqual(["close"]);
    }
  });

  it("the active row gives no notice and asks for no switch", async () => {
    const h = harness(async () => "unknown");
    tapSwitcherRow(row(true), h.deps);
    await settled();
    expect(h.events).toEqual(["close"]);
  });

  it("a switch that rejects is a fixed log line and the notice, never an unhandled rejection", async () => {
    const h = harness(() => Promise.reject(new Error("a token: secret")));
    tapSwitcherRow(row(false), h.deps);
    await settled();
    expect(h.logs).toEqual(["machines: switching from the switcher failed"]);
    expect(h.events).toEqual(["close", "notice"]);
  });
});
