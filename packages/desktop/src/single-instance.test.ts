import { describe, expect, it } from "vitest";
import { claimSingleInstance } from "./single-instance.js";

// Review I1: two app instances on one config are two cores (in-process) or
// two attached apps. The second instance hands over to the first and quits.

function fakeApp(granted: boolean) {
  const events: string[] = [];
  const listeners: Array<() => void> = [];
  return {
    events,
    launchSecond: () => {
      for (const listener of listeners) listener();
    },
    app: {
      requestSingleInstanceLock: () => {
        events.push("lock");
        return granted;
      },
      on: (event: "second-instance", listener: () => void) => {
        events.push(`on ${event}`);
        listeners.push(listener);
      },
      quit: () => void events.push("quit"),
    },
  };
}

describe("claimSingleInstance", () => {
  it("the first instance keeps the lock and focuses its window when a second one starts", () => {
    const fake = fakeApp(true);
    let focused = 0;
    expect(claimSingleInstance(fake.app, () => void focused++)).toBe(true);
    expect(fake.events).toEqual(["lock", "on second-instance"]);
    fake.launchSecond();
    expect(focused).toBe(1);
  });

  it("a second instance quits at once and listens for nothing", () => {
    const fake = fakeApp(false);
    expect(claimSingleInstance(fake.app, () => {})).toBe(false);
    expect(fake.events).toEqual(["lock", "quit"]);
  });
});
