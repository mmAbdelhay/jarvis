import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock-double.js";

describe("fakeClock", () => {
  it("fires due timers in time order, each seeing its own scheduled time", () => {
    const clock = fakeClock(100);
    const fired: [string, number][] = [];
    clock.timers.setTimeout(() => fired.push(["b", clock.now()]), 20); // due at 120
    clock.timers.setTimeout(() => fired.push(["a", clock.now()]), 10); // due at 110

    clock.advance(20);

    expect(fired).toEqual([
      ["a", 110],
      ["b", 120],
    ]);
    expect(clock.now()).toBe(120);
  });

  it("breaks a tie between equally-due timers by scheduling order", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    clock.timers.setTimeout(() => fired.push("first"), 10);
    clock.timers.setTimeout(() => fired.push("second"), 10);

    clock.advance(10);

    expect(fired).toEqual(["first", "second"]);
  });

  it("skips a cleared timer", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    const handle = clock.timers.setTimeout(() => fired.push("cleared"), 10);
    clock.timers.setTimeout(() => fired.push("kept"), 10);
    clock.timers.clearTimeout(handle);

    clock.advance(10);

    expect(fired).toEqual(["kept"]);
  });

  it("does not fire a timer scheduled past the advance", () => {
    const clock = fakeClock();
    const fired: string[] = [];
    clock.timers.setTimeout(() => fired.push("late"), 20);

    clock.advance(10);

    expect(fired).toEqual([]);
    expect(clock.pending()).toBe(1);
    expect(clock.now()).toBe(10);
  });
});
