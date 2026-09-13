import { describe, expect, it } from "vitest";
import { runInstall, type InstallDeps } from "./prerequisite-install.js";

function harness(overrides: Partial<InstallDeps> = {}) {
  const ran: { command: string; args: readonly string[] }[] = [];
  const downloaded: { url: string; dest: string }[] = [];
  const linked: { from: string; to: string }[] = [];
  const output: string[] = [];

  const deps: InstallDeps = {
    run: async (command, args, onOutput) => {
      ran.push({ command, args });
      onOutput("added 1 package\n");
      return 0;
    },
    download: async (url, dest) => {
      downloaded.push({ url, dest });
    },
    extract: async (_url, dest) => `${dest}/piper`,
    link: async (from, to) => {
      linked.push({ from, to });
    },
    locate: async (command) => `/npm/prefix/bin/${command}`,
    home: "/home/u",
    onOutput: (chunk) => output.push(chunk),
    ...overrides,
  };

  return { deps, ran, downloaded, linked, output };
}

describe("runInstall", () => {
  it("refuses a manual step rather than executing it", async () => {
    // The runtime half of the guarantee the types make structurally. Getting
    // here means a caller ignored `installable`, and running a root command
    // because of a caller's bug is exactly what this design refuses.
    const { deps, ran } = harness();
    const result = await runInstall({ kind: "manual", display: "ffmpeg" }, deps);

    expect(result.ok).toBe(false);
    expect(ran).toEqual([]);
  });

  it("runs a command and reports success", async () => {
    const { deps, ran } = harness();
    const result = await runInstall(
      { kind: "run", command: "npm", args: ["i", "-g", "dbgate-serve"] },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(ran).toEqual([{ command: "npm", args: ["i", "-g", "dbgate-serve"] }]);
  });

  it("streams output as it arrives rather than at the end", async () => {
    // A failed npm install is diagnosed from "npm ERR! EACCES" and nothing
    // else, so the screen shows it live.
    const { deps, output } = harness();
    await runInstall({ kind: "run", command: "npm", args: [] }, deps);

    expect(output.join("")).toContain("added 1 package");
  });

  it("reports a non-zero exit without throwing", async () => {
    const { deps } = harness({ run: async () => 1 });
    const result = await runInstall({ kind: "run", command: "npm", args: [] }, deps);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("exited with code 1");
  });

  it("reports a thrown error without throwing", async () => {
    // One row failing must not abandon the other rows the user ticked.
    const { deps } = harness({
      run: async () => {
        throw new Error("spawn npm ENOENT");
      },
    });
    const result = await runInstall({ kind: "run", command: "npm", args: [] }, deps);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ENOENT");
  });

  it("links an npm binary into a directory the login shell can see", async () => {
    // npm under nvm installs into a bin a non-interactive login shell cannot
    // see — the exact reason the Database tab failed with dbgate-serve
    // installed and on PATH in every terminal.
    const { deps, linked } = harness();
    await runInstall(
      {
        kind: "run",
        command: "npm",
        args: ["i", "-g", "dbgate-serve"],
        linkInto: "~/.local/bin",
        linkBinary: "dbgate-serve",
      },
      deps,
    );

    expect(linked).toEqual([
      { from: "/npm/prefix/bin/dbgate-serve", to: "/home/u/.local/bin/dbgate-serve" },
    ]);
  });

  it("does not link a binary that is already where it would be linked", async () => {
    const { deps, linked } = harness({
      locate: async () => "/home/u/.local/bin/dbgate-serve",
    });
    await runInstall(
      {
        kind: "run",
        command: "npm",
        args: [],
        linkInto: "~/.local/bin",
        linkBinary: "dbgate-serve",
      },
      deps,
    );

    expect(linked).toEqual([]);
  });

  it("still succeeds when the link cannot be made", async () => {
    // A tool that installed and could not be linked is still installed, and
    // saying otherwise would be a lie about the part that matters.
    const { deps } = harness({
      link: async () => {
        throw new Error("read-only filesystem");
      },
    });
    const result = await runInstall(
      { kind: "run", command: "npm", args: [], linkInto: "~/.local/bin", linkBinary: "x" },
      deps,
    );

    expect(result.ok).toBe(true);
  });

  it("downloads every file a step names", async () => {
    // A voice is an .onnx AND the .onnx.json beside it; piper refuses to
    // start with only one, so a partial download is a voice that looks
    // installed and cannot speak.
    const { deps, downloaded } = harness();
    await runInstall(
      {
        kind: "download",
        files: [
          { url: "https://h/en.onnx", dest: "~/.config/jarvis/voices/en.onnx" },
          { url: "https://h/en.onnx.json", dest: "~/.config/jarvis/voices/en.onnx.json" },
        ],
      },
      deps,
    );

    expect(downloaded).toEqual([
      { url: "https://h/en.onnx", dest: "/home/u/.config/jarvis/voices/en.onnx" },
      { url: "https://h/en.onnx.json", dest: "/home/u/.config/jarvis/voices/en.onnx.json" },
    ]);
  });

  it("reports a failed download rather than leaving half a voice", async () => {
    const { deps } = harness({
      download: async () => {
        throw new Error("404");
      },
    });
    const result = await runInstall(
      { kind: "download", files: [{ url: "https://h/a", dest: "~/a" }] },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("404");
  });

  it("extracts an archive and links the binary out of it", async () => {
    const { deps, linked } = harness();
    const result = await runInstall(
      {
        kind: "extract",
        url: "https://g/piper_linux_x86_64.tar.gz",
        dest: "~/.local/lib/piper",
        binary: "piper",
        linkInto: "~/.local/bin",
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(linked).toEqual([
      { from: "/home/u/.local/lib/piper/piper/piper", to: "/home/u/.local/bin/piper" },
    ]);
  });

  it("expands ~ against the home it was given, not the process's", async () => {
    const { deps, downloaded } = harness({ home: "/Users/x" });
    await runInstall({ kind: "download", files: [{ url: "u", dest: "~/v/a.onnx" }] }, deps);

    expect(downloaded[0]?.dest).toBe("/Users/x/v/a.onnx");
  });
});
