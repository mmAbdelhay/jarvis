import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createChildTracker } from "./child-tracker.js";

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    killed: 0,
    kill() {
      child.killed++;
      return true;
    },
  });
  return child;
}

describe("child tracker", () => {
  it("kills every live child on stopAll and resolves once all have closed", async () => {
    const tracker = createChildTracker();
    const a = fakeChild();
    const b = fakeChild();
    const done = fakeChild();
    tracker.track(a);
    tracker.track(b);
    tracker.track(done);
    done.emit("close", 0);

    let settled = false;
    const stopped = tracker.stopAll().then(() => {
      settled = true;
    });
    expect(a.killed).toBe(1);
    expect(b.killed).toBe(1);
    expect(done.killed).toBe(0);
    a.emit("close", null);
    await Promise.resolve();
    expect(settled).toBe(false);
    b.emit("error", new Error("gone"));
    await stopped;
    expect(settled).toBe(true);
  });

  it("refuses and kills a child started after stopAll", async () => {
    const tracker = createChildTracker();
    await tracker.stopAll();
    const late = fakeChild();
    expect(tracker.track(late)).toBe(false);
    expect(late.killed).toBe(1);
  });
});
