import { describe, expect, it, vi } from "vitest";
import type { ControlClient } from "../../desktop/src/daemon/control/client.js";
import { accountCommand } from "./account.js";
import { main } from "./main.js";
import type { Terminal } from "./terminal.js";

function fakeTerm() {
  const out: string[] = [];
  const term = { write: (s: string) => out.push(s), interactive: false, readLine: async () => null } as unknown as Terminal;
  return { term, out };
}

function fakeClient(answers: Record<string, unknown>, pushes: [string, unknown][] = []) {
  const invoked: [string, unknown[]][] = [];
  let listener: ((ch: string, p: unknown) => void) | undefined;
  const client = {
    invoke: async (ch: string, args: unknown[]) => {
      invoked.push([ch, args]);
      setTimeout(() => {
        for (const [c, p] of pushes) listener?.(c, p);
      }, 0);
      return answers[ch] ?? null;
    },
    onPush: (l: (ch: string, p: unknown) => void) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    onClose: () => () => {},
  } as unknown as ControlClient;
  return { client, invoked };
}

describe("jarvis account", () => {
  it("dispatches through main and closes the client", async () => {
    const { term } = fakeTerm();
    const { client, invoked } = fakeClient({ "account:status": { accounts: [] } });
    const close = vi.fn();
    Object.assign(client, { close });
    expect(await main(["account"], { term, env: {}, connect: async () => client, readStdin: async () => "" })).toBe(0);
    expect(invoked).toEqual([["account:status", []]]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("ignores malformed and unrelated pushes, including synchronous completion", async () => {
    let listener: ((channel: string, payload: unknown) => void) | undefined;
    const client = {
      onPush: (fn: typeof listener) => { listener = fn; return () => { listener = undefined; }; },
      onClose: () => () => {},
      invoke: async () => {
        listener?.("other:state", { account: "claude", phase: "failed" });
        listener?.("account:state", { account: "gemini", phase: "failed" });
        listener?.("account:state", { account: "claude", phase: "failed", message: 123 });
        listener?.("account:state", { account: "claude", phase: "signed-in", identity: "Sara" });
        return null;
      },
    } as unknown as ControlClient;
    const { term, out } = fakeTerm();
    expect(await accountCommand(client, term, "login", "claude")).toBe(0);
    expect(out.join("")).toBe("Signed in as Sara.\n");
    expect(listener).toBeUndefined();
  });

  it("times out and releases both subscriptions", async () => {
    vi.useFakeTimers();
    try {
      let subscriptions = 0;
      const subscribe = () => { subscriptions++; return () => { subscriptions--; }; };
      const client = { invoke: async () => null, onPush: subscribe, onClose: subscribe } as unknown as ControlClient;
      const result = expect(accountCommand(client, fakeTerm().term, "install", "claude")).rejects.toThrow("Timed out waiting for Jarvis.");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await result;
      expect(subscriptions).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs and reports completion", async () => {
    const { term, out } = fakeTerm();
    const { client, invoked } = fakeClient({}, [
      ["account:state", { account: "claude", phase: "installing", message: "Installing Claude." }],
      ["account:state", { account: "claude", phase: "installed", message: "Installed." }],
    ]);
    expect(await accountCommand(client, term, "install", "claude")).toBe(0);
    expect(invoked).toEqual([["account:install", [{ account: "claude" }]]]);
    expect(out.join("")).toBe("Installing Claude.\nInstalled.\n");
  });

  it("uses logout and uninstall channels", async () => {
    for (const action of ["logout", "remove"] as const) {
      const { term } = fakeTerm();
      const { client, invoked } = fakeClient({});
      expect(await accountCommand(client, term, action, "chatgpt")).toBe(0);
      expect(invoked).toEqual([[action === "logout" ? "account:logout" : "account:uninstall", [{ account: "chatgpt" }]]]);
    }
  });

  it("cleans up subscriptions when invocation fails", async () => {
    let subscriptions = 0;
    const client = {
      invoke: async () => { throw new Error("Unavailable"); },
      onPush: () => { subscriptions++; return () => { subscriptions--; }; },
      onClose: () => { subscriptions++; return () => { subscriptions--; }; },
    } as unknown as ControlClient;
    await expect(accountCommand(client, fakeTerm().term, "login", "claude")).rejects.toThrow("Unavailable");
    expect(subscriptions).toBe(0);
  });

  it("stops waiting when the connection closes", async () => {
    let close: (() => void) | undefined;
    const client = {
      invoke: async () => { close?.(); return null; },
      onPush: () => () => {},
      onClose: (listener: () => void) => { close = listener; return () => { close = undefined; }; },
    } as unknown as ControlClient;
    await expect(accountCommand(client, fakeTerm().term, "login", "claude")).rejects.toThrow("Connection to Jarvis closed.");
    expect(close).toBeUndefined();
  });

  it("prints each account's state", async () => {
    const { term, out } = fakeTerm();
    const { client } = fakeClient({
      "account:status": {
        accounts: [
          { account: "claude", installed: true, version: "2.1.280", signedIn: true, identity: "sara@example.com" },
          { account: "chatgpt", installed: false, version: null, signedIn: false, identity: null },
        ],
      },
    });
    expect(await accountCommand(client, term, "status")).toBe(0);
    expect(out.join("")).toBe("Claude          signed in as sara@example.com\nChatGPT         not set up\n");
  });

  it("signs in: prints the address and code, waits for the result", async () => {
    const { term, out } = fakeTerm();
    const { client, invoked } = fakeClient({}, [
      ["account:state", { account: "copilot", phase: "awaiting-browser", url: "https://github.com/login/device", code: "WDJB-MJHT" }],
      ["account:state", { account: "copilot", phase: "signed-in", identity: "octocat" }],
    ]);
    expect(await accountCommand(client, term, "login", "copilot")).toBe(0);
    expect(invoked).toEqual([["account:login", [{ account: "copilot" }]]]);
    expect(out.join("")).toContain("Open https://github.com/login/device in your browser and enter the code WDJB-MJHT.");
    expect(out.join("")).toContain("Signed in as octocat.");
  });

  it("returns 1 when sign-in fails", async () => {
    const { term, out } = fakeTerm();
    const { client } = fakeClient({}, [["account:state", { account: "gemini", phase: "failed", message: "Set up Google first." }]]);
    expect(await accountCommand(client, term, "login", "gemini")).toBe(1);
    expect(out.join("")).toContain("Set up Google first.");
  });
});
