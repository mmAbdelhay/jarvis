import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { controlPaths, endpointFor } from "./endpoint.js";

describe("endpointFor", () => {
  it("is a socket under ~/.config/jarvis/run on Unix", () => {
    expect(endpointFor({ platform: "darwin", home: "/Users/me", username: "me" })).toBe(
      "/Users/me/.config/jarvis/run/jarvisd.sock",
    );
    expect(endpointFor({ platform: "linux", home: "/home/me", username: "me" })).toBe(
      "/home/me/.config/jarvis/run/jarvisd.sock",
    );
  });

  it("is a named pipe keyed by the first 16 hex of sha256(username) on Windows", () => {
    const prefix = createHash("sha256").update("Me User").digest("hex").slice(0, 16);
    expect(endpointFor({ platform: "win32", home: "C:\\Users\\Me", username: "Me User" })).toBe(
      `\\\\.\\pipe\\jarvisd-${prefix}`,
    );
  });

  it("gives two users two different pipes", () => {
    const a = endpointFor({ platform: "win32", home: "C:\\Users\\a", username: "a" });
    const b = endpointFor({ platform: "win32", home: "C:\\Users\\b", username: "b" });
    expect(a).not.toBe(b);
  });
});

describe("controlPaths", () => {
  it("keeps the secret beside the socket on Unix", () => {
    expect(controlPaths({ platform: "linux", home: "/home/me", username: "me" })).toEqual({
      runDirectory: "/home/me/.config/jarvis/run",
      endpoint: "/home/me/.config/jarvis/run/jarvisd.sock",
      secretPath: "/home/me/.config/jarvis/run/control.secret",
    });
  });

  it("keeps the secret under the user profile on Windows", () => {
    const paths = controlPaths({ platform: "win32", home: "C:\\Users\\Me", username: "Me" });
    expect(paths.runDirectory).toBe("C:\\Users\\Me\\.config\\jarvis\\run");
    expect(paths.secretPath).toBe("C:\\Users\\Me\\.config\\jarvis\\run\\control.secret");
    expect(paths.endpoint.startsWith("\\\\.\\pipe\\jarvisd-")).toBe(true);
  });
});
