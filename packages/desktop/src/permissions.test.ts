import { describe, expect, it } from "vitest";
import { decidePermission } from "./permissions.js";

describe("decidePermission", () => {
  it.each(["clipboard-read", "media", "notifications"])("allows %s", (permission) => {
    expect(decidePermission(permission, false)).toBe(true);
  });

  it("allows geolocation only for the Jarvis window", () => {
    expect(decidePermission("geolocation", true)).toBe(true);
    expect(decidePermission("geolocation", false)).toBe(false);
  });
});
