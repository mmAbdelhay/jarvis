import { beforeEach, describe, expect, it } from "vitest";
import { stashPairingLink, subscribePairingLink, takePairingLink } from "./pairing-link-holder";

const LINK = "jarvis://pair?v=1&host=192.168.1.5&port=4317&secret=s&fp=f";

// Drain any leftover value between tests: the holder is module-scope state
// (deliberately — see the module's own comment), so tests share it within
// this file unless each one starts from empty.
beforeEach(() => {
  takePairingLink();
});

describe("pairing-link-holder", () => {
  it("defaults to nothing held", () => {
    expect(takePairingLink()).toBeNull();
  });

  it("returns exactly what was stashed, byte-identical (the secret survives)", () => {
    stashPairingLink(LINK);
    expect(takePairingLink()).toBe(LINK);
  });

  it(
    "is consumed exactly once — a second take after the first sees nothing " +
      "[bite-proof: don't clear `held` in takePairingLink and this fails]",
    () => {
      stashPairingLink(LINK);
      expect(takePairingLink()).toBe(LINK);
      expect(takePairingLink()).toBeNull();
    },
  );

  it("a fresh stash after a take is held again (a genuinely new link is not lost)", () => {
    stashPairingLink(LINK);
    takePairingLink();
    expect(takePairingLink()).toBeNull();

    const secondLink = "jarvis://pair?v=1&host=10.0.0.1&port=1&secret=t&fp=g";
    stashPairingLink(secondLink);
    expect(takePairingLink()).toBe(secondLink);
  });

  it("a later stash overwrites an unread one", () => {
    stashPairingLink(LINK);
    const secondLink = "jarvis://pair?v=1&host=10.0.0.1&port=1&secret=t&fp=g";
    stashPairingLink(secondLink);
    expect(takePairingLink()).toBe(secondLink);
    expect(takePairingLink()).toBeNull();
  });

  it("notifies subscribers on stash, not on take", () => {
    const seen: number[] = [];
    const unsubscribe = subscribePairingLink(() => {
      seen.push(1);
    });
    stashPairingLink(LINK);
    expect(seen).toEqual([1]);
    takePairingLink();
    expect(seen).toEqual([1]);
    unsubscribe();
    stashPairingLink(LINK);
    expect(seen).toEqual([1]);
  });
});
