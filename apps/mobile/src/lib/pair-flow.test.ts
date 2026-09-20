import type { PairingLink } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import {
  afterClearRetry,
  type AlreadyPairedCheck,
  canStartIntake,
  entryPhaseKind,
  fingerprintTail,
  hostStep,
  intakeStep,
  type PairFlowPhaseKind,
  phaseAfterCheck,
  shouldDrainPairingLink,
} from "./pair-flow";

const LINK: PairingLink = {
  host: "192.168.1.5",
  port: 4317,
  secret: "s".repeat(43),
  fingerprint: `${"a".repeat(60)}beef`,
};

const BUSY_PHASES: PairFlowPhaseKind[] = [
  "checking",
  "alreadyPaired",
  "clearFailed",
  "needsHost",
  "confirm",
  "waiting",
  "error",
  "success",
];

describe("canStartIntake", () => {
  it("allows a new intake only from the scan step, when nothing is paired yet", () => {
    expect(canStartIntake({ alreadyPaired: false, phaseKind: "scan" })).toBe(true);
  });

  for (const phaseKind of BUSY_PHASES) {
    it(`refuses while busy (phase "${phaseKind}"), even when nothing is paired yet`, () => {
      expect(canStartIntake({ alreadyPaired: false, phaseKind })).toBe(false);
    });
  }

  it(
    "refuses from the scan step once a pairing already exists " +
      "[bite-proof: drop the alreadyPaired check and this test fails]",
    () => {
      expect(canStartIntake({ alreadyPaired: true, phaseKind: "scan" })).toBe(false);
    },
  );

  it("refuses when already paired and busy at once", () => {
    expect(canStartIntake({ alreadyPaired: true, phaseKind: "waiting" })).toBe(false);
  });
});

describe("fingerprintTail", () => {
  it("returns the last 4 hex characters", () => {
    expect(fingerprintTail(`${"a".repeat(60)}beef`)).toBe("beef");
  });

  it("never returns the whole fingerprint", () => {
    const fingerprint = "1".repeat(64);
    const tail = fingerprintTail(fingerprint);
    expect(tail.length).toBe(4);
    expect(tail).not.toBe(fingerprint);
  });
});

describe("intakeStep", () => {
  it("routes an unspecified-host link to needsHost, never to a step that starts pairing", () => {
    expect(intakeStep({ ...LINK, host: "0.0.0.0" })).toEqual({ kind: "needsHost" });
  });

  it(
    "routes an unspecified-host link with a `name` straight to confirm, never needsHost " +
      "(M11 rulings.md 1: the name is dialled, the bind address is irrelevant) " +
      "[bite-proof: drop the `link.name !== undefined` short-circuit in needsHost and this fails]",
    () => {
      const step = intakeStep({ ...LINK, host: "0.0.0.0", name: "mac.tail.ts.net" });
      expect(step).toEqual({
        kind: "confirm",
        host: "0.0.0.0",
        port: LINK.port,
        fingerprintTail: "beef",
        name: "mac.tail.ts.net",
      });
    },
  );

  it("intakeStep's confirm step carries `name` when the link has one", () => {
    const step = intakeStep({ ...LINK, name: "mac.tail.ts.net" });
    expect(step).toEqual({
      kind: "confirm",
      host: LINK.host,
      port: LINK.port,
      fingerprintTail: "beef",
      name: "mac.tail.ts.net",
    });
  });

  it(
    "routes a concrete link straight to confirm, never to a start/waiting step " +
      '[bite-proof: return {kind:"start"} instead and this fails]',
    () => {
      const step = intakeStep(LINK);
      expect(step).toEqual({
        kind: "confirm",
        host: LINK.host,
        port: LINK.port,
        fingerprintTail: "beef",
      });
    },
  );

  it("never includes the secret in its result", () => {
    const step = intakeStep(LINK);
    expect(JSON.stringify(step)).not.toContain(LINK.secret);
  });
});

describe("hostStep", () => {
  const unresolved: PairingLink = { ...LINK, host: "0.0.0.0" };

  it("reports invalid for a host withHost can't resolve, never a start/waiting step", () => {
    expect(hostStep(unresolved, "laptop.local")).toEqual({ kind: "invalid" });
  });

  it("reports invalid for an unspecified host, same as withHost", () => {
    expect(hostStep(unresolved, "0.0.0.0")).toEqual({ kind: "invalid" });
  });

  it("routes a valid host straight to confirm, never to a start/waiting step", () => {
    const step = hostStep(unresolved, "192.168.1.10");
    expect(step).toEqual({
      kind: "confirm",
      host: "192.168.1.10",
      port: LINK.port,
      fingerprintTail: "beef",
    });
  });

  it("never includes the secret in its result", () => {
    const step = hostStep(unresolved, "192.168.1.10");
    expect(JSON.stringify(step)).not.toContain(LINK.secret);
  });
});

describe("phaseAfterCheck", () => {
  it("routes to scan when the check succeeds and found nothing paired", () => {
    const check: AlreadyPairedCheck = { ok: true, paired: false };
    expect(phaseAfterCheck(check)).toBe("scan");
  });

  it("routes to alreadyPaired when the check succeeds and found a record", () => {
    const check: AlreadyPairedCheck = { ok: true, paired: true };
    expect(phaseAfterCheck(check)).toBe("alreadyPaired");
  });

  it(
    "fails closed: a failed check never routes to scan " +
      '[bite-proof: return "scan" on failure instead of "checkFailed" and this fails]',
    () => {
      const check: AlreadyPairedCheck = { ok: false };
      expect(phaseAfterCheck(check)).toBe("checkFailed");
    },
  );

  it("fails closed even when the previous known state was scan-eligible", () => {
    // The point of failing closed: no information about "paired" survives
    // a failed check, so the result can never be "scan" — only "checkFailed".
    const check: AlreadyPairedCheck = { ok: false };
    expect(phaseAfterCheck(check)).not.toBe("scan");
  });
});

describe("entryPhaseKind (fix round 2, I2 ruling)", () => {
  it("goes straight to clearFailed when the phone arrived with the clearFailed signal set", () => {
    // An unpaired episode whose clearPairing failed routes here (via a
    // route param or shared flag — _layout.tsx's choice) instead of
    // through the ordinary already-paired check, which would show the
    // contradictory "already paired" screen the ruling forbids.
    expect(entryPhaseKind(true)).toBe("clearFailed");
  });

  it(
    "otherwise starts the ordinary checking flow " +
      '[bite-proof: return "clearFailed" unconditionally and this fails]',
    () => {
      expect(entryPhaseKind(false)).toBe("checking");
    },
  );
});

describe("shouldDrainPairingLink (final review R-M1)", () => {
  it(
    "never drains for scan — the only outcome that still wants a held link " +
      "[bite-proof: return true unconditionally and this fails]",
    () => {
      expect(shouldDrainPairingLink("scan")).toBe(false);
    },
  );

  for (const nextKind of ["alreadyPaired", "checkFailed", "clearFailed"] as const) {
    it(
      `drains for "${nextKind}" — a link stashed for a phone refusing to pair ` +
        "right now must not linger or resurface later " +
        "[bite-proof: return false unconditionally and this fails]",
      () => {
        expect(shouldDrainPairingLink(nextKind)).toBe(true);
      },
    );
  }
});

describe("afterClearRetry (fix round 2, I2 ruling)", () => {
  it("moves to the normal scan phase once a retried clear succeeds", () => {
    expect(afterClearRetry(true)).toBe("scan");
  });

  it(
    "stays in clearFailed while the retry keeps failing " +
      '[bite-proof: return "scan" unconditionally and this fails]',
    () => {
      expect(afterClearRetry(false)).toBe("clearFailed");
    },
  );
});
