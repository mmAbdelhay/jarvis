import { describe, expect, it } from "vitest";
import {
  detectionFor,
  installFor,
  manualLine,
  missingRunnerLine,
  packageManager,
  PREREQUISITES,
  type PrerequisiteId,
} from "./prerequisites.js";

const PLATFORMS = ["darwin", "linux", "win32"] as const;

describe("the catalogue", () => {
  it("marks exactly one prerequisite required", () => {
    // The agent CLI. Everything else reduces Jarvis; only this makes it
    // pointless, and a screen calling five things "required" teaches the
    // reader to ignore the word.
    expect(PREREQUISITES.filter((p) => p.required).map((p) => p.id)).toEqual(["agent"]);
  });

  it("never marks a root install as runnable", () => {
    // The structural half of "Jarvis never asks for your password": a manual
    // step has no field that could be executed, so no later edit can quietly
    // promote one. This checks the other direction — that nothing runnable
    // smuggled a sudo into its arguments.
    for (const p of PREREQUISITES) {
      for (const step of Object.values(p.install)) {
        const resolved = typeof step === "function" ? step("x64") : step;
        if (resolved.kind === "manual") continue;
        expect(JSON.stringify(resolved)).not.toMatch(/\bsudo\b/);
        expect(JSON.stringify(resolved)).not.toMatch(/\bpkexec\b/);
      }
    }
  });

  it("gives every tool a detection", () => {
    for (const p of PREREQUISITES) expect(p.detect).toBeDefined();
  });

  it("gives every id a unique entry", () => {
    const ids = PREREQUISITES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("installs the agent CLI the same way everywhere", () => {
    for (const platform of PLATFORMS) {
      expect(installFor("agent", platform, "x64")).toMatchObject({
        kind: "run",
        command: "npm",
        args: ["i", "-g", "@anthropic-ai/claude-code"],
      });
    }
  });

  it("links an npm-installed binary somewhere a login shell can see", () => {
    // npm under nvm installs into a bin a non-interactive login shell cannot
    // see, which is exactly how the Database tab came to fail with
    // dbgate-serve installed and on PATH in every terminal.
    for (const id of ["agent", "dbgate"] as const) {
      expect(installFor(id, "linux", "x64")).toMatchObject({ linkInto: "~/.local/bin" });
    }
  });

  it("picks piper's tarball by platform and architecture", () => {
    // Named exactly as the release lists its assets.
    expect(installFor("piper", "linux", "x64")).toMatchObject({
      kind: "extract",
      url: expect.stringContaining("piper_linux_x86_64.tar.gz"),
    });
    expect(installFor("piper", "linux", "arm64")).toMatchObject({
      url: expect.stringContaining("piper_linux_aarch64.tar.gz"),
    });
    expect(installFor("piper", "win32", "x64")).toMatchObject({
      url: expect.stringContaining("piper_windows_amd64.zip"),
    });
  });

  it("never downloads piper's macOS archive, which cannot run", () => {
    // Both macOS assets of the last release (2023.11.14-2) ship no
    // libespeak-ng dylib, so the binary dies in dyld wherever it is put. The
    // Linux and Windows archives do carry their libraries, which is why only
    // this one is a line to read instead.
    for (const arch of ["arm64", "x64"]) {
      const step = installFor("piper", "darwin", arch);
      expect(step).toMatchObject({ kind: "manual" });
      expect(JSON.stringify(step)).not.toContain("piper_macos");
    }
  });

  it("points macOS at the build that works", () => {
    // The Python package, which is also what SETUP.md and the guide say.
    expect(manualLine("piper", "brew")).toBe("uv tool install piper-tts");
  });

  it("asks for piper by hand on an architecture with no release", () => {
    // 32-bit ARM. Better a line to read than a download that 404s.
    expect(installFor("piper", "linux", "arm")).toMatchObject({ kind: "manual" });
  });

  it("downloads both files of a voice, never just the model", () => {
    // piper reads the .json beside the .onnx for its sample rate and phoneme
    // map, and refuses to start without it — so a model alone is a voice that
    // looks installed and cannot speak.
    for (const id of ["voice-en", "voice-ar"] as const) {
      const step = installFor(id, "linux", "x64");
      expect(step?.kind).toBe("download");
      if (step?.kind !== "download") throw new Error("unreachable");
      expect(step.files).toHaveLength(2);
      expect(step.files.map((f) => f.dest.endsWith(".onnx.json"))).toContain(true);
      expect(step.files.map((f) => f.dest.endsWith(".onnx"))).toContain(true);
    }
  });

  it("puts the voices where config already looks for them", () => {
    // Installing them anywhere else would leave the user editing jarvis.yaml,
    // which is most of the work this is meant to remove. See config.ts's
    // DEFAULT_PIPER_MODEL and DEFAULT_PIPER_ARABIC_MODEL.
    const en = installFor("voice-en", "linux", "x64");
    if (en?.kind !== "download") throw new Error("unreachable");
    expect(en.files[0]?.dest).toBe("~/.config/jarvis/voices/en-gb-alan-low.onnx");

    const ar = installFor("voice-ar", "linux", "x64");
    if (ar?.kind !== "download") throw new Error("unreachable");
    expect(ar.files[0]?.dest).toBe("~/.config/jarvis/voices/ar_JO-kareem-low.onnx");
  });

  it("has no install for a player on macOS, which ships one", () => {
    // afplay. "Not installable here" and "missing" are different states, and
    // the screen shows them differently.
    expect(installFor("player", "darwin", "arm64")).toBeUndefined();
  });

  it("never offers to install kubectl", () => {
    for (const platform of PLATFORMS) {
      expect(installFor("kubectl", platform, "x64")).toBeUndefined();
    }
  });

  it("does not install code-server from npm, which cannot build on Node 22+", () => {
    // It pulls kerberos, a native module, and the build fails. The install
    // script ships a standalone build with its own Node.
    const step = installFor("code-server", "linux", "x64");
    expect(JSON.stringify(step)).not.toContain("npm");
    expect(JSON.stringify(step)).toContain("standalone");
  });

  it("keeps every code-server and piper install inside $HOME", () => {
    // No root, so no password prompt, so nothing for a user to be rightly
    // suspicious of on first launch.
    for (const id of ["code-server", "piper"] as const) {
      const step = installFor(id, "linux", "x64");
      const text = JSON.stringify(step);
      expect(text).not.toMatch(/\/usr\/(local\/)?(bin|lib)/);
    }
  });

  it("covers all three platforms for everything that is installable at all", () => {
    // A tool installable on one platform and silently absent on another is a
    // gap the screen would render as "not available here", which would be a
    // lie rather than a fact.
    const installable: PrerequisiteId[] = ["agent", "dbgate", "piper", "voice-en", "voice-ar"];
    for (const id of installable) {
      for (const platform of PLATFORMS) {
        expect(installFor(id, platform, "x64")).toBeDefined();
      }
    }
  });
});

describe("missingRunnerLine", () => {
  const npmStep = { kind: "run", command: "npm", args: ["i", "-g", "x"] } as const;

  it("says what is in the way when the installer itself is missing", () => {
    // A fresh Mac has no Homebrew. Offering "install" for a brew step there
    // produced `brew: command not found` inside the log and a row that never
    // went green.
    const line = missingRunnerLine(
      { kind: "run", command: "brew", args: ["install", "ffmpeg"] },
      () => false,
    );
    expect(line).toContain("brew install ffmpeg");
    expect(line).toContain("https://brew.sh");
  });

  it("is nothing at all when the installer is there", () => {
    expect(missingRunnerLine(npmStep, () => true)).toBeUndefined();
  });

  it("names Node for a missing npm", () => {
    expect(missingRunnerLine(npmStep, () => false)).toContain("nodejs.org");
  });

  it("blocks nothing it was not asked about", () => {
    // `sh` is on every machine this runs on, and a command absent from the
    // map is attempted as before rather than refused on a guess.
    expect(
      missingRunnerLine({ kind: "run", command: "sh", args: ["-c", "curl …"] }, () => false),
    ).toBeUndefined();
    expect(missingRunnerLine({ kind: "manual", display: "piper" }, () => false)).toBeUndefined();
  });
});

describe("detectionFor", () => {
  const headlamp = PREREQUISITES.find((p) => p.id === "headlamp");

  it("looks inside the application bundle on macOS, not only on PATH", () => {
    // `brew install --cask headlamp` puts a desktop app in /Applications and
    // nothing on PATH, and the Cluster tab resolves the server by that same
    // bundle path — so a PATH-only check reported missing what the app was
    // about to use.
    if (headlamp === undefined) throw new Error("unreachable");
    const detect = detectionFor(headlamp, "darwin", {});
    expect(JSON.stringify(detect)).toContain("/Applications/Headlamp.app");
  });

  it("hands back a plain detection unchanged", () => {
    const ffmpeg = PREREQUISITES.find((p) => p.id === "ffmpeg");
    if (ffmpeg === undefined) throw new Error("unreachable");
    expect(detectionFor(ffmpeg, "linux", {})).toEqual({ kind: "binary", command: "ffmpeg" });
  });
});

describe("packageManager", () => {
  it("finds apt, dnf or pacman on Linux", () => {
    expect(packageManager("linux", (c) => c === "apt-get")).toBe("apt");
    expect(packageManager("linux", (c) => c === "dnf")).toBe("dnf");
    expect(packageManager("linux", (c) => c === "pacman")).toBe("pacman");
  });

  it("probes apt-get rather than apt", () => {
    // `apt` is a newer front end that some minimal images leave out while
    // still having the package manager underneath.
    expect(packageManager("linux", (c) => c === "apt")).toBeUndefined();
  });

  it("prefers apt where a box has more than one", () => {
    expect(packageManager("linux", () => true)).toBe("apt");
  });

  it("is brew on macOS and winget on Windows", () => {
    expect(packageManager("darwin", () => true)).toBe("brew");
    expect(packageManager("win32", () => true)).toBe("winget");
  });

  it("is undefined where the manager itself is missing", () => {
    expect(packageManager("linux", () => false)).toBeUndefined();
    expect(packageManager("darwin", () => false)).toBeUndefined();
  });
});

describe("manualLine", () => {
  it("names the package the detected manager actually uses", () => {
    // A generic "install ffmpeg" is not the thing a reader can paste.
    expect(manualLine("ffmpeg", "apt")).toBe("sudo apt install ffmpeg");
    expect(manualLine("ffmpeg", "dnf")).toBe("sudo dnf install ffmpeg");
    expect(manualLine("ffmpeg", "pacman")).toBe("sudo pacman -S ffmpeg");
    expect(manualLine("ffmpeg", "brew")).toBe("brew install ffmpeg");
  });

  it("names all three audio players, since any one satisfies the check", () => {
    expect(manualLine("player", "apt")).toMatch(/pipewire/);
    expect(manualLine("player", "apt")).toMatch(/alsa-utils/);
  });

  it("falls back to the project's page when there is no package", () => {
    expect(manualLine("whisper", "apt")).toContain("whisper.cpp");
    expect(manualLine("headlamp", "apt")).toContain("headlamp.dev");
  });

  it("falls back to the page when no manager was detected at all", () => {
    expect(manualLine("docker", undefined)).toContain("docs.docker.com");
  });
});
