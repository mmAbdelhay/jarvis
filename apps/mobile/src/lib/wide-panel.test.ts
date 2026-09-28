import { describe, expect, it } from "vitest";
import { authCardFrame, widePanelFrame } from "./wide-panel";

describe("widePanelFrame", () => {
  it("clamps a wide page to the desktop's 1180 measure, framed as a panel", () => {
    expect(widePanelFrame("wide")).toEqual({ maxWidth: 1180, framed: true });
  });

  it("leaves a phone page full width and unframed", () => {
    expect(widePanelFrame("phone")).toEqual({ maxWidth: undefined, framed: false });
  });
});

describe("authCardFrame", () => {
  it("draws unlock/pair as a 480-wide card on a wide screen", () => {
    expect(authCardFrame("wide")).toEqual({ maxWidth: 480, framed: true });
  });

  it("leaves unlock/pair full screen on a phone", () => {
    expect(authCardFrame("phone")).toEqual({ maxWidth: undefined, framed: false });
  });
});
