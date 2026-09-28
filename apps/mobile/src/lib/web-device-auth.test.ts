import { describe, expect, it } from "vitest";
import { createWebDeviceAuth } from "./web-device-auth";

describe("createWebDeviceAuth (the browser has no OS prompt)", () => {
  it("allows storing a refresh token exactly when keep-signed-in is on", async () => {
    expect(await createWebDeviceAuth(async () => true).hasPasscode()).toBe(true);
    expect(await createWebDeviceAuth(async () => false).hasPasscode()).toBe(false);
  });

  it("an unreadable setting counts as off", async () => {
    const auth = createWebDeviceAuth(async () => {
      throw new Error("storage blocked");
    });
    expect(await auth.hasPasscode()).toBe(false);
  });

  it("the owner check always passes: a stored token goes straight to auth:refresh", async () => {
    expect(await createWebDeviceAuth(async () => true).authenticate()).toBe(true);
  });
});
