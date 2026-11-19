// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TailnetMachine, TailnetPeers } from "@jarvis/wire";
import type { MachineViewState } from "../src/machine-views.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import { MACHINE_POLL_MS, initMachineSwitcher } from "./machine-switcher.js";
import { TOPBAR_COLLAPSE_ORDER } from "./topbar-fit.js";

const en = PRIMARY_LANGUAGE;

function machine(patch: Partial<TailnetMachine> = {}): TailnetMachine {
  return {
    name: "studio.tail1234.ts.net",
    label: "Studio",
    v: 1,
    bridgePort: 7717,
    webPort: 7718,
    ...patch,
  };
}

function layout(): void {
  document.body.innerHTML = `
    <div class="topbar">
      <div class="brand">JARVIS</div>
      <button id="machine-button" type="button"><span id="machine-button-label"></span></button>
      <button id="nav-dashboard" type="button">Dashboard</button>
    </div>
    <div id="machine-stage" hidden></div>
    <div id="machine-menu" hidden></div>`;
}

function fakeApi(peers: TailnetPeers) {
  let push: ((state: MachineViewState) => void) | undefined;
  const api = {
    peers,
    tailnetPeers: vi.fn(async () => api.peers),
    showMachine: vi.fn(async () => {}),
    showLocalMachine: vi.fn(async () => {}),
    setMachineBounds: vi.fn(async () => {}),
    closeMachine: vi.fn(async () => {}),
    onMachineState: vi.fn((cb: (state: MachineViewState) => void) => {
      push = cb;
      return () => {
        push = undefined;
      };
    }),
    hideWorkspace: vi.fn(),
    restoreWorkspace: vi.fn(),
  };
  return { api, push: (state: MachineViewState) => push?.(state) };
}

const button = () => document.getElementById("machine-button") as HTMLButtonElement;
const menu = () => document.getElementById("machine-menu") as HTMLElement;
const stage = () => document.getElementById("machine-stage") as HTMLElement;
const items = () => [...menu().querySelectorAll<HTMLElement>("[role=menuitem]")];

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function openMenu(): Promise<void> {
  button().click();
  await flush();
}

describe("the topbar machine switcher", () => {
  beforeEach(() => {
    layout();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names this machine on the button, with an accessible name", async () => {
    const { api } = fakeApi({ state: "ok", machines: [] });
    await initMachineSwitcher(api);
    expect(button().textContent).toBe(MESSAGES.machineThisMachine(en));
    expect(button().getAttribute("aria-label")).toBe(
      MESSAGES.machineSwitcherLabel(MESSAGES.machineThisMachine(en), en),
    );
    expect(button().getAttribute("aria-haspopup")).toBe("menu");
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("is never one of the pieces the topbar hides when short of room", async () => {
    const { api } = fakeApi({ state: "ok", machines: [] });
    await initMachineSwitcher(api);
    for (const selector of TOPBAR_COLLAPSE_ORDER) {
      const hidden = [...document.querySelectorAll(selector)];
      expect(hidden.some((el) => el.contains(button()) || button().contains(el))).toBe(false);
    }
  });

  it("lists this machine first, then each found machine with its label and full name", async () => {
    const other = machine({ name: "attic.tail1234.ts.net", label: "Attic" });
    const { api } = fakeApi({ state: "ok", machines: [machine(), other] });
    await initMachineSwitcher(api);
    await openMenu();

    expect(menu().hidden).toBe(false);
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const rows = items();
    expect(rows[0]?.textContent).toBe(MESSAGES.machineThisMachine(en));
    expect(rows[1]?.textContent).toContain("Studio");
    expect(rows[1]?.textContent).toContain("studio.tail1234.ts.net");
    expect(rows[2]?.textContent).toContain("Attic");
    expect(rows[2]?.textContent).toContain("attic.tail1234.ts.net");
  });

  it.each([
    ["no-cli", MESSAGES.machineNoCli(en)],
    ["not-running", MESSAGES.machineNotRunning(en)],
    ["ok", MESSAGES.machineNoneFound(en)],
  ] as const)("says why nothing is listed when the state is %s", async (state, text) => {
    const { api } = fakeApi({ state, machines: [] });
    await initMachineSwitcher(api);
    await openMenu();
    expect(menu().textContent).toContain(text);
    expect(items()).toHaveLength(1);
  });

  it("asks once on open and every 30 s while open, and stops when closed", async () => {
    vi.useFakeTimers();
    const { api } = fakeApi({ state: "ok", machines: [] });
    await initMachineSwitcher(api);
    expect(api.tailnetPeers).not.toHaveBeenCalled();

    await openMenu();
    expect(api.tailnetPeers).toHaveBeenCalledTimes(1);
    expect(MACHINE_POLL_MS).toBe(30_000);

    await vi.advanceTimersByTimeAsync(MACHINE_POLL_MS - 1);
    expect(api.tailnetPeers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.tailnetPeers).toHaveBeenCalledTimes(2);

    // A machine found by a later round shows up without reopening.
    api.peers = { state: "ok", machines: [machine()] };
    await vi.advanceTimersByTimeAsync(MACHINE_POLL_MS);
    expect(items()[1]?.textContent).toContain("Studio");

    button().click(); // closes
    expect(menu().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(MACHINE_POLL_MS * 3);
    expect(api.tailnetPeers).toHaveBeenCalledTimes(3);
  });

  it("Escape closes the menu and puts focus back on the button", async () => {
    const { api } = fakeApi({ state: "ok", machines: [] });
    await initMachineSwitcher(api);
    await openMenu();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu().hidden).toBe(true);
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button());
  });

  it("a click outside closes the menu", async () => {
    const { api } = fakeApi({ state: "ok", machines: [] });
    await initMachineSwitcher(api);
    await openMenu();
    document.getElementById("nav-dashboard")?.click();
    expect(menu().hidden).toBe(true);
  });

  it("choosing a machine hides the workspace, sends the area below the top bar, then shows it", async () => {
    const { api } = fakeApi({ state: "ok", machines: [machine()] });
    await initMachineSwitcher(api);
    await openMenu();
    items()[1]?.click();
    await flush();

    expect(menu().hidden).toBe(true);
    expect(api.hideWorkspace).toHaveBeenCalledTimes(1);
    expect(api.setMachineBounds).toHaveBeenCalledWith({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    });
    expect(api.showMachine).toHaveBeenCalledWith({
      name: "studio.tail1234.ts.net",
      webPort: 7718,
      v: 1,
    });
    expect(api.hideWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      api.showMachine.mock.invocationCallOrder[0] ?? 0,
    );
    expect(button().textContent).toBe("Studio");
    expect(button().getAttribute("aria-label")).toBe(MESSAGES.machineSwitcherLabel("Studio", en));
    expect(stage().hidden).toBe(false);
    expect(stage().textContent).toContain(MESSAGES.machineLoading("Studio", en));
  });

  it("sends the bounds again when the window resizes, only while a machine is shown", async () => {
    const { api } = fakeApi({ state: "ok", machines: [machine()] });
    await initMachineSwitcher(api);
    window.dispatchEvent(new Event("resize"));
    expect(api.setMachineBounds).not.toHaveBeenCalled();

    await openMenu();
    items()[1]?.click();
    await flush();
    api.setMachineBounds.mockClear();
    window.dispatchEvent(new Event("resize"));
    expect(api.setMachineBounds).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["offline", MESSAGES.machineOffline(en)],
    ["certificate", MESSAGES.machineCertificate(en)],
    ["version", MESSAGES.machineVersion(en)],
  ] as const)("draws the %s state with a way back", async (phase, text) => {
    const { api, push } = fakeApi({ state: "ok", machines: [machine()] });
    await initMachineSwitcher(api);
    await openMenu();
    items()[1]?.click();
    await flush();

    push({ name: "studio.tail1234.ts.net", phase });
    expect(stage().textContent).toContain(text);
    const back = [...stage().querySelectorAll("button")].find(
      (b) => b.textContent === MESSAGES.machineBack(en),
    );
    expect(back).toBeDefined();

    back?.click();
    await flush();
    expect(api.showLocalMachine).toHaveBeenCalledTimes(1);
    expect(api.restoreWorkspace).toHaveBeenCalledTimes(1);
    expect(stage().hidden).toBe(true);
    expect(button().textContent).toBe(MESSAGES.machineThisMachine(en));
  });

  it("clears the overlay once the machine is ready, and ignores another machine's state", async () => {
    const { api, push } = fakeApi({ state: "ok", machines: [machine()] });
    await initMachineSwitcher(api);
    await openMenu();
    items()[1]?.click();
    await flush();

    // Names arrive lowercased from main.
    push({ name: "studio.tail1234.ts.net", phase: "ready" });
    expect(stage().hidden).toBe(false);
    expect(stage().textContent).toBe("");

    push({ name: "attic.tail1234.ts.net", phase: "offline" });
    expect(stage().textContent).toBe("");
  });

  it("matches a state to the shown machine case-insensitively", async () => {
    const { api, push } = fakeApi({
      state: "ok",
      machines: [machine({ name: "Studio.tail1234.ts.net" })],
    });
    await initMachineSwitcher(api);
    await openMenu();
    items()[1]?.click();
    await flush();
    push({ name: "studio.tail1234.ts.net", phase: "offline" });
    expect(stage().textContent).toContain(MESSAGES.machineOffline(en));
  });

  it("choosing This machine goes back and restores the workspace pages", async () => {
    const { api } = fakeApi({ state: "ok", machines: [machine()] });
    await initMachineSwitcher(api);
    await openMenu();
    items()[1]?.click();
    await flush();

    await openMenu();
    api.showLocalMachine.mockClear();
    items()[0]?.click();
    await flush();
    expect(api.showLocalMachine).toHaveBeenCalledTimes(1);
    expect(api.restoreWorkspace).toHaveBeenCalledTimes(1);
    expect(api.showLocalMachine.mock.invocationCallOrder[0]).toBeLessThan(
      api.restoreWorkspace.mock.invocationCallOrder[0] ?? 0,
    );
    expect(stage().hidden).toBe(true);
    expect(button().textContent).toBe(MESSAGES.machineThisMachine(en));
  });

  it("offers a close control only for machines that have been opened", async () => {
    const other = machine({ name: "attic.tail1234.ts.net", label: "Attic" });
    const { api } = fakeApi({ state: "ok", machines: [machine(), other] });
    await initMachineSwitcher(api);
    await openMenu();
    const closeLabel = (label: string) =>
      menu().querySelector(`[aria-label="${MESSAGES.machineClose(label, en)}"]`);
    expect(closeLabel("Studio")).toBeNull();
    expect(closeLabel("Attic")).toBeNull();

    items()[1]?.click();
    await flush();
    await openMenu();
    expect(closeLabel("Studio")).not.toBeNull();
    expect(closeLabel("Attic")).toBeNull();
  });

  it("closing a background machine keeps the shown one; closing the shown one goes back", async () => {
    const other = machine({ name: "attic.tail1234.ts.net", label: "Attic" });
    const { api } = fakeApi({ state: "ok", machines: [machine(), other] });
    await initMachineSwitcher(api);
    await openMenu();
    items()[1]?.click(); // Studio
    await flush();
    await openMenu();
    items()[2]?.click(); // Attic, Studio stays open behind it
    await flush();

    await openMenu();
    (
      menu().querySelector(`[aria-label="${MESSAGES.machineClose("Studio", en)}"]`) as HTMLElement
    ).click();
    await flush();
    expect(api.closeMachine).toHaveBeenCalledWith("studio.tail1234.ts.net");
    expect(api.restoreWorkspace).not.toHaveBeenCalled();
    expect(button().textContent).toBe("Attic");
    expect(
      menu().querySelector(`[aria-label="${MESSAGES.machineClose("Studio", en)}"]`),
    ).toBeNull();

    (
      menu().querySelector(`[aria-label="${MESSAGES.machineClose("Attic", en)}"]`) as HTMLElement
    ).click();
    await flush();
    expect(api.closeMachine).toHaveBeenCalledWith("attic.tail1234.ts.net");
    expect(api.restoreWorkspace).toHaveBeenCalledTimes(1);
    expect(button().textContent).toBe(MESSAGES.machineThisMachine(en));
  });

  it("hides the shown machine's view while the menu is open, and puts it back on a close with no choice", async () => {
    const { api } = fakeApi({ state: "ok", machines: [machine()] });
    await initMachineSwitcher(api);
    await openMenu();
    expect(api.showLocalMachine).not.toHaveBeenCalled(); // nothing to hide yet
    items()[1]?.click();
    await flush();
    expect(api.showMachine).toHaveBeenCalledTimes(1);

    await openMenu();
    expect(api.showLocalMachine).toHaveBeenCalledTimes(1);
    expect(api.restoreWorkspace).not.toHaveBeenCalled();
    const bounds = api.setMachineBounds.mock.calls.length;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(api.showMachine).toHaveBeenCalledTimes(2);
    expect(api.showMachine).toHaveBeenLastCalledWith({
      name: "studio.tail1234.ts.net",
      webPort: 7718,
      v: 1,
    });
    // Hidden, never resized: a resize would resize that machine's terminals.
    expect(api.setMachineBounds.mock.calls.length).toBe(bounds);
    expect(button().textContent).toBe("Studio");
  });

  it("absent markup is a no-op", async () => {
    document.body.replaceChildren();
    const { api } = fakeApi({ state: "ok", machines: [] });
    await expect(initMachineSwitcher(api)).resolves.toBeUndefined();
    expect(api.onMachineState).not.toHaveBeenCalled();
  });
});
