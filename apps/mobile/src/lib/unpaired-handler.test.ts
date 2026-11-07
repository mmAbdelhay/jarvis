import { describe, expect, it, vi } from "vitest";
import type { ForgetOutcome } from "./machine-sessions";
import { createUnpairedHandler } from "./unpaired-handler";

const NONE: ForgetOutcome = { kind: "none" };
const NEXT: ForgetOutcome = { kind: "next", id: "b_1" };
const CLEAR_FAILED: ForgetOutcome = { kind: "clearFailed" };

describe("createUnpairedHandler", () => {
  it.each([NONE, NEXT])(
    "forgets, hands on the outcome $kind, and answers 'cleared'",
    async (outcome) => {
      const forget = vi.fn(async () => outcome);
      const afterForget = vi.fn();
      const log = vi.fn();
      const handler = createUnpairedHandler({ forget, afterForget, log });

      await expect(handler()).resolves.toBe("cleared");

      expect(forget).toHaveBeenCalledTimes(1);
      expect(afterForget).toHaveBeenCalledExactlyOnceWith(outcome);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("a failed clear hands on clearFailed and answers it, so the episode is not marked handled", async () => {
    const afterForget = vi.fn();
    const handler = createUnpairedHandler({
      forget: async () => CLEAR_FAILED,
      afterForget,
      log: vi.fn(),
    });

    await expect(handler()).resolves.toBe("clearFailed");

    expect(afterForget).toHaveBeenCalledExactlyOnceWith(CLEAR_FAILED);
  });

  it("I2 bite-proof: a forget that rejects all the same still routes, logs a secret-free line and never throws", async () => {
    const afterForget = vi.fn();
    const log = vi.fn();
    const handler = createUnpairedHandler({
      forget: async () => {
        throw new Error("keychain unavailable");
      },
      afterForget,
      log,
    });

    await expect(handler()).resolves.toBe("clearFailed");

    expect(afterForget).toHaveBeenCalledExactlyOnceWith(CLEAR_FAILED);
    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] as [string];
    expect(line).not.toMatch(/token|secret/i);
  });
});
