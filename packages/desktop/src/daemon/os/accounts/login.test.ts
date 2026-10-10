import { readFileSync } from "node:fs";
import { accountPaths, type CliInvocation, parseAccountPins } from "@jarvis/platform/model";
import type { AccountStatePush, AccountStatus } from "@jarvis/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginManager, deviceCodeFrom, type LoginTexts, loginUrlFrom } from "./login.js";
import { scriptedSpawner } from "./test-spawner.js";

const PINS = parseAccountPins(
  JSON.parse(
    readFileSync(new URL("../../../../../../os/models/accounts.json", import.meta.url), "utf8"),
  ),
);
const TEXTS: LoginTexts = {
  timedOut: "Sign-in timed out",
  notFinished: (l) => `${l}: sign-in did not finish`,
  failed: (l) => `${l}: sign-in failed`,
  badUrl: (l) => `${l} asked to open an address Jarvis does not trust`,
};

describe("login URLs", () => {
  it("accepts only https on the account's own hosts", () => {
    expect(
      loginUrlFrom(
        "chatgpt",
        "navigate to: https://auth.openai.com/oauth/authorize?client_id=app_X&state=s",
      ),
    ).toBe("https://auth.openai.com/oauth/authorize?client_id=app_X&state=s");
    expect(loginUrlFrom("chatgpt", "http://auth.openai.com/oauth")).toBeUndefined();
    expect(loginUrlFrom("chatgpt", "https://auth.openai.com.evil.example/x")).toBeUndefined();
    expect(loginUrlFrom("claude", "https://user:pw@claude.ai/oauth")).toBeUndefined();
    expect(
      loginUrlFrom("claude", "\u001b[1mhttps://claude.ai/oauth/authorize?code=true\u001b[0m"),
    ).toBe("https://claude.ai/oauth/authorize?code=true");
    expect(
      loginUrlFrom(
        "gemini",
        "Otherwise navigate to:\n\nhttps://accounts.google.com/o/oauth2/v2/auth?x=1\n",
      ),
    ).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  });

  it("finds a Copilot device code", () => {
    expect(deviceCodeFrom("copilot", "enter code ABCD-12EF to continue")).toBe("ABCD-12EF");
    expect(deviceCodeFrom("chatgpt", "ABCD-12EF")).toBeUndefined();
  });
});

describe("createLoginManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function manager(
    spawn: ReturnType<typeof scriptedSpawner>,
    status: Partial<AccountStatus>,
    openUrl?: string,
  ) {
    const pushed: AccountStatePush[] = [];
    const opened: string[] = [];
    const login = createLoginManager({
      pins: PINS,
      paths: (account) => accountPaths("/home/r", account),
      spawn,
      readOpenUrl: async () => openUrl,
      openBrowser: async (url) => {
        opened.push(url);
      },
      push: (state) => pushed.push(state),
      status: async (account) => ({
        account,
        installed: true,
        version: "x",
        signedIn: false,
        identity: null,
        ...status,
      }),
      texts: TEXTS,
      log: () => {},
    });
    return { login, pushed, opened };
  }

  it("shows the URL, opens the browser once, then reports who signed in", async () => {
    const lines = [
      "Starting local login server on http://localhost:1455.",
      "If your browser did not open, navigate to this URL to authenticate:",
      "https://auth.openai.com/oauth/authorize?client_id=app_X&state=s",
      "https://auth.openai.com/oauth/authorize?client_id=app_X&state=s",
      "Successfully logged in",
    ];
    const { login, pushed, opened } = manager(scriptedSpawner({ login: { exitCode: 0, lines } }), {
      signedIn: true,
      identity: "omar@example.com",
    });
    await login.start("chatgpt");
    await vi.runAllTimersAsync();
    expect(pushed).toEqual([
      {
        account: "chatgpt",
        phase: "awaiting-browser",
        url: "https://auth.openai.com/oauth/authorize?client_id=app_X&state=s",
      },
      { account: "chatgpt", phase: "signed-in", identity: "omar@example.com" },
    ]);
    expect(opened).toEqual(["https://auth.openai.com/oauth/authorize?client_id=app_X&state=s"]);
  });

  function gated(killed: CliInvocation[]) {
    const inner = scriptedSpawner({ login: { exitCode: null, hang: true } }, [], killed);
    const releases: Array<() => void> = [];
    const spawn: ReturnType<typeof scriptedSpawner> = (inv) =>
      new Promise((resolve) => {
        releases.push(() => resolve(inner(inv)));
      });
    return { spawn, releases };
  }

  it("kills a login whose spawn was still pending when cancel arrived", async () => {
    const killed: CliInvocation[] = [];
    const { spawn, releases } = gated(killed);
    const { login, pushed } = manager(spawn, {});
    const started = login.start("claude");
    await vi.advanceTimersByTimeAsync(0); // spawn is now in flight
    await login.cancel("claude");
    releases[0]?.();
    await started;
    expect(killed).toHaveLength(1);
    expect(login.running("claude")).toBe(false);
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
    expect(pushed).toEqual([]);
  });

  it("a double start leaves only the second login running", async () => {
    const killed: CliInvocation[] = [];
    const { spawn, releases } = gated(killed);
    const { login } = manager(spawn, {});
    const first = login.start("claude");
    await vi.advanceTimersByTimeAsync(0); // first spawn in flight
    const second = login.start("claude");
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(2);
    releases[0]?.();
    releases[1]?.();
    await Promise.all([first, second]);
    expect(killed).toHaveLength(1);
    expect(login.running("claude")).toBe(true);
    await login.cancel("claude");
    expect(killed).toHaveLength(2);
  });

  it("uses the URL the browser shim wrote (Gemini)", async () => {
    const { login, pushed, opened } = manager(
      scriptedSpawner({ login: { exitCode: 0, hang: true } }),
      { signedIn: true, identity: "lina@gmail.com" },
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=g",
    );
    await login.start("gemini");
    await vi.advanceTimersByTimeAsync(600);
    expect(pushed[0]).toEqual({
      account: "gemini",
      phase: "awaiting-browser",
      url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=g",
    });
    expect(opened).toHaveLength(1);
  });

  it("never starts a new open-url read while one is still in flight", async () => {
    let reads = 0;
    const login = createLoginManager({
      pins: PINS,
      paths: (account) => accountPaths("/home/r", account),
      spawn: scriptedSpawner({ login: { exitCode: null, hang: true } }),
      readOpenUrl: () => {
        reads += 1;
        return new Promise<string | undefined>(() => {}); // a FIFO that never opens
      },
      openBrowser: async () => {},
      push: () => {},
      status: async (account) => ({
        account,
        installed: true,
        version: "x",
        signedIn: false,
        identity: null,
      }),
      texts: TEXTS,
      log: () => {},
    });
    await login.start("gemini");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toBe(1);
    await login.cancel("gemini");
  });

  it("never opens an address outside the allowlist", async () => {
    const killed: CliInvocation[] = [];
    const { login, pushed, opened } = manager(
      scriptedSpawner({ login: { exitCode: null, hang: true } }, [], killed),
      {},
      "https://evil.example/login",
    );
    await login.start("gemini");
    await vi.advanceTimersByTimeAsync(600);
    expect(killed).toHaveLength(1);
    expect(opened).toEqual([]);
    expect(pushed).toEqual([
      {
        account: "gemini",
        phase: "failed",
        message: "Google asked to open an address Jarvis does not trust",
      },
    ]);
  });

  it("waits for the device code before showing Copilot's page", async () => {
    const lines = [
      "To authenticate, visit https://github.com/login/device",
      "and enter code: WDJB-MJHT",
    ];
    const { login, pushed } = manager(scriptedSpawner({ login: { exitCode: 0, lines } }), {
      signedIn: true,
      identity: "octocat",
    });
    await login.start("copilot");
    await vi.runAllTimersAsync();
    expect(pushed[0]).toEqual({
      account: "copilot",
      phase: "awaiting-browser",
      url: "https://github.com/login/device",
      code: "WDJB-MJHT",
    });
  });

  it("fails the login after 10 minutes and stops the unit", async () => {
    const killed: CliInvocation[] = [];
    const { login, pushed } = manager(
      scriptedSpawner({ login: { exitCode: null, hang: true } }, [], killed),
      {},
    );
    await login.start("claude");
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.runAllTimersAsync();
    expect(killed).toHaveLength(1);
    expect(pushed.at(-1)).toEqual({
      account: "claude",
      phase: "failed",
      message: "Sign-in timed out",
    });
    expect(login.running("claude")).toBe(false);
  });

  it("a second account:login cancels the first", async () => {
    const killed: CliInvocation[] = [];
    const seen: CliInvocation[] = [];
    const { login, pushed } = manager(
      scriptedSpawner({ login: { exitCode: null, hang: true } }, seen, killed),
      {},
    );
    await login.start("claude");
    await login.start("claude");
    await vi.advanceTimersByTimeAsync(1000); // not runOnlyPending: that would fire the 10-minute timeout
    expect(seen).toHaveLength(2);
    expect(killed).toEqual([seen[0]]);
    expect(pushed.filter((p) => p.phase === "failed")).toEqual([]);
    expect(login.running("claude")).toBe(true);
  });

  it("reports a CLI that exits without signing in", async () => {
    const { login, pushed } = manager(scriptedSpawner({ login: { exitCode: 0 } }), {
      signedIn: false,
    });
    await login.start("chatgpt");
    await vi.runAllTimersAsync();
    expect(pushed).toEqual([
      { account: "chatgpt", phase: "failed", message: "ChatGPT: sign-in did not finish" },
    ]);
  });
});
