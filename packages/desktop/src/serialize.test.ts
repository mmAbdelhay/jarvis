import { describe, expect, it } from "vitest";
import { serialize } from "./serialize.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("serialize", () => {
  it("runs two overlapping calls one after the other, in call order", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const wrapped = serialize(async (label: string) => {
      order.push(`${label}:start`);
      if (label === "a") await first.promise;
      order.push(`${label}:end`);
      return label;
    });

    const a = wrapped("a");
    const b = wrapped("b");

    // "b" must not have started yet: "a" has not finished.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);

    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("still runs a later call after an earlier one rejects", async () => {
    const wrapped = serialize(async (fail: boolean) => {
      if (fail) throw new Error("boom");
      return "ok";
    });

    await expect(wrapped(true)).rejects.toThrow("boom");
    await expect(wrapped(false)).resolves.toBe("ok");
  });

  it("each caller gets its own call's result, not another caller's", async () => {
    const wrapped = serialize(async (n: number) => n * 2);
    const [a, b, c] = await Promise.all([wrapped(1), wrapped(2), wrapped(3)]);
    expect([a, b, c]).toEqual([2, 4, 6]);
  });

  // I2: the exact shape main.ts's `applyFromDisk` uses — each queued turn
  // reads fresh *when it runs*, not when it was enqueued — so a slow first
  // read never lets a later-enqueued call's stale-by-then data win. Two
  // fast desktop saves (On, then Off) must not apply out of order and
  // leave the bridge listening.
  it("reads fresh inside each queued turn, so the last-enqueued call always applies the latest read, even if the first read is slow", async () => {
    const applied: string[] = [];
    // Simulates the config file: "on" when the test starts, flipped to
    // "off" by a second save that lands while the first read is still
    // in flight.
    let onDisk = "on";
    const firstReadStarted = deferred<void>();
    const firstReadMayFinish = deferred<void>();
    let reads = 0;

    const applyFromDisk = serialize(async () => {
      reads += 1;
      // The "disk read" itself happens at the start of the turn — a real
      // loadConfig() call reads whatever is on disk right now, then the
      // rest of the turn (validation, applying to the bridge) may still
      // take a while. The first turn's read is held open here to simulate
      // that slowness continuing *after* the read already happened.
      const value = onDisk;
      if (reads === 1) {
        firstReadStarted.resolve();
        await firstReadMayFinish.promise;
      }
      applied.push(value);
    });

    const first = applyFromDisk(); // enqueued first, from the "on" save
    await firstReadStarted.promise; // now mid-read

    onDisk = "off"; // the second save has already written the file...
    const second = applyFromDisk(); // ...and enqueues its own apply

    firstReadMayFinish.resolve(); // let the first read proceed
    await Promise.all([first, second]);

    // The first turn's read started before the flip and (being held open)
    // still observes "on" — that is expected, and harmless: the *second*,
    // later-enqueued turn runs after it and reads the true, current value.
    expect(applied).toEqual(["on", "off"]);
  });
});
