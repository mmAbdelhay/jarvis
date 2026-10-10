import { readFileSync } from "node:fs";
import {
  createFailoverProvider,
  type ModelEvent,
  type ModelProvider,
  ProviderError,
} from "@jarvis/core";
import {
  accountPaths,
  type CliInvocation,
  type CliSpawner,
  parseAccountPins,
} from "@jarvis/platform/model";
import type { AccountStatePush } from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import type { AccountFs } from "./account-fs.js";
import { createAccountService } from "./service.js";
import { scriptedSpawner } from "./test-spawner.js";

const PINS_TEXT = readFileSync(
  new URL("../../../../../../os/models/accounts.json", import.meta.url),
  "utf8",
);
const PINS = parseAccountPins(JSON.parse(PINS_TEXT));
const HOME = "/home/r";

function memoryFs(files: Map<string, string>, removed: string[] = []): AccountFs {
  return {
    readText: async (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error("ENOENT");
      return t;
    },
    exists: async (p) => files.has(p),
    makeDir: async () => {},
    removeTree: async (p) => {
      removed.push(p);
      for (const key of [...files.keys()])
        if (key === p || key.startsWith(`${p}/`)) files.delete(key);
    },
  };
}

function installed(files: Map<string, string>, account: "claude" | "chatgpt", signedIn: boolean) {
  const paths = accountPaths(HOME, account);
  const pin = PINS[account];
  files.set(
    `${paths.cliDir}/node_modules/${pin.package}/package.json`,
    JSON.stringify({ version: pin.version }),
  );
  files.set(`${paths.cliDir}/node_modules/${pin.package}/${pin.bin}`, "");
  if (signedIn)
    files.set(
      `${paths.configDir}/${account === "claude" ? ".credentials.json" : "auth.json"}`,
      "{}",
    );
}

function service(
  files: Map<string, string>,
  options: {
    sandbox?: boolean;
    seen?: CliInvocation[];
    pushed?: AccountStatePush[];
    spawn?: CliSpawner;
  } = {},
) {
  return createAccountService({
    home: HOME,
    readPins: async () => PINS,
    spawn:
      options.spawn ??
      scriptedSpawner(
        { install: { exitCode: 0 }, audit: { exitCode: 0 }, postinstall: { exitCode: 0 } },
        options.seen,
      ),
    sandboxWorks: async () => options.sandbox ?? true,
    fs: memoryFs(files),
    readOpenUrl: async () => undefined,
    openBrowser: async () => {},
    push: (state) => options.pushed?.push(state),
    language: () => "en",
    randomBytes: (n) => new Uint8Array(n),
    log: () => {},
  });
}

async function drain(p: ModelProvider): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of p.chat({
    system: "s",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    signal: new AbortController().signal,
  }))
    out.push(e);
  return out;
}

describe("account service", () => {
  it("lists all four accounts from the files", async () => {
    const files = new Map<string, string>();
    installed(files, "chatgpt", true);
    const { accounts } = await service(files).status();
    expect(accounts.map((a) => [a.account, a.installed, a.signedIn])).toEqual([
      ["claude", false, false],
      ["chatgpt", true, true],
      ["gemini", false, false],
      ["copilot", false, false],
    ]);
  });

  it("installs in the background and pushes progress, then installed", async () => {
    const files = new Map<string, string>();
    const paths = accountPaths(HOME, "chatgpt");
    const pin = PINS.chatgpt;
    const lock = {
      packages: {
        [`node_modules/${pin.package}`]: { version: pin.version, integrity: pin.integrity },
        [`node_modules/${pin.platformPackage?.name}`]: {
          version: pin.platformPackage?.version,
          integrity: pin.platformPackage?.integrity,
        },
      },
    };
    const npm = scriptedSpawner({ install: { exitCode: 0 }, audit: { exitCode: 0 } });
    // "npm install" leaves the lockfile and the entry point behind, like the real one.
    const spawn: CliSpawner = async (inv) => {
      if (inv.purpose === "install") {
        files.set(`${paths.cliDir}/package-lock.json`, JSON.stringify(lock));
        files.set(`${paths.cliDir}/node_modules/@openai/codex/bin/codex.js`, "");
      }
      return npm(inv);
    };
    const pushed: AccountStatePush[] = [];
    expect(await service(files, { pushed, spawn }).install("chatgpt")).toBeNull();
    await vi.waitFor(() => expect(pushed.at(-1)?.phase).toBe("installed"));
    expect(pushed[0]).toEqual({
      account: "chatgpt",
      phase: "installing",
      message: "Downloading ChatGPT…",
    });
    expect(pushed.map((p) => p.phase)).toEqual(["installing", "installing", "installed"]);
    expect(pushed.at(-1)).toEqual({
      account: "chatgpt",
      phase: "installed",
      message: "ChatGPT is ready. Sign in next.",
    });
  });

  it("refuses to sign in before the CLI is installed", async () => {
    const pushed: AccountStatePush[] = [];
    expect(await service(new Map(), { pushed }).login("gemini")).toBeNull();
    expect(pushed).toEqual([
      { account: "gemini", phase: "failed", message: "Set up Google first." },
    ]);
  });

  it("fails closed when the sandbox does not apply", async () => {
    const pushed: AccountStatePush[] = [];
    const files = new Map<string, string>();
    installed(files, "claude", true);
    const svc = service(files, { sandbox: false, pushed });
    await svc.install("claude");
    expect(pushed.at(-1)?.phase).toBe("failed");
    await expect(drain(svc.provider({ account: "claude", model: "default" }))).rejects.toEqual(
      new ProviderError(
        "auth",
        "Signing in with an account needs the user sandbox (systemd-run --user), which is not working on this computer.",
      ),
    );
  });

  it("an uninstalled account provider fails with the install text and failover moves on", async () => {
    const account = service(new Map()).provider({ account: "claude", model: "default" });
    await expect(drain(account)).rejects.toEqual(
      new ProviderError(
        "auth",
        "Claude isn't set up on this computer yet. Open Settings → Model providers to sign in.",
      ),
    );
    const backup: ModelProvider = {
      async *chat() {
        yield { type: "text", delta: "backup here" };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      },
      probe: async () => ({ ok: true, supportsTools: true, models: [] }),
      listModels: async () => [],
      reachable: async () => ({ ok: true }),
    };
    const chain = createFailoverProvider({
      entries: [{ id: "claude", locality: "cloud", provider: account }],
      allowCloudFallback: false,
      backup: { id: "backup", locality: "local", provider: backup },
      timers: { setTimeout, clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) },
      onSwitch: () => {},
      language: () => "en",
    });
    chain.beginTurn();
    const events = await drain(chain);
    expect(events[0]).toEqual({ type: "text", delta: "backup here" });
  });

  it("signs out by deleting the config and temp dirs", async () => {
    const files = new Map<string, string>();
    installed(files, "chatgpt", true);
    const seen: CliInvocation[] = [];
    const svc = service(files, { seen });
    await svc.logout("chatgpt");
    expect(seen.map((s) => s.purpose)).toEqual(["logout"]);
    expect((await svc.status()).accounts[1]).toMatchObject({ signedIn: false, installed: true });
    await svc.uninstall("chatgpt");
    expect((await svc.status()).accounts[1]).toMatchObject({ installed: false });
  });
});

it("rejects simultaneous installs for the same account", async () => {
  const svc = service(new Map());
  const first = svc.install("claude");
  await expect(svc.install("claude")).rejects.toMatchObject({ code: "bad-request" });
  await first;
  await svc.shutdown();
});

it("does not spawn logout when the sandbox probe fails", async () => {
  const seen: CliInvocation[] = [];
  const pushed: AccountStatePush[] = [];
  const files = new Map<string, string>();
  installed(files, "claude", true);
  const paths = accountPaths(HOME, "claude");
  files.set(`${paths.tmpDir}/session`, "temporary data");
  const svc = service(files, { sandbox: false, seen, pushed });
  await svc.logout("claude");
  expect(seen).toEqual([]);
  expect(pushed.at(-1)).toMatchObject({ account: "claude", phase: "failed" });
  expect(files.has(`${paths.configDir}/.credentials.json`)).toBe(false);
  expect(files.has(`${paths.tmpDir}/session`)).toBe(false);
  expect((await svc.status()).accounts[0]).toMatchObject({ signedIn: false, installed: true });

  installed(files, "claude", true);
  files.set(`${paths.tmpDir}/session`, "temporary data");
  await svc.uninstall("claude");
  expect(seen).toEqual([]);
  expect(files.has(`${paths.configDir}/.credentials.json`)).toBe(false);
  expect(files.has(`${paths.tmpDir}/session`)).toBe(false);
  expect((await svc.status()).accounts[0]).toMatchObject({ signedIn: false, installed: false });
});
