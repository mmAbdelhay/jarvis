import { describe, expect, it } from "vitest";
import {
  NO_IDLE_LOCK,
  idleLockMs,
  isMachineView,
  keepSignedInFor,
  machineViewFor,
} from "./machine-view";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

describe("isMachineView", () => {
  it("is true when the token is its own word", () => {
    expect(isMachineView(`${CHROME} JarvisMachineView/1`)).toBe(true);
    expect(isMachineView("JarvisMachineView/1")).toBe(true);
    expect(isMachineView(`JarvisMachineView/1 ${CHROME}`)).toBe(true);
  });

  it("is false for a longer word that contains it", () => {
    expect(isMachineView(`${CHROME} XJarvisMachineView/1`)).toBe(false);
    expect(isMachineView(`${CHROME} JarvisMachineView/1X`)).toBe(false);
    expect(isMachineView(`${CHROME} JarvisMachineView/1.0`)).toBe(false);
  });

  it("is false for another version", () => {
    expect(isMachineView(`${CHROME} JarvisMachineView/2`)).toBe(false);
    expect(isMachineView(`${CHROME} JarvisMachineView/`)).toBe(false);
  });

  it("is false when absent", () => {
    expect(isMachineView(CHROME)).toBe(false);
    expect(isMachineView("")).toBe(false);
  });
});

describe("machineViewFor", () => {
  it("only the browser build reads the user agent", () => {
    expect(machineViewFor("web", `${CHROME} JarvisMachineView/1`)).toBe(true);
    expect(machineViewFor("ios", `${CHROME} JarvisMachineView/1`)).toBe(false);
    expect(machineViewFor("android", `${CHROME} JarvisMachineView/1`)).toBe(false);
  });

  it("a missing or non-string user agent is not a machine view", () => {
    expect(machineViewFor("web", undefined)).toBe(false);
    expect(machineViewFor("web", 42)).toBe(false);
    expect(machineViewFor("web", CHROME)).toBe(false);
  });
});

describe("idleLockMs", () => {
  it("a machine view has no idle lock", () => {
    expect(idleLockMs(true, 15 * 60_000)).toBe(NO_IDLE_LOCK);
  });

  it("anywhere else the chosen window is used unchanged", () => {
    expect(idleLockMs(false, 15 * 60_000)).toBe(15 * 60_000);
    expect(idleLockMs(false, 5 * 60_000)).toBe(5 * 60_000);
  });
});

describe("keepSignedInFor", () => {
  it("is forced on only in a machine view", () => {
    expect(keepSignedInFor(true, false)).toBe(true);
    expect(keepSignedInFor(true, true)).toBe(true);
  });

  it("anywhere else follows the owner's choice", () => {
    expect(keepSignedInFor(false, false)).toBe(false);
    expect(keepSignedInFor(false, true)).toBe(true);
  });
});
