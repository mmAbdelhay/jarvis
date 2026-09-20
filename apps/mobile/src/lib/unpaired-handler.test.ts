import { describe, expect, it, vi } from "vitest";
import { takeClearFailedSignal } from "./clear-failed-signal";
import { isClearingPairing } from "./pairing-guard";
import { createUnpairedHandler } from "./unpaired-handler";

describe("createUnpairedHandler", () => {
  it("clears the pairing, navigates to /pair as 'cleared', and resolves 'cleared'", async () => {
    const clearPairing = vi.fn(async () => {});
    const navigateToPair = vi.fn();
    const log = vi.fn();
    const handler = createUnpairedHandler({ clearPairing, navigateToPair, log });

    await expect(handler()).resolves.toBe("cleared");

    expect(clearPairing).toHaveBeenCalledTimes(1);
    expect(navigateToPair).toHaveBeenCalledExactlyOnceWith("cleared");
    expect(log).not.toHaveBeenCalled();
  });

  it("I2 bite-proof: still navigates to /pair when clearPairing rejects", async () => {
    // Remove the try/catch around clearPairing (or the unconditional
    // navigateToPair call after it) and this assertion fails: the user
    // would be stuck on the Dashboard with no path back to /pair.
    const clearPairing = vi.fn(async () => {
      throw new Error("keychain unavailable");
    });
    const navigateToPair = vi.fn();
    const log = vi.fn();
    const handler = createUnpairedHandler({ clearPairing, navigateToPair, log });

    await handler();

    expect(navigateToPair).toHaveBeenCalledTimes(1);
  });

  it(
    "fix round 2 (I2 ruling): navigates to /pair as 'clearFailed', not 'cleared', when clearing fails " +
      '[bite-proof: pass "cleared" unconditionally to navigateToPair and this fails]',
    async () => {
      const clearPairing = vi.fn(async () => {
        throw new Error("keychain unavailable");
      });
      const navigateToPair = vi.fn();
      const log = vi.fn();
      const handler = createUnpairedHandler({ clearPairing, navigateToPair, log });

      await expect(handler()).resolves.toBe("clearFailed");

      expect(navigateToPair).toHaveBeenCalledExactlyOnceWith("clearFailed");
    },
  );

  it("logs a secret-free line when clearPairing fails, and never throws out of the handler", async () => {
    const clearPairing = vi.fn(async () => {
      throw new Error("keychain unavailable");
    });
    const navigateToPair = vi.fn();
    const log = vi.fn();
    const handler = createUnpairedHandler({ clearPairing, navigateToPair, log });

    await expect(handler()).resolves.toBe("clearFailed");

    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] as [string];
    expect(line).not.toMatch(/token|secret/i);
  });

  it(
    "sets the one-shot clearFailed signal (never a param) when clearing fails, " +
      "and leaves it unset when clearing succeeds",
    async () => {
      takeClearFailedSignal(); // drain any leftover from another test in this file
      const failingHandler = createUnpairedHandler({
        clearPairing: vi.fn(async () => {
          throw new Error("keychain unavailable");
        }),
        navigateToPair: vi.fn(),
        log: vi.fn(),
      });
      await failingHandler();
      expect(takeClearFailedSignal()).toBe(true);
      // One-shot: reading it again sees nothing.
      expect(takeClearFailedSignal()).toBe(false);

      const succeedingHandler = createUnpairedHandler({
        clearPairing: vi.fn(async () => {}),
        navigateToPair: vi.fn(),
        log: vi.fn(),
      });
      await succeedingHandler();
      expect(takeClearFailedSignal()).toBe(false);
    },
  );

  it(
    "T7 r2 Minor 2 bite-proof: the app-wide clearing guard is set for the " +
      "duration of the clear, on both outcomes " +
      "[bite-proof: drop the setClearingPairing calls and the awaits below see false throughout]",
    async () => {
      let sawGuardDuringClear = false;
      const handler = createUnpairedHandler({
        clearPairing: async () => {
          sawGuardDuringClear = isClearingPairing();
        },
        navigateToPair: vi.fn(),
        log: vi.fn(),
      });

      expect(isClearingPairing()).toBe(false);
      await handler();
      expect(sawGuardDuringClear).toBe(true);
      expect(isClearingPairing()).toBe(false);
    },
  );

  it("resets the app-wide clearing guard even when clearPairing throws", async () => {
    const handler = createUnpairedHandler({
      clearPairing: vi.fn(async () => {
        throw new Error("keychain unavailable");
      }),
      navigateToPair: vi.fn(),
      log: vi.fn(),
    });

    await handler();
    expect(isClearingPairing()).toBe(false);
  });
});
