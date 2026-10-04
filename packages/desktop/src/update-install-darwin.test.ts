import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appBundleOf,
  darwinSwapScript,
  installBlocker,
  prepareDarwin,
} from "./update-install-darwin.js";

describe("appBundleOf", () => {
  it("returns the .app that holds the executable", () => {
    expect(appBundleOf("/Applications/Jarvis.app/Contents/MacOS/Jarvis")).toBe(
      "/Applications/Jarvis.app",
    );
    expect(appBundleOf("/Users/me/My Apps/Jarvis.app/Contents/MacOS/Jarvis")).toBe(
      "/Users/me/My Apps/Jarvis.app",
    );
  });

  it("is undefined outside an app bundle", () => {
    expect(appBundleOf("/usr/local/bin/electron")).toBeUndefined();
    expect(appBundleOf("/Applications/Jarvis.app/Contents/Resources/x")).toBeUndefined();
  });
});

describe("installBlocker", () => {
  it("flags an app run from App Translocation", () => {
    const bundle = "/private/var/folders/x/AppTranslocation/ABC/d/Jarvis.app";
    expect(installBlocker(bundle, () => true)).toBe("translocated");
  });

  it("flags a bundle whose folder cannot be written", () => {
    const seen: string[] = [];
    const writable = (dir: string) => {
      seen.push(dir);
      return false;
    };
    expect(installBlocker("/Applications/Jarvis.app", writable)).toBe("read-only");
    expect(seen).toEqual(["/Applications"]);
  });

  it("is undefined when the folder is writable", () => {
    expect(installBlocker("/Applications/Jarvis.app", () => true)).toBeUndefined();
  });
});

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>system-entities</key><array>
<dict><key>content-hint</key><string>GUID_partition_scheme</string><key>dev-entry</key><string>/dev/disk9</string></dict>
<dict><key>dev-entry</key><string>/dev/disk9s1</string><key>mount-point</key><string>/w/dmg.Ab12</string></dict>
</array></dict></plist>`;

type Call = [string, string[]];

function fakeExec(fail: Partial<Record<string, number>> = {}, stdout = PLIST) {
  const calls: Call[] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    const name = cmd.split("/").pop() as string;
    const key = name === "hdiutil" ? `hdiutil ${args[0]}` : name;
    return { code: fail[key] ?? 0, stdout: key === "hdiutil attach" ? stdout : "" };
  };
  return { calls, exec };
}

const base = { dmg: "/w/Jarvis.dmg", bundle: "/Applications/Jarvis.app", workDir: "/w" };

describe("prepareDarwin", () => {
  it("attaches, copies, clears quarantine and detaches, in order", async () => {
    const { calls, exec } = fakeExec();
    const result = await prepareDarwin({ ...base, exec });
    expect(result).toEqual({ ok: true, staged: "/Applications/Jarvis.app.new" });
    expect(calls).toEqual([
      [
        "/usr/bin/hdiutil",
        ["attach", "-nobrowse", "-readonly", "-plist", "-mountrandom", "/w", "/w/Jarvis.dmg"],
      ],
      ["/bin/test", ["-d", "/w/dmg.Ab12/Jarvis.app"]],
      ["/bin/rm", ["-rf", "/Applications/Jarvis.app.new"]],
      ["/usr/bin/ditto", ["/w/dmg.Ab12/Jarvis.app", "/Applications/Jarvis.app.new"]],
      ["/usr/bin/xattr", ["-dr", "com.apple.quarantine", "/Applications/Jarvis.app.new"]],
      ["/usr/bin/hdiutil", ["detach", "/w/dmg.Ab12"]],
    ]);
  });

  it("detaches and removes the partial copy when ditto fails", async () => {
    const { calls, exec } = fakeExec({ ditto: 1 });
    const result = await prepareDarwin({ ...base, exec });
    expect(result).toEqual({ ok: false, reason: "copy-failed" });
    expect(calls.slice(-2)).toEqual([
      ["/bin/rm", ["-rf", "/Applications/Jarvis.app.new"]],
      ["/usr/bin/hdiutil", ["detach", "/w/dmg.Ab12"]],
    ]);
  });

  it("fails without copying when the image has no Jarvis.app", async () => {
    const { calls, exec } = fakeExec({ test: 1 });
    expect(await prepareDarwin({ ...base, exec })).toEqual({ ok: false, reason: "no-app" });
    expect(calls.map(([cmd]) => cmd)).not.toContain("/usr/bin/ditto");
    expect(calls.at(-1)).toEqual(["/usr/bin/hdiutil", ["detach", "/w/dmg.Ab12"]]);
  });

  it("fails when quarantine cannot be cleared", async () => {
    const { calls, exec } = fakeExec({ xattr: 1 });
    expect(await prepareDarwin({ ...base, exec })).toEqual({
      ok: false,
      reason: "quarantine",
    });
    expect(calls.at(-1)?.[1][0]).toBe("detach");
  });

  it("forces the detach when a plain detach fails", async () => {
    const { calls, exec } = fakeExec({ "hdiutil detach": 1 });
    expect((await prepareDarwin({ ...base, exec })).ok).toBe(true);
    expect(calls.slice(-2)).toEqual([
      ["/usr/bin/hdiutil", ["detach", "/w/dmg.Ab12"]],
      ["/usr/bin/hdiutil", ["detach", "/w/dmg.Ab12", "-force"]],
    ]);
  });

  it("fails without detaching when attach fails or reports no mount", async () => {
    const failed = fakeExec({ "hdiutil attach": 1 });
    expect(await prepareDarwin({ ...base, exec: failed.exec })).toEqual({
      ok: false,
      reason: "attach-failed",
    });
    expect(failed.calls).toHaveLength(1);

    const noMount = fakeExec({}, "<plist><dict></dict></plist>");
    expect(await prepareDarwin({ ...base, exec: noMount.exec })).toEqual({
      ok: false,
      reason: "attach-failed",
    });
    expect(noMount.calls).toHaveLength(1);
  });

  it("detaches even when a command throws", async () => {
    const calls: Call[] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      if (cmd.endsWith("ditto")) throw new Error("spawn failed");
      return { code: 0, stdout: PLIST };
    };
    expect(await prepareDarwin({ ...base, exec })).toEqual({
      ok: false,
      reason: "copy-failed",
    });
    expect(calls.at(-1)).toEqual(["/usr/bin/hdiutil", ["detach", "/w/dmg.Ab12"]]);
  });
});

describe("darwinSwapScript text", () => {
  const odd = "/Users/me/It's Mine/Jarvis.app";

  it("single-quotes paths, escaping embedded quotes", () => {
    const script = darwinSwapScript({ pid: 42, bundle: odd, staged: `${odd}.new` });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(`app='/Users/me/It'\\''s Mine/Jarvis.app'`);
    expect(script).toContain(`staged='/Users/me/It'\\''s Mine/Jarvis.app.new'`);
    expect(script).toContain(`old='/Users/me/It'\\''s Mine/Jarvis.app.old'`);
    expect(script).toContain("pid=42");
  });

  it("restores the old bundle when the new one cannot be moved in", () => {
    const script = darwinSwapScript({ pid: 42, bundle: odd, staged: `${odd}.new` });
    expect(script).toMatch(/if ! mv "\$staged" "\$app"; then[\s\S]*mv "\$old" "\$app"/);
    expect(script).toContain(`open "$app"`);
  });

  it("rejects a pid that is not a positive integer", () => {
    for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => darwinSwapScript({ pid, bundle: odd, staged: `${odd}.new` })).toThrow();
    }
  });
});

describe("darwinSwapScript run", () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) {
      spawnSync("/bin/chmod", ["-R", "u+w", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "jarvis swap 'd' "));
    const bundle = join(dir, "Jarvis.app");
    mkdirSync(join(bundle, "Contents"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "version"), "old");
    const staged = `${bundle}.new`;
    mkdirSync(join(staged, "Contents"), { recursive: true });
    writeFileSync(join(staged, "Contents", "version"), "new");
    const log = join(dir, "launched.log");
    const launcher = join(dir, "launcher.sh");
    writeFileSync(launcher, `printf '%s\\n' "$1" >> '${log.replace(/'/g, `'\\''`)}'\n`);
    return { bundle, staged, log, launch: `/bin/sh '${launcher.replace(/'/g, `'\\''`)}'` };
  }

  function exitedPid(): number {
    const child = spawnSync("/usr/bin/true");
    return child.pid as number;
  }

  function run(script: string) {
    const file = join(dir, "swap.sh");
    writeFileSync(file, script);
    return spawnSync("/bin/sh", [file], { encoding: "utf8" });
  }

  const version = (bundle: string) => readFileSync(join(bundle, "Contents", "version"), "utf8");

  it("swaps in the new bundle, opens it and removes the old one", () => {
    const { bundle, staged, log, launch } = setup();
    const result = run(darwinSwapScript({ pid: exitedPid(), bundle, staged, launch }));
    expect(result.status).toBe(0);
    expect(version(bundle)).toBe("new");
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(`${bundle}.old`)).toBe(false);
    expect(readFileSync(log, "utf8")).toBe(`${bundle}\n`);
  });

  it("replaces a stale .old left by a failed earlier run", () => {
    const { bundle, staged, launch } = setup();
    mkdirSync(join(`${bundle}.old`, "stale"), { recursive: true });
    const result = run(darwinSwapScript({ pid: exitedPid(), bundle, staged, launch }));
    expect(result.status).toBe(0);
    expect(version(bundle)).toBe("new");
    expect(existsSync(join(bundle, "Jarvis.app"))).toBe(false);
    expect(existsSync(`${bundle}.old`)).toBe(false);
  });

  it("puts the old bundle back and opens it when the new one cannot move in", () => {
    const { bundle, log, launch } = setup();
    // The staged copy exists but sits in a folder it cannot be moved out of.
    const locked = join(dir, "locked");
    const staged = join(locked, "Jarvis.app.new");
    mkdirSync(join(staged, "Contents"), { recursive: true });
    writeFileSync(join(staged, "Contents", "version"), "new");
    chmodSync(locked, 0o555);
    const result = run(darwinSwapScript({ pid: exitedPid(), bundle, staged, launch }));
    expect(result.status).not.toBe(0);
    expect(version(bundle)).toBe("old");
    expect(existsSync(`${bundle}.old`)).toBe(false);
    expect(version(staged)).toBe("new");
    expect(readFileSync(log, "utf8")).toBe(`${bundle}\n`);
  });

  it("leaves everything alone and reopens the app when the staged bundle is missing", () => {
    const { bundle, staged, log, launch } = setup();
    rmSync(staged, { recursive: true });
    const result = run(darwinSwapScript({ pid: exitedPid(), bundle, staged, launch }));
    expect(result.status).not.toBe(0);
    expect(version(bundle)).toBe("old");
    expect(existsSync(`${bundle}.old`)).toBe(false);
    expect(readFileSync(log, "utf8")).toBe(`${bundle}\n`);
  });

  it("waits for the app's process to exit before swapping", async () => {
    const { bundle, staged, log, launch } = setup();
    const child = spawn("/bin/sleep", ["1"]);
    const file = join(dir, "swap.sh");
    writeFileSync(file, darwinSwapScript({ pid: child.pid as number, bundle, staged, launch }));
    const started = Date.now();
    const script = spawn("/bin/sh", [file]);
    // The swap must not happen while the app is still running.
    await new Promise((r) => setTimeout(r, 300));
    expect(version(bundle)).toBe("old");
    const status = await new Promise<number | null>((r) => script.on("exit", r));
    expect(status).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(version(bundle)).toBe("new");
    expect(readFileSync(log, "utf8")).toBe(`${bundle}\n`);
  });
});
