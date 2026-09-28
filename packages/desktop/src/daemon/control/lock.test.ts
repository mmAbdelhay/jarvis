import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ControlClock, type ControlDeps, nodeControlDeps } from "./deps.js";
import { acquirePidLock, STALE_LOCK_GRACE_MS } from "./lock.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function pidPathFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jc-lock-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "jarvisd.pid");
}

/** Real timers, except the stale-lock grace, which fires at once and is recorded. */
function graceClock(): ControlClock & { graces: number[] } {
  const real = nodeControlDeps().clock;
  const graces: number[] = [];
  return {
    graces,
    now: real.now,
    setTimeout(callback, ms) {
      if (ms !== STALE_LOCK_GRACE_MS) return real.setTimeout(callback, ms);
      graces.push(ms);
      return setImmediate(callback);
    },
    clearTimeout: real.clearTimeout,
  };
}

function starter(
  pid: number,
  alive: ReadonlySet<number>,
  clock: ControlClock = graceClock(),
): Pick<ControlDeps, "fs" | "process" | "randomBytes" | "clock"> {
  const real = nodeControlDeps();
  return {
    fs: real.fs,
    randomBytes: real.randomBytes,
    clock,
    process: { pid, uid: () => undefined, isAlive: (p) => alive.has(p) },
  };
}

const silent = { holderAnswers: async () => false };

describe("the pid lock", () => {
  it("lets exactly one of three racing starters take over a stale lock", async () => {
    for (let round = 0; round < 30; round++) {
      const pidPath = await pidPathFixture();
      await writeFile(pidPath, "999999:dead");
      const alive = new Set([101, 102, 103]);
      const results = await Promise.all(
        [101, 102, 103].map((pid) => acquirePidLock(pidPath, starter(pid, alive), silent)),
      );
      expect(results.filter((r) => r.kind === "acquired")).toHaveLength(1);
      for (const result of results) if (result.kind === "acquired") await result.release();
    }
  });

  it("takes over a live but unrelated pid whose endpoint stays silent past the grace", async () => {
    const pidPath = await pidPathFixture();
    await writeFile(pidPath, "4242");
    const clock = graceClock();
    let probes = 0;
    const lock = await acquirePidLock(pidPath, starter(7, new Set([4242, 7]), clock), {
      holderAnswers: async () => {
        probes++;
        return false;
      },
    });
    expect(lock.kind).toBe("acquired");
    expect(probes).toBe(2);
    expect(clock.graces).toEqual([STALE_LOCK_GRACE_MS]);
    expect(STALE_LOCK_GRACE_MS).toBe(10_000);
    expect(await readFile(pidPath, "utf8")).toMatch(/^7:[0-9a-f]+$/);
  });

  it("stays busy while a live holder's endpoint answers", async () => {
    const pidPath = await pidPathFixture();
    await writeFile(pidPath, "4242");
    const lock = await acquirePidLock(pidPath, starter(7, new Set([4242, 7])), {
      holderAnswers: async () => true,
    });
    expect(lock).toEqual({ kind: "busy" });
    expect(await readFile(pidPath, "utf8")).toBe("4242");
  });

  it("stays busy for a holder that starts answering within the grace", async () => {
    const pidPath = await pidPathFixture();
    await writeFile(pidPath, "4242");
    const answers = [false, true];
    const lock = await acquirePidLock(pidPath, starter(7, new Set([4242, 7])), {
      holderAnswers: async () => answers.shift() ?? true,
    });
    expect(lock).toEqual({ kind: "busy" });
  });

  it("treats its own pid in the file as stale, without probing", async () => {
    const pidPath = await pidPathFixture();
    await writeFile(pidPath, "7:left-by-an-earlier-boot");
    let probed = false;
    const lock = await acquirePidLock(pidPath, starter(7, new Set([7])), {
      holderAnswers: async () => {
        probed = true;
        return true;
      },
    });
    expect(lock.kind).toBe("acquired");
    expect(probed).toBe(false);
  });

  it("treats a dead pid as stale", async () => {
    const pidPath = await pidPathFixture();
    await writeFile(pidPath, "4242");
    const lock = await acquirePidLock(pidPath, starter(7, new Set([7])), silent);
    expect(lock.kind).toBe("acquired");
  });

  it("clears a takeover marker left by a starter that crashed mid-takeover", async () => {
    const pidPath = await pidPathFixture();
    await writeFile(pidPath, "4242");
    await writeFile(`${pidPath}.takeover`, "5:crashed");
    const old = new Date(Date.now() - 60_000);
    await utimes(`${pidPath}.takeover`, old, old);
    const lock = await acquirePidLock(pidPath, starter(7, new Set([7])), silent);
    expect(lock.kind).toBe("acquired");
  });

  it("stays busy while a fresh takeover marker says another starter is mid-takeover", async () => {
    const pidPath = await pidPathFixture();
    await writeFile(pidPath, "4242");
    await writeFile(`${pidPath}.takeover`, "5:busy");
    const lock = await acquirePidLock(pidPath, starter(7, new Set([7])), silent);
    expect(lock).toEqual({ kind: "busy" });
  });

  it("releases only a lock that is still its own", async () => {
    const pidPath = await pidPathFixture();
    const lock = await acquirePidLock(pidPath, starter(7, new Set([7])), silent);
    if (lock.kind !== "acquired") throw new Error("expected the lock");
    await writeFile(pidPath, "8:someone-else");
    await lock.release();
    expect(await readFile(pidPath, "utf8")).toBe("8:someone-else");
  });
});
