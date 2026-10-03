import { describe, expect, it } from "vitest";
import { screenHeaderModel } from "./screen-header";

describe("screenHeaderModel", () => {
  it("mirrors the back chevron in Arabic only", () => {
    expect(screenHeaderModel({ language: "ar", hasBack: true }).backMirrored).toBe(true);
    expect(screenHeaderModel({ language: "en", hasBack: true }).backMirrored).toBe(false);
  });

  it("omits the subtitle when it is missing or blank", () => {
    expect(screenHeaderModel({ language: "en", hasBack: true }).subtitle).toBeUndefined();
    expect(
      screenHeaderModel({ language: "en", hasBack: true, subtitle: "  " }).subtitle,
    ).toBeUndefined();
    expect(screenHeaderModel({ language: "en", hasBack: true, subtitle: "api" }).subtitle).toBe(
      "api",
    );
  });

  it("shows back only when a handler exists", () => {
    expect(screenHeaderModel({ language: "en", hasBack: false }).showBack).toBe(false);
  });
});
