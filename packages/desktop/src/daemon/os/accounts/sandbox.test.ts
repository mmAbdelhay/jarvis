import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { promisify } from "node:util";
import {
  accountPaths,
  loginInvocation,
  parseAccountPins,
  turnInvocation,
} from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";
import { accountSandboxArgv, accountSandboxProbe, accountUnitName } from "./sandbox.js";

const PINS = parseAccountPins(
  JSON.parse(
    readFileSync(new URL("../../../../../../os/models/accounts.json", import.meta.url), "utf8"),
  ),
);
const HOME = "/home/rafiq";
const RT = "/run/user/1000";
const prop = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === "-p" ? [a] : []));

describe("account sandbox argv", () => {
  const paths = accountPaths(HOME, "gemini");
  const inv = turnInvocation(PINS.gemini, paths, "default", { text: "hello" });
  const argv = accountSandboxArgv(inv, {
    home: HOME,
    runtimeDir: RT,
    unit: "jarvis-account-gemini-0a1b2c3d",
  });

  it("is a transient user service with a pipe and the unit name", () => {
    expect(argv.slice(0, 6)).toEqual([
      "systemd-run",
      "--user",
      "--pipe",
      "--quiet",
      "--collect",
      "--unit=jarvis-account-gemini-0a1b2c3d",
    ]);
    expect(argv).toContain(`--working-directory=${paths.tmpDir}`);
  });

  it("hides $HOME except the account's own dirs, and every bus", () => {
    const props = prop(argv);
    expect(props).toEqual(
      expect.arrayContaining([
        "NoNewPrivileges=yes",
        "PrivateNetwork=no",
        "ProtectHome=tmpfs",
        "PrivateTmp=yes",
        "ProtectSystem=strict",
        `BindPaths=${paths.configDir}`,
        `BindPaths=${paths.tmpDir}`,
        `BindReadOnlyPaths=${paths.cliDir}`,
        "InaccessiblePaths=-/home/rafiq/.ssh",
        "InaccessiblePaths=-/home/rafiq/.gnupg",
        "InaccessiblePaths=-/home/rafiq/.local/share/keyrings",
        "InaccessiblePaths=-/home/rafiq/.config/jarvis/accounts/claude",
        "InaccessiblePaths=-/home/rafiq/.config/jarvis/accounts/chatgpt",
        "InaccessiblePaths=-/home/rafiq/.config/jarvis/accounts/copilot",
        "InaccessiblePaths=-/run/user/1000",
        "InaccessiblePaths=-/run/dbus/system_bus_socket",
      ]),
    );
    expect(props).not.toContain("InaccessiblePaths=-/home/rafiq/.config/jarvis/accounts/gemini");
    expect(props.some((p) => p.startsWith("RuntimeMaxSec="))).toBe(true);
  });

  it("starts the CLI with env -i and only the invocation's environment", () => {
    const at = argv.indexOf("--");
    expect(argv.slice(at + 1, at + 3)).toEqual(["/usr/bin/env", "-i"]);
    const pairs = argv.slice(at + 3).filter((a) => /^[A-Z_][A-Z0-9_]*=/.test(a));
    expect(pairs.map((p) => p.split("=")[0]).sort()).toEqual(Object.keys(inv.env).sort());
    expect(argv.slice(-inv.argv.length)).toEqual(inv.argv);
  });

  it("turns the network off when the invocation needs none", () => {
    expect(
      prop(
        accountSandboxArgv({ ...inv, network: false }, { home: HOME, runtimeDir: RT, unit: "u" }),
      ),
    ).toContain("PrivateNetwork=yes");
  });

  it("wraps a login that needs a terminal in script(1), refusing odd words", () => {
    const login = loginInvocation(PINS.claude, accountPaths(HOME, "claude"));
    const wrapped = accountSandboxArgv(login, { home: HOME, runtimeDir: RT, unit: "u" });
    expect(wrapped.slice(-7)).toEqual([
      "/usr/bin/script",
      "-q",
      "-e",
      "-f",
      "-c",
      login.argv.join(" "),
      "/dev/null",
    ]);
    expect(() =>
      accountSandboxArgv(
        { ...login, argv: [...login.argv, "a;b"] },
        { home: HOME, runtimeDir: RT, unit: "u" },
      ),
    ).toThrow(/terminal/);
  });

  it("refuses env values and paths that systemd or env could misread", () => {
    expect(() =>
      accountSandboxArgv(
        { ...inv, env: { ...inv.env, X: "a\nb" } },
        { home: HOME, runtimeDir: RT, unit: "u" },
      ),
    ).toThrow(/environment/);
    expect(() =>
      accountSandboxArgv(
        { ...inv, writable: ["/home/rafiq/My Files"] },
        { home: HOME, runtimeDir: RT, unit: "u" },
      ),
    ).toThrow(/path/);
  });

  it("names units with the account and 8 hex digits", () => {
    expect(accountUnitName("copilot", () => "deadbeef")).toBe("jarvis-account-copilot-deadbeef");
    expect(() => accountUnitName("copilot", () => "x;y")).toThrow();
  });
});

// Linux box only: the sandbox really applies (Global Constraints: fails closed).
describe.runIf(process.env["JARVIS_SANDBOX_TESTS"] === "1")(
  "account sandbox on this machine",
  () => {
    it("passes the probe", async () => {
      const home = homedir();
      const paths = accountPaths(home, "claude");
      for (const dir of [paths.configDir, paths.cliDir, paths.tmpDir])
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      const runtimeDir = process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${userInfo().uid}`;
      const [cmd, ...args] = accountSandboxProbe(
        home,
        runtimeDir,
        paths,
        `jarvis-account-probe-${process.pid}`,
      );
      await expect(promisify(execFile)(cmd as string, args)).resolves.toBeDefined();
    });
  },
);
