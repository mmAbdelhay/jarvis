import { readFileSync } from "node:fs";
import { accountPaths, type CliInvocation, parseAccountPins } from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";
import type { AccountFs } from "./account-fs.js";
import {
  AccountInstallError,
  type InstallTexts,
  installAccount,
  installInvocation,
  postinstallInvocation,
  verifyLockfile,
} from "./install.js";
import { scriptedSpawner } from "./test-spawner.js";

const PINS = parseAccountPins(
  JSON.parse(
    readFileSync(new URL("../../../../../../os/models/accounts.json", import.meta.url), "utf8"),
  ),
);
const HOME = "/home/rafiq";
const TEXTS: InstallTexts = {
  downloading: (l) => `Downloading ${l}`,
  checking: (l) => `Checking ${l}`,
  finishing: (l) => `Finishing ${l}`,
  downloadFailed: (l) => `${l} download failed`,
  integrityFailed: (l) => `${l} integrity failed`,
  signaturesFailed: (l) => `${l} signatures failed`,
  setupFailed: (l) => `${l} setup failed`,
};

function lockFor(account: "claude" | "chatgpt" | "gemini" | "copilot", tamper = false): string {
  const pin = PINS[account];
  const packages: Record<string, unknown> = {
    "": { dependencies: { [pin.package]: pin.version } },
    [`node_modules/${pin.package}`]: {
      version: pin.version,
      integrity: tamper ? `sha512-${"A".repeat(86)}==` : pin.integrity,
    },
  };
  if (pin.platformPackage !== null) {
    packages[`node_modules/${pin.platformPackage.name}`] = {
      version: pin.platformPackage.version,
      integrity: pin.platformPackage.integrity,
      optional: true,
    };
  }
  return JSON.stringify({ name: "clis", lockfileVersion: 3, packages });
}

function memoryFs(files: Record<string, string>, removed: string[] = []): AccountFs {
  return {
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    exists: async (path) => path in files || path.endsWith("/claude.exe") || path.endsWith(".js"),
    makeDir: async () => {},
    removeTree: async (path) => {
      removed.push(path);
    },
  };
}

describe("installInvocation", () => {
  it("installs exactly the pinned version with scripts off, no user npmrc, into the account prefix", () => {
    const paths = accountPaths(HOME, "gemini");
    const inv = installInvocation(PINS.gemini, paths);
    expect(inv.argv.slice(0, 5)).toEqual([
      "/usr/lib/jarvis/node/bin/node",
      "/usr/lib/jarvis/node/lib/node_modules/npm/bin/npm-cli.js",
      "install",
      "--prefix",
      paths.cliDir,
    ]);
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        "@google/gemini-cli@0.62.0",
        "--ignore-scripts",
        "--save-exact",
        "--omit=dev",
        "--omit=optional",
        "--userconfig",
        "/dev/null",
        "--globalconfig",
        "/dev/null",
        "--registry",
        "https://registry.npmjs.org/",
      ]),
    );
    expect(inv.writable).toEqual([paths.cliDir, paths.tmpDir]);
    expect(inv.network).toBe(true);
    expect(installInvocation(PINS.claude, accountPaths(HOME, "claude")).argv).not.toContain(
      "--omit=optional",
    );
  });

  it("runs claude's own install.cjs offline, and nothing for the others", () => {
    const inv = postinstallInvocation(PINS.claude, accountPaths(HOME, "claude"));
    expect(inv?.argv).toEqual([
      "/usr/lib/jarvis/node/bin/node",
      "/home/rafiq/.local/share/jarvis/clis/claude/node_modules/@anthropic-ai/claude-code/install.cjs",
    ]);
    expect(inv?.network).toBe(false);
    expect(postinstallInvocation(PINS.chatgpt, accountPaths(HOME, "chatgpt"))).toBeNull();
  });
});

describe("verifyLockfile", () => {
  it("accepts the pinned package and platform package", () => {
    for (const account of ["claude", "chatgpt", "gemini", "copilot"] as const) {
      expect(verifyLockfile(PINS[account], lockFor(account))).toEqual([]);
    }
  });

  it("refuses a different integrity or a missing platform package", () => {
    expect(verifyLockfile(PINS.claude, lockFor("claude", true))).toEqual([
      "@anthropic-ai/claude-code: integrity differs from accounts.json",
    ]);
    const lock = JSON.parse(lockFor("copilot"));
    delete lock.packages["node_modules/@github/copilot-linux-x64"];
    expect(verifyLockfile(PINS.copilot, JSON.stringify(lock))).toEqual([
      "@github/copilot-linux-x64: missing from the lockfile",
    ]);
    expect(verifyLockfile(PINS.copilot, "not json")).toEqual(["package-lock.json does not parse"]);
  });
});

describe("installAccount", () => {
  it("downloads, checks integrity and signatures, then runs the postinstall", async () => {
    const paths = accountPaths(HOME, "claude");
    const seen: CliInvocation[] = [];
    const progress: string[] = [];
    await installAccount({
      pin: PINS.claude,
      paths,
      spawn: scriptedSpawner(
        { install: { exitCode: 0 }, audit: { exitCode: 0 }, postinstall: { exitCode: 0 } },
        seen,
      ),
      fs: memoryFs({ [`${paths.cliDir}/package-lock.json`]: lockFor("claude") }),
      progress: (m) => progress.push(m),
      texts: TEXTS,
      log: () => {},
    });
    expect(seen.map((inv) => inv.purpose)).toEqual(["install", "audit", "postinstall"]);
    expect(progress).toEqual(["Downloading Claude", "Checking Claude", "Finishing Claude"]);
  });

  it("removes the download and fails when integrity differs", async () => {
    const paths = accountPaths(HOME, "chatgpt");
    const removed: string[] = [];
    const seen: CliInvocation[] = [];
    const run = installAccount({
      pin: PINS.chatgpt,
      paths,
      spawn: scriptedSpawner({}, seen),
      fs: memoryFs({ [`${paths.cliDir}/package-lock.json`]: lockFor("chatgpt", true) }, removed),
      progress: () => {},
      texts: TEXTS,
      log: () => {},
    });
    await expect(run).rejects.toEqual(new AccountInstallError("ChatGPT integrity failed"));
    expect(removed.at(-1)).toBe(paths.cliDir);
    expect(seen.map((inv) => inv.purpose)).toEqual(["install"]);
  });

  it("fails when npm audit signatures fails", async () => {
    const paths = accountPaths(HOME, "copilot");
    await expect(
      installAccount({
        pin: PINS.copilot,
        paths,
        spawn: scriptedSpawner({
          audit: { exitCode: 1, lines: ["1 package has an invalid registry signature"] },
        }),
        fs: memoryFs({ [`${paths.cliDir}/package-lock.json`]: lockFor("copilot") }),
        progress: () => {},
        texts: TEXTS,
        log: () => {},
      }),
    ).rejects.toEqual(new AccountInstallError("GitHub Copilot signatures failed"));
  });

  it("fails when npm itself fails", async () => {
    const paths = accountPaths(HOME, "gemini");
    await expect(
      installAccount({
        pin: PINS.gemini,
        paths,
        spawn: scriptedSpawner({ install: { exitCode: 1, lines: ["npm error code ENOTFOUND"] } }),
        fs: memoryFs({}),
        progress: () => {},
        texts: TEXTS,
        log: () => {},
      }),
    ).rejects.toEqual(new AccountInstallError("Google download failed"));
  });
});
