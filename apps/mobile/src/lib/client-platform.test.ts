import { describe, expect, it } from "vitest";
import { clientPlatformFor, clientStringFor } from "./client-platform";

describe("clientPlatformFor", () => {
  it("maps the web OS to web and every other OS to native", () => {
    expect(clientPlatformFor("web")).toBe("web");
    expect(clientPlatformFor("ios")).toBe("native");
    expect(clientPlatformFor("android")).toBe("native");
  });
});

describe("clientStringFor", () => {
  it('answers exactly "web" for the browser build (hello/pair `client`)', () => {
    expect(clientStringFor("web", "1.2.3")).toBe("web");
  });

  it("keeps the native jarvis-mobile/<version>/<os> shape unchanged", () => {
    expect(clientStringFor("ios", "1.2.3")).toBe("jarvis-mobile/1.2.3/ios");
    expect(clientStringFor("android", "0.0.0")).toBe("jarvis-mobile/0.0.0/android");
  });
});
