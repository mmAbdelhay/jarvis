// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AwakeStatus } from "../src/keep-awake.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import {
  awakeToggleTarget,
  initKeepAwake,
  latestAwakeStatus,
  onAwakeStatusChange,
} from "./keep-awake.js";

function status(patch: Partial<AwakeStatus> = {}): AwakeStatus {
  return {
    mode: "off",
    active: false,
    reason: "off",
    simulateInput: false,
    inputState: "idle",
    ...patch,
  };
}

describe("awakeToggleTarget", () => {
  it("turns any on mode off", () => {
    expect(awakeToggleTarget("on", "on")).toBe("off");
    expect(awakeToggleTarget("agents", "agents")).toBe("off");
  });
  it("turns off back to the last non-off mode, on by default", () => {
    expect(awakeToggleTarget("off", undefined)).toBe("on");
    expect(awakeToggleTarget("off", "agents")).toBe("agents");
  });
});

describe("the topbar keep-awake button", () => {
  let pushed: ((status: AwakeStatus) => void) | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    const button = document.createElement("button");
    button.id = "awake-button";
    document.body.append(button);
    pushed = undefined;
  });

  function api(initial: AwakeStatus) {
    return {
      awakeStatus: vi.fn(async () => initial),
      setAwake: vi.fn(async (patch: { mode?: AwakeStatus["mode"] }) =>
        status({ mode: patch.mode ?? "off", active: patch.mode === "on", reason: "on" }),
      ),
      onAwakeChanged: vi.fn((cb: (s: AwakeStatus) => void) => {
        pushed = cb;
      }),
    };
  }

  it("shows the status it reads, and the pushed one after", async () => {
    const fake = api(status({ mode: "on", active: true, reason: "on" }));
    await initKeepAwake(fake);
    const button = document.getElementById("awake-button") as HTMLButtonElement;
    expect(button.classList.contains("icon-btn--on")).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe(
      MESSAGES.awakeButtonLabel(
        status({ mode: "on", active: true, reason: "on" }),
        PRIMARY_LANGUAGE,
      ),
    );
    expect(latestAwakeStatus()?.mode).toBe("on");

    button.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.querySelector(".hover-tip")?.textContent).toBe(
      button.getAttribute("aria-label"),
    );
    button.dispatchEvent(new MouseEvent("mouseleave"));
    expect(document.querySelector(".hover-tip")).toBeNull();

    const seen: AwakeStatus[] = [];
    const stop = onAwakeStatusChange((s) => seen.push(s));
    pushed?.(status());
    stop();
    expect(button.classList.contains("icon-btn--on")).toBe(false);
    expect(seen.map((s) => s.mode)).toEqual(["off"]);
  });

  it("a click turns it off, and the next turns the last mode back on", async () => {
    const fake = api(status({ mode: "agents", reason: "no-agent" }));
    await initKeepAwake(fake);
    const button = document.getElementById("awake-button") as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(fake.setAwake).toHaveBeenCalledWith({ mode: "off" }));
    pushed?.(status());
    button.click();
    await vi.waitFor(() => expect(fake.setAwake).toHaveBeenLastCalledWith({ mode: "agents" }));
  });

  it("does nothing without its button", async () => {
    document.body.replaceChildren();
    const fake = api(status());
    await initKeepAwake(fake);
    expect(fake.awakeStatus).not.toHaveBeenCalled();
  });
});
