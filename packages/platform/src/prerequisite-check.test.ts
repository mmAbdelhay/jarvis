import { describe, expect, it } from "vitest";
import { checkPrerequisites, missingRequired, type CheckDeps } from "./prerequisite-check.js";

const base: CheckDeps = {
  platform: "linux",
  arch: "x64",
  env: { PATH: "/usr/bin" },
  fileExists: () => false,
  home: "/home/u",
};

const statusOf = (deps: Partial<CheckDeps>, id: string) =>
  checkPrerequisites({ ...base, ...deps }).find((s) => s.id === id);

describe("checkPrerequisites", () => {
  it("reports a binary found on the given PATH as installed", () => {
    expect(
      statusOf(
        { env: { PATH: "/home/u/.local/bin" }, fileExists: (p) => p === "/home/u/.local/bin/ffmpeg" },
        "ffmpeg",
      )?.installed,
    ).toBe(true);
  });

  it("judges by the PATH it is given, and looks nowhere else", () => {
    // The installer must judge "installed" by the same rule the app judges it
    // by — the login shell's PATH. A tool under nvm is on an interactive
    // shell's PATH and not a GUI process's, and reporting it present is how
    // the Database tab came to fail with the tool apparently installed.
    const looked: string[] = [];
    checkPrerequisites({
      ...base,
      env: { PATH: "/only/here" },
      fileExists: (p) => {
        looked.push(p);
        return false;
      },
    });
    const stray = looked.filter((p) => !p.startsWith("/only/here") && !p.startsWith("/home/u"));
    expect(stray).toEqual([]);
  });

  it("ignores an empty PATH entry rather than testing the working directory", () => {
    const looked: string[] = [];
    checkPrerequisites({
      ...base,
      env: { PATH: "::" },
      fileExists: (p) => {
        looked.push(p);
        return false;
      },
    });
    // Only the voice models, which are file checks and not PATH lookups. An
    // empty entry must not become a lookup of "/ffmpeg".
    expect(looked.every((p) => p.startsWith("/home/u/.config/jarvis/voices/"))).toBe(true);
  });

  it("counts any one of the audio players as the player", () => {
    for (const player of ["pw-play", "paplay", "aplay"]) {
      expect(
        statusOf({ fileExists: (p) => p === `/usr/bin/${player}` }, "player")?.installed,
      ).toBe(true);
    }
  });

  it("counts afplay as the player on macOS", () => {
    expect(
      statusOf(
        { platform: "darwin", arch: "arm64", fileExists: (p) => p === "/usr/bin/afplay" },
        "player",
      )?.installed,
    ).toBe(true);
  });

  it("checks the voice models as files, not as binaries", () => {
    const statuses = checkPrerequisites({
      ...base,
      fileExists: (p) => p === "/home/u/.config/jarvis/voices/en-gb-alan-low.onnx",
    });
    expect(statuses.find((s) => s.id === "voice-en")?.installed).toBe(true);
    expect(statuses.find((s) => s.id === "voice-ar")?.installed).toBe(false);
  });

  it("expands ~ against the home directory it was given", () => {
    expect(
      statusOf(
        { home: "/Users/x", fileExists: (p) => p.startsWith("/Users/x/.config/jarvis/voices/") },
        "voice-ar",
      )?.installed,
    ).toBe(true);
  });

  it("marks a root install as not installable, and carries the line to copy", () => {
    const ffmpeg = statusOf({ fileExists: (p) => p === "/usr/bin/apt-get" }, "ffmpeg");
    expect(ffmpeg?.installable).toBe(false);
    expect(ffmpeg?.manual).toBe("sudo apt install ffmpeg");
  });

  it("marks something Jarvis can install without root as installable", () => {
    expect(statusOf({}, "dbgate")?.installable).toBe(true);
    expect(statusOf({}, "dbgate")?.manual).toBeUndefined();
  });

  it("offers no install for something already installed", () => {
    // Nothing to do is not the same as nothing available, and the screen must
    // not offer to reinstall what is there.
    expect(statusOf({ fileExists: (p) => p === "/usr/bin/docker" }, "docker")?.installable).toBe(
      false,
    );
  });

  it("reports a tool with no install on this platform as neither", () => {
    // kubectl anywhere, and the audio player on macOS. "Not available here"
    // is its own state.
    const kubectl = statusOf({}, "kubectl");
    expect(kubectl?.installed).toBe(false);
    expect(kubectl?.installable).toBe(false);
    expect(kubectl?.manual).toBeUndefined();
  });

  it("finds Windows binaries by their extension", () => {
    expect(
      statusOf(
        {
          platform: "win32",
          env: { PATH: "C:\\bin" },
          fileExists: (p) => p === "C:\\bin/dbgate-serve.cmd",
        },
        "dbgate",
      )?.installed,
    ).toBe(true);
  });

  it("splits a Windows PATH on semicolons", () => {
    expect(
      statusOf(
        {
          platform: "win32",
          env: { PATH: "C:\\a;C:\\b" },
          fileExists: (p) => p === "C:\\b/ffmpeg.exe",
        },
        "ffmpeg",
      )?.installed,
    ).toBe(true);
  });

  it("covers every catalogue entry, every time", () => {
    expect(checkPrerequisites(base)).toHaveLength(12);
  });
});

describe("missingRequired", () => {
  it("names the agent when it is absent", () => {
    // The screen opens itself for this even when it is not a first run: an
    // app with no agent has nothing to offer.
    expect(missingRequired(checkPrerequisites(base))).toEqual(["agent"]);
  });

  it("is empty when the required tool is there, whatever else is missing", () => {
    const statuses = checkPrerequisites({
      ...base,
      fileExists: (p) => p === "/usr/bin/claude",
    });
    expect(missingRequired(statuses)).toEqual([]);
  });
});
