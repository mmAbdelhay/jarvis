// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { plainTerminalState, type PopoutTerminalState } from "../src/popout-state.js";
import { focusPopped, initMainPopouts, viewingKeys } from "./popout-main.js";
import { isPopped, setPoppedTabs } from "./popped.js";

const SPLIT: PopoutTerminalState = {
  shape: { direction: "row", first: { key: "t1" }, second: { key: "t1:p1" } },
  drafts: { "t1:p1": "ls" },
};

function api(overrides: Record<string, unknown> = {}) {
  let handover: (tabId: string) => void = () => {};
  let changed: (ids: string[]) => void = () => {};
  const fake = {
    popoutList: vi.fn(async () => [] as string[]),
    onPopoutChanged: vi.fn((cb: (ids: string[]) => void) => {
      changed = cb;
      return () => {};
    }),
    onPopoutHandover: vi.fn((cb: (tabId: string) => void) => {
      handover = cb;
      return () => {};
    }),
    popoutHandedOver: vi.fn(async () => undefined),
    popoutTakeReturned: vi.fn(async (): Promise<PopoutTerminalState | undefined> => undefined),
    ...overrides,
  };
  return { fake, handover: (id: string) => handover(id), changed: (ids: string[]) => changed(ids) };
}

describe("the main window's side of a pop-out", () => {
  it("answers the host's request for a tab's layout and drafts with what its panes hold", async () => {
    const a = api();
    const carry = vi.fn(() => SPLIT);
    await initMainPopouts(a.fake as never, { carry, stage: vi.fn() });
    a.handover("t1");
    expect(carry).toHaveBeenCalledWith("t1");
    expect(a.fake.popoutHandedOver).toHaveBeenCalledWith("t1", SPLIT);
  });

  it("takes what a returned tab carried and stages it before the tab counts as back", async () => {
    const a = api({
      popoutList: vi.fn(async () => ["t1"]),
      popoutTakeReturned: vi.fn(async () => SPLIT),
    });
    const stage = vi.fn();
    await initMainPopouts(a.fake as never, { carry: () => plainTerminalState("t1"), stage });
    expect(isPopped("t1")).toBe(true);
    a.changed([]);
    expect(isPopped("t1")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stage).toHaveBeenCalledWith("t1", SPLIT);
    expect(isPopped("t1")).toBe(false);
  });

  it("stages nothing when the host returns no state, and survives a host without the channels", async () => {
    const a = api({ popoutList: vi.fn(async () => ["t2"]) });
    const stage = vi.fn();
    await initMainPopouts(a.fake as never, { carry: () => plainTerminalState("t2"), stage });
    a.changed([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stage).not.toHaveBeenCalled();
    await expect(
      initMainPopouts({} as never, { carry: () => plainTerminalState("t"), stage }),
    ).resolves.toBeUndefined();
    setPoppedTabs([]);
  });
});

describe("an Office employee of a tab shown in another window", () => {
  it("brings that window forward, on the pane that asked, instead of opening a placeholder here", () => {
    const popoutFocus = vi.fn(async () => true);
    const popped = (id: string) => id === "t1";
    expect(focusPopped({ popoutFocus }, { type: "tab", tabId: "t1" }, popped)).toBe(true);
    expect(popoutFocus).toHaveBeenLastCalledWith("t1", undefined);
    expect(
      focusPopped({ popoutFocus }, { type: "pane", tabId: "t1", paneKey: "t1:p2" }, popped),
    ).toBe(true);
    expect(popoutFocus).toHaveBeenLastCalledWith("t1", "t1:p2");
    expect(focusPopped({ popoutFocus }, { type: "tab", tabId: "t2" }, popped)).toBe(false);
    expect(focusPopped({ popoutFocus }, { type: "session", sessionId: "s1" }, popped)).toBe(false);
    expect(popoutFocus).toHaveBeenCalledTimes(2);
  });

  it("survives a host without the channel", () => {
    expect(focusPopped({} as never, { type: "tab", tabId: "t1" }, () => true)).toBe(true);
  });
});

describe("what this window says it is viewing", () => {
  const popped = (id: string) => id === "t1";
  it("is the active tab on the Workspace, unless that tab is shown in another window", () => {
    expect(viewingKeys({ view: "workspace", activeTabId: "t2", popped })).toEqual(["t2"]);
    expect(viewingKeys({ view: "workspace", activeTabId: "t1", popped })).toEqual([]);
    expect(viewingKeys({ view: "workspace", activeTabId: undefined, popped })).toEqual([]);
  });

  it("is the open session on the Session view, and nothing elsewhere", () => {
    expect(viewingKeys({ view: "session", sessionId: "s1", popped })).toEqual(["s1"]);
    expect(viewingKeys({ view: "session", sessionId: undefined, popped })).toEqual([]);
    expect(viewingKeys({ view: "office", activeTabId: "t2", popped })).toEqual([]);
  });
});
