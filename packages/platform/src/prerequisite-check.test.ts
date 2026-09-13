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
    // Headlamp's bundle path is a fixed install location rather than a PATH
    // walk — it is where the Cluster tab reads the server from — so it is the
    // one lookup outside PATH and home that is meant to be there.
    const stray = looked.filter(
      (p) =>
        !p.startsWith("/only/here") &&
        !p.startsWith("/home/u") &&
        p !== "/opt/Headlamp/resources/headlamp-server",
    );
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
    // Only file checks at fixed locations — the voice models, piper's link,
    // Headlamp's bundle — and never a PATH lookup. An empty entry must not
    // become a lookup of "/ffmpeg".
    expect(looked.filter((p) => /^\/[^/]+$/.test(p))).toEqual([]);
    expect(looked).toContain("/home/u/.config/jarvis/voices/en-gb-alan-low.onnx");
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
    const npm = { fileExists: (p: string) => p === "/usr/bin/npm" };
    expect(statusOf(npm, "dbgate")?.installable).toBe(true);
    expect(statusOf(npm, "dbgate")?.manual).toBeUndefined();
  });

  it("will not offer an install whose own installer is missing", () => {
    // A Mac with no Homebrew, a machine with no Node. The row used to say
    // "can be installed", and pressing it printed `command not found`.
    const dbgate = statusOf({ fileExists: () => false }, "dbgate");
    expect(dbgate?.installable).toBe(false);
    expect(dbgate?.manual).toContain("nodejs.org");

    const ffmpeg = statusOf({ platform: "darwin", fileExists: () => false }, "ffmpeg");
    expect(ffmpeg?.installable).toBe(false);
    expect(ffmpeg?.manual).toContain("brew.sh");
  });

  it("counts a Headlamp installed as a desktop app on macOS", () => {
    // The cask leaves nothing on PATH, and the Cluster tab reads the server
    // out of the bundle — so this is the state the app actually cares about.
    expect(
      statusOf(
        {
          platform: "darwin",
          arch: "arm64",
          fileExists: (p) => p === "/Applications/Headlamp.app/Contents/Resources/headlamp-server",
        },
        "headlamp",
      )?.installed,
    ).toBe(true);
  });

  it("counts a piper linked into ~/.local/bin, which macOS keeps off PATH", () => {
    expect(
      statusOf({ fileExists: (p) => p === "/home/u/.local/bin/piper" }, "piper")?.installed,
    ).toBe(true);
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
