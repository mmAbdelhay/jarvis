import { describe, expect, it } from "vitest";
import { createSidecarReaper } from "./sidecar-reaper.js";

function harness(idleMs: number, start: string[] = ["a", "b"]) {
  let now = 0;
  let running = [...start];
  const stopped: string[] = [];
  const reaper = createSidecarReaper({
    runningKeys: () => [...running],
    stop: (key) => {
      stopped.push(key);
      running = running.filter((candidate) => candidate !== key);
    },
    now: () => now,
    idleMs,
  });
  return {
    reaper,
    stopped,
    at(ms: number) {
      now = ms;
    },
    running: () => running,
    die(key: string) {
      running = running.filter((candidate) => candidate !== key);
    },
    revive(key: string) {
      running = [...running, key];
    },
  };
}

describe("createSidecarReaper", () => {
  it("stops a key that has gone unneeded for the whole grace period", () => {
    const h = harness(1000);

    h.reaper.sweep(new Set(["a"])); // b becomes unneeded at t=0
    h.at(500);
    h.reaper.sweep(new Set(["a"]));
    expect(h.stopped).toEqual([]);

    h.at(1000);
    h.reaper.sweep(new Set(["a"]));
    expect(h.stopped).toEqual(["b"]);
    expect(h.running()).toEqual(["a"]);
  });

  // Closing an editor tab and reopening it ten seconds later is ordinary.
  it("restarts the clock when a key is needed again", () => {
    const h = harness(1000);

    h.reaper.sweep(new Set(["a"]));
    h.at(900);
    h.reaper.sweep(new Set(["a", "b"])); // b came back
    h.at(1500);
    h.reaper.sweep(new Set(["a"])); // unneeded again, from t=1500
    h.at(2000);
    h.reaper.sweep(new Set(["a"]));
    expect(h.stopped).toEqual([]);

    h.at(2500);
    h.reaper.sweep(new Set(["a"]));
    expect(h.stopped).toEqual(["b"]);
  });

  it("stops every key that has run out, in one sweep", () => {
    const h = harness(1000);

    h.reaper.sweep(new Set([]));
    h.at(1000);
    h.reaper.sweep(new Set([]));
    expect(h.stopped.sort()).toEqual(["a", "b"]);
    expect(h.running()).toEqual([]);
  });

  // The failure this prevents: an instance that crashed, then started again
  // under the same key, inheriting a grace period that had already expired
  // and being killed the moment it came up.
  it("forgets a key that died on its own, so a restart gets a full grace period", () => {
    const h = harness(1000);

    h.reaper.sweep(new Set(["a"])); // b unneeded from t=0
    h.at(500);
    h.die("b"); // b crashes
    h.reaper.sweep(new Set(["a"])); // the reaper notices it is gone
    h.revive("b"); // and something starts it again

    h.at(1200); // past t=0 + 1000, but not past its new clock
    h.reaper.sweep(new Set(["a"]));
    expect(h.stopped).toEqual([]);

    h.at(2200);
    h.reaper.sweep(new Set(["a"]));
    expect(h.stopped).toEqual(["b"]);
  });

  it("stops nothing when idleMs is 0", () => {
    const h = harness(0);

    h.reaper.sweep(new Set([]));
    h.at(10_000_000);
    h.reaper.sweep(new Set([]));
    expect(h.stopped).toEqual([]);
    expect(h.running()).toEqual(["a", "b"]);
  });

  it("never stops a key that is always needed", () => {
    const h = harness(1000);

    for (let t = 0; t <= 10_000; t += 500) {
      h.at(t);
      h.reaper.sweep(new Set(["a", "b"]));
    }
    expect(h.stopped).toEqual([]);
  });
});
