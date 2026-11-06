import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createTailnetGuard,
  disableRelay,
  enableRelay,
  existingForward,
  funnelExposes,
  relayConfirmed,
  restoreForward,
  type TailnetGuardDeps,
} from "./tailnet-guard.js";
import type { TailscaleCertDeps } from "./tailscale-cert.js";

// `tailscale serve status --json` from a real machine, host replaced: Funnel
// on 443 to port 8765, plain TCP forwards on 7717/7718, and one forward with
// PROXY on an unused port.
const REAL: unknown = JSON.parse(
  readFileSync(new URL("./tailnet-guard.fixture.json", import.meta.url), "utf8"),
);
// Hand-built, not captured: the shape upstream's `ipn/serve.go` stores for a
// plain `tailscale funnel 7717`, whose config lives under `Foreground`.
const FOREGROUND: unknown = JSON.parse(
  readFileSync(
    new URL("./tailnet-guard.foreground.hand-built.fixture.json", import.meta.url),
    "utf8",
  ),
);

const PORTS = [7717, 7718];
const HOST = "machine.tailnet.ts.net";
const BIND = "100.84.17.203";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 6);
const CERT_DIR = join("/Users/x", ".config", "jarvis", "tls");
const CERT_PATH = join(CERT_DIR, `${HOST}.crt`);
const KEY_PATH = join(CERT_DIR, `${HOST}.key`);

/** A forward on each port the way an enable leaves it. */
const RELAYED = {
  TCP: {
    "7717": { TCPForward: "127.0.0.1:7717", ProxyProtocol: 2 },
    "7718": { TCPForward: "127.0.0.1:7718", ProxyProtocol: 2 },
  },
};
const FUNNEL_TCP = {
  AllowFunnel: { [`${HOST}:443`]: true },
  TCP: { "443": { TCPForward: "127.0.0.1:7717" } },
};

const webFunnel = (proxy: unknown, allowed = true): unknown => ({
  AllowFunnel: { [`${HOST}:443`]: allowed },
  Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: proxy } } } },
});

describe("funnelExposes", () => {
  it("today's real shape is not exposed", () => {
    expect(funnelExposes(REAL, PORTS)).toBe(false);
  });

  it("reads the real shape's Funnel proxy", () => {
    expect(funnelExposes(REAL, [8765])).toBe(true);
  });

  it.each([
    "http://127.0.0.1:7717",
    "https://localhost:7717",
    "https+insecure://127.0.0.1:7717",
    "http://127.0.0.1:7717/some/path",
    "127.0.0.1:7717",
    "localhost:7717",
    "[::1]:7717",
    "http://[::1]:7717",
    "7717",
  ])("a Web proxy to %s on a Funnel host is exposed", (target) => {
    expect(funnelExposes(webFunnel(target), PORTS)).toBe(true);
  });

  it("a scheme's default port is still its port", () => {
    expect(funnelExposes(webFunnel("https://127.0.0.1:443"), [443])).toBe(true);
    expect(funnelExposes(webFunnel("http://127.0.0.1:80"), [80])).toBe(true);
  });

  it.each([
    "http://127.0.0.1",
    "http://7717",
    "127.0.0.1",
    "localhost",
    "http://127.0.0.1:8765",
    "http://127.0.0.1:77170",
    "/var/www/7717",
    "",
    7717,
    undefined,
  ])("a Web proxy to %s is not exposed", (target) => {
    expect(funnelExposes(webFunnel(target), PORTS)).toBe(false);
  });

  it("checks every handler of the host", () => {
    const status = {
      AllowFunnel: { [`${HOST}:443`]: true },
      Web: {
        [`${HOST}:443`]: {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8765" }, "/x": { Proxy: "7718" } },
        },
      },
    };
    expect(funnelExposes(status, PORTS)).toBe(true);
  });

  it("a TCP forward on an allowed Funnel port is exposed", () => {
    expect(funnelExposes(FUNNEL_TCP, PORTS)).toBe(true);
  });

  it("a Web proxy or TCP forward with Funnel not allowed is not exposed", () => {
    expect(funnelExposes(webFunnel("7717", false), PORTS)).toBe(false);
    expect(
      funnelExposes(
        {
          AllowFunnel: { "other.ts.net:443": true },
          Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "7717" } } } },
        },
        PORTS,
      ),
    ).toBe(false);
  });

  it.each([
    [null],
    [undefined],
    [7],
    ["text"],
    [[]],
    [{}],
    [{ AllowFunnel: 5 }],
    [{ AllowFunnel: [] }],
    [{ AllowFunnel: { "no-port": true } }],
    [{ AllowFunnel: { [`${HOST}:443`]: true }, TCP: "x", Web: 3 }],
    [{ AllowFunnel: { [`${HOST}:443`]: true }, TCP: { "443": 1 } }],
    [{ AllowFunnel: { [`${HOST}:443`]: true }, Web: { [`${HOST}:443`]: { Handlers: [1] } } }],
    [
      {
        AllowFunnel: { [`${HOST}:443`]: true },
        Web: { [`${HOST}:443`]: { Handlers: { "/": 1 } } },
      },
    ],
    [{ Foreground: 3 }],
    [{ Foreground: [] }],
    [{ Foreground: { s: 1, t: null, u: { AllowFunnel: 2, TCP: 3, Web: 4 } } }],
  ])("an unknown shape is not exposed and never throws: %j", (status) => {
    expect(funnelExposes(status, PORTS)).toBe(false);
  });

  describe("foreground config", () => {
    const allow = { [`${HOST}:443`]: true };
    const web = { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "7717" } } } };
    const tcp = { "443": { TCPForward: "127.0.0.1:7717" } };

    it("plain `tailscale funnel 7717` is exposed", () => {
      expect(funnelExposes(FOREGROUND, PORTS)).toBe(true);
    });

    it("a foreground Funnel to another port is not exposed", () => {
      expect(funnelExposes(FOREGROUND, [8765])).toBe(false);
    });

    it("any session counts", () => {
      const status = {
        Foreground: { a: {}, b: { AllowFunnel: allow, TCP: tcp } },
      };
      expect(funnelExposes(status, PORTS)).toBe(true);
    });

    it("allowed at the top, handler in a session, is exposed", () => {
      expect(funnelExposes({ AllowFunnel: allow, Foreground: { s: { Web: web } } }, PORTS)).toBe(
        true,
      );
      expect(funnelExposes({ AllowFunnel: allow, Foreground: { s: { TCP: tcp } } }, PORTS)).toBe(
        true,
      );
    });

    it("allowed in a session, handler at the top, is exposed", () => {
      expect(funnelExposes({ Web: web, Foreground: { s: { AllowFunnel: allow } } }, PORTS)).toBe(
        true,
      );
      expect(funnelExposes({ TCP: tcp, Foreground: { s: { AllowFunnel: allow } } }, PORTS)).toBe(
        true,
      );
    });

    it("allowed in one session, handler in another, is exposed", () => {
      const status = { Foreground: { a: { AllowFunnel: allow }, b: { Web: web } } };
      expect(funnelExposes(status, PORTS)).toBe(true);
    });

    it("a foreground handler that no level allows is not exposed", () => {
      expect(funnelExposes({ Foreground: { s: { Web: web, TCP: tcp } } }, PORTS)).toBe(false);
      expect(
        funnelExposes(
          { Foreground: { s: { Web: web, AllowFunnel: { [`${HOST}:443`]: false } } } },
          PORTS,
        ),
      ).toBe(false);
    });
  });
});

describe("relayConfirmed", () => {
  it("a forward with PROXY on each port is confirmed", () => {
    expect(relayConfirmed(RELAYED, PORTS)).toBe(true);
    expect(relayConfirmed(REAL, [17717])).toBe(true);
  });

  it("a forward without PROXY is not confirmed, so a manual rule gets replaced", () => {
    expect(relayConfirmed(REAL, PORTS)).toBe(false);
  });

  it("a forward that ends with a CLI session is not confirmed", () => {
    expect(relayConfirmed({ Foreground: { s: RELAYED } }, PORTS)).toBe(false);
  });

  it("every port has to be confirmed", () => {
    const one = { TCP: { "7717": RELAYED.TCP["7717"] } };
    expect(relayConfirmed(one, PORTS)).toBe(false);
  });

  it.each([
    ["another target", { TCPForward: "127.0.0.1:9999", ProxyProtocol: 2 }],
    ["another host", { TCPForward: "10.0.0.1:7717", ProxyProtocol: 2 }],
    ["another PROXY version", { TCPForward: "127.0.0.1:7717", ProxyProtocol: 1 }],
    ["a string PROXY version", { TCPForward: "127.0.0.1:7717", ProxyProtocol: "2" }],
  ])("%s is not confirmed", (_name, entry) => {
    expect(relayConfirmed({ TCP: { "7717": entry } }, [7717])).toBe(false);
  });

  it.each([[null], [3], [[]], [{}], [{ TCP: 3 }], [{ TCP: { "7717": 1 } }]])(
    "an unknown shape is not confirmed and never throws: %j",
    (status) => {
      expect(relayConfirmed(status, [7717])).toBe(false);
    },
  );
});

function cliDeps(
  answer: (args: string[]) => { code: number; stdout: string; stderr: string } = () => ({
    code: 0,
    stdout: "",
    stderr: "",
  }),
  overrides: Partial<TailscaleCertDeps> = {},
) {
  const exec = vi.fn(async (_command: string, args: string[]) => answer(args));
  const deps: TailscaleCertDeps = {
    exec,
    fs: {
      access: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
    },
    homedir: () => "/Users/x",
    platform: "linux",
    ...overrides,
  };
  const serveCalls = () => exec.mock.calls.map(([, args]) => args).filter((a) => a[0] === "serve");
  return { deps, exec, serveCalls };
}

const refused = { code: 1, stdout: "", stderr: "Access denied" };
const fine = { code: 0, stdout: "", stderr: "" };

describe("existingForward", () => {
  it("reads a real machine's plain forward", () => {
    expect(existingForward(REAL, 7717)).toEqual({ target: "127.0.0.1:7717" });
    expect(existingForward(REAL, 7718)).toEqual({ target: "127.0.0.1:7718" });
  });

  it("keeps a forward's PROXY version and its TLS termination", () => {
    const status = {
      TCP: {
        "7717": { TCPForward: "127.0.0.1:7717", ProxyProtocol: 1 },
        "7718": { TCPForward: "localhost:9000", TerminateTLS: "m.ts.net" },
      },
    };
    expect(existingForward(status, 7717)).toEqual({
      target: "127.0.0.1:7717",
      proxyProtocol: 1,
    });
    expect(existingForward(status, 7718)).toEqual({
      target: "localhost:9000",
      terminateTls: true,
    });
  });

  it.each([
    ["no status", undefined],
    ["no TCP", {}],
    ["another port", { TCP: { "443": { TCPForward: "127.0.0.1:443" } } }],
    ["a web entry", { TCP: { "7717": { HTTPS: true } } }],
    ["a foreground forward", { Foreground: { a: { TCP: { "7717": { TCPForward: "x:1" } } } } }],
  ])("%s is no forward", (_name, status) => {
    expect(existingForward(status, 7717)).toBeUndefined();
  });
});

describe("restoreForward", () => {
  it.each([
    [
      "plain",
      { target: "127.0.0.1:7717" },
      ["serve", "--bg", "--tcp=7717", "tcp://127.0.0.1:7717"],
    ],
    [
      "with its PROXY version",
      { target: "127.0.0.1:7717", proxyProtocol: 1 },
      ["serve", "--bg", "--tcp=7717", "--proxy-protocol=1", "tcp://127.0.0.1:7717"],
    ],
    [
      "terminating TLS",
      { target: "localhost:9000", terminateTls: true },
      ["serve", "--bg", "--tls-terminated-tcp=7717", "tcp://localhost:9000"],
    ],
  ])("runs the exact command: %s", async (_name, forward, args) => {
    const { deps, serveCalls } = cliDeps();
    expect(await restoreForward(deps, 7717, forward)).toEqual({ ok: true });
    expect(serveCalls()).toEqual([args]);
  });

  it("a refusal returns the exact command", async () => {
    const { deps } = cliDeps(() => refused);
    expect(await restoreForward(deps, 7717, { target: "127.0.0.1:7717" })).toEqual({
      ok: false,
      command: "tailscale serve --bg --tcp=7717 tcp://127.0.0.1:7717",
    });
  });
});

describe("enableRelay", () => {
  it("runs the exact command for each port", async () => {
    const { deps, serveCalls } = cliDeps();
    expect(await enableRelay(deps, PORTS)).toEqual({ ok: true });
    expect(serveCalls()).toEqual([
      ["serve", "--bg", "--tcp=7717", "--proxy-protocol=2", "tcp://127.0.0.1:7717"],
      ["serve", "--bg", "--tcp=7718", "--proxy-protocol=2", "tcp://127.0.0.1:7718"],
    ]);
  });

  it("a refused enable returns the exact command for the port that failed", async () => {
    const { deps } = cliDeps((args) => (args.includes("--tcp=7718") ? refused : fine));
    expect(await enableRelay(deps, PORTS)).toEqual({
      ok: false,
      command: "tailscale serve --bg --tcp=7718 --proxy-protocol=2 tcp://127.0.0.1:7718",
    });
  });

  it("an exec that rejects returns the command too", async () => {
    const { deps, exec } = cliDeps();
    exec.mockImplementation(async (_command, args) => {
      if (args[0] === "serve") throw new Error("timed out");
      return fine;
    });
    expect(await enableRelay(deps, [7717])).toEqual({
      ok: false,
      command: "tailscale serve --bg --tcp=7717 --proxy-protocol=2 tcp://127.0.0.1:7717",
    });
  });

  it("with no CLI returns the command of the first port and runs nothing", async () => {
    const { deps, serveCalls } = cliDeps(() => refused);
    expect(await enableRelay(deps, PORTS)).toEqual({
      ok: false,
      command: "tailscale serve --bg --tcp=7717 --proxy-protocol=2 tcp://127.0.0.1:7717",
    });
    expect(serveCalls()).toEqual([]);
  });

  it("the command names `tailscale` even where the CLI has a full path", async () => {
    const { deps, exec } = cliDeps(() => refused, { platform: "darwin" });
    const result = await enableRelay(deps, [7717]);
    expect(exec.mock.calls[0]?.[0]).toMatch(/Tailscale\.app/);
    expect(result).toEqual({
      ok: false,
      command: "tailscale serve --bg --tcp=7717 --proxy-protocol=2 tcp://127.0.0.1:7717",
    });
  });
});

describe("disableRelay", () => {
  it("removes only the given ports", async () => {
    const { deps, serveCalls } = cliDeps();
    expect(await disableRelay(deps, PORTS)).toEqual({ ok: true });
    expect(serveCalls()).toEqual([
      ["serve", "--tcp=7717", "off"],
      ["serve", "--tcp=7718", "off"],
    ]);
  });

  it("still tries the other port, and returns the line that failed", async () => {
    const { deps, serveCalls } = cliDeps((args) => (args.includes("--tcp=7717") ? refused : fine));
    expect(await disableRelay(deps, PORTS)).toEqual({
      ok: false,
      command: "tailscale serve --tcp=7717 off",
    });
    expect(serveCalls()).toHaveLength(2);
  });
});

function harness(initial: Partial<HarnessState> = {}) {
  const state: HarnessState = {
    now: NOW,
    enabled: true,
    relay: false,
    bindAddress: BIND,
    tailscaleIps: [BIND, "fd7a:115c:a1e0::1"],
    unverified: false,
    connected: 0,
    notAfter: NOW + 60 * DAY,
    serve: { code: 0, stdout: "{}", stderr: "" },
    cli: true,
    certCode: 0,
    renewedNotAfter: NOW + 90 * DAY,
    certPath: CERT_PATH,
    keyPath: KEY_PATH,
    ...initial,
  };
  const exec = vi.fn(async (_command: string, args: string[]) => {
    switch (args[0]) {
      case "version":
        return state.cli ? fine : refused;
      case "serve":
        if (state.serve instanceof Error) throw state.serve;
        return state.serve;
      case "status":
        if (state.tailscaleIps === undefined) return refused;
        return {
          code: 0,
          stdout: JSON.stringify({
            Self: { DNSName: `${HOST}.`, TailscaleIPs: state.tailscaleIps },
          }),
          stderr: "",
        };
      case "cert":
        if (state.certCode === 0) state.notAfter = state.renewedNotAfter;
        return { code: state.certCode, stdout: "", stderr: state.certCode === 0 ? "" : "no" };
      default:
        throw new Error(`unexpected command ${args.join(" ")}`);
    }
  });
  const armed: { callback: () => void; ms: number }[] = [];
  const setTailnetBlock = vi.fn(async (_reason: unknown) => {
    state.unverified = false;
    return true;
  });
  const readFailed = vi.fn(async () => {});
  const retryListener = vi.fn(async () => {});
  const reloadCertificate = vi.fn(async () => {});
  const log = vi.fn();
  const certificateExpiry = vi.fn(async () => state.notAfter);
  const deps: TailnetGuardDeps = {
    tailscale: {
      exec,
      fs: {
        access: vi.fn(async () => undefined),
        mkdir: vi.fn(async () => undefined),
        chmod: vi.fn(async () => undefined),
      },
      homedir: () => "/Users/x",
      platform: "linux",
    },
    enabled: () => state.enabled,
    relay: () => state.relay,
    bindAddress: () => state.bindAddress,
    ports: () => PORTS,
    setTailnetBlock,
    unverified: () => state.unverified,
    readFailed,
    retryListener,
    reloadCertificate,
    connectedDevices: () => state.connected,
    certificate: () => ({
      ...(state.certPath !== undefined ? { certPath: state.certPath } : {}),
      ...(state.keyPath !== undefined ? { keyPath: state.keyPath } : {}),
    }),
    certificateExpiry,
    timers: {
      setTimeout: (callback, ms) => {
        const entry = { callback, ms };
        armed.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        const at = armed.indexOf(handle as (typeof armed)[number]);
        if (at !== -1) armed.splice(at, 1);
      },
    },
    now: () => state.now,
    log,
  };
  const guard = createTailnetGuard(deps);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    state,
    guard,
    deps,
    exec,
    armed,
    setTailnetBlock,
    readFailed,
    retryListener,
    reloadCertificate,
    log,
    certificateExpiry,
    flush,
    /** Starts the guard and lets its first poll finish. */
    start: async () => {
      guard.start();
      await flush();
    },
    /** Fires the armed timer and lets that poll finish. */
    poll: async () => {
      const entry = armed.shift();
      if (entry === undefined) throw new Error("no timer armed");
      entry.callback();
      await flush();
    },
    calls: (command: string) => exec.mock.calls.filter(([, args]) => args[0] === command),
  };
}

type HarnessState = {
  now: number;
  enabled: boolean;
  relay: boolean;
  bindAddress: string;
  /** `Self.TailscaleIPs`; undefined makes that read fail. */
  tailscaleIps: string[] | undefined;
  /** What the bridge reports: no verdict it trusts. */
  unverified: boolean;
  connected: number;
  notAfter: number;
  serve: { code: number; stdout: string; stderr: string } | Error;
  cli: boolean;
  certCode: number;
  /** What the file's expiry becomes when `cert` exits 0. */
  renewedNotAfter: number;
  certPath: string | undefined;
  keyPath: string | undefined;
};

const serving = (status: unknown) => ({ code: 0, stdout: JSON.stringify(status), stderr: "" });

describe("createTailnetGuard: verdicts", () => {
  it("polls at once and then every 60 seconds", async () => {
    const h = harness();
    await h.start();
    expect(h.calls("serve")).toEqual([
      ["tailscale", ["serve", "status", "--json"], expect.anything()],
    ]);
    expect(h.armed.map((timer) => timer.ms)).toEqual([60_000]);
    await h.poll();
    expect(h.calls("serve")).toHaveLength(2);
    expect(h.armed.map((timer) => timer.ms)).toEqual([60_000]);
  });

  it("an exposed poll calls setTailnetBlock('funnel')", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    await h.start();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"]]);
  });

  it("the real shape, with relay off, clears", async () => {
    const h = harness({ serve: serving(REAL) });
    await h.start();
    expect(h.setTailnetBlock.mock.calls).toEqual([[undefined]]);
  });

  it("sends only a changed verdict", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    await h.start();
    await h.poll();
    await h.poll();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"]]);

    h.state.serve = serving({});
    await h.poll();
    await h.poll();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"], [undefined]]);
  });

  it("relay lost on a poll calls setTailnetBlock('relay-missing')", async () => {
    const h = harness({ relay: true, serve: serving(RELAYED) });
    await h.start();
    expect(h.setTailnetBlock.mock.calls).toEqual([[undefined]]);

    h.state.serve = serving(REAL);
    await h.poll();
    expect(h.setTailnetBlock.mock.calls).toEqual([[undefined], ["relay-missing"]]);
  });

  it("clears relay-missing once the forward is confirmed", async () => {
    const h = harness({ relay: true, serve: serving({}) });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith("relay-missing");

    h.state.serve = serving(RELAYED);
    await h.poll();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith(undefined);
  });

  it("an empty config, which Tailscale may print as null, is a successful read", async () => {
    const h = harness({ relay: true, serve: { code: 0, stdout: "null\n", stderr: "" } });
    await h.start();
    expect(h.setTailnetBlock.mock.calls).toEqual([["relay-missing"]]);
    expect(h.log).not.toHaveBeenCalled();
  });

  it("relay is not checked while relay() is false", async () => {
    const h = harness({ relay: false, serve: serving({}) });
    await h.start();
    expect(h.setTailnetBlock.mock.calls).toEqual([[undefined]]);
  });

  it("Funnel wins over a missing relay", async () => {
    const h = harness({ relay: true, serve: serving(FUNNEL_TCP) });
    await h.start();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"]]);
  });
});

describe("createTailnetGuard: a failed read decides nothing", () => {
  it.each([
    ["CLI missing", { cli: false }],
    ["CLI failing", { serve: { code: 1, stdout: "", stderr: "not running" } }],
    ["CLI throwing", { serve: new Error("timed out") }],
    ["not JSON", { serve: { code: 0, stdout: "Funnel on:\n", stderr: "" } }],
    ["empty output", { serve: { code: 0, stdout: "", stderr: "" } }],
    ["JSON that is not a config", { serve: { code: 0, stdout: "[1]", stderr: "" } }],
  ])("%s sets no block and logs once", async (_name, failing) => {
    const h = harness({ relay: true, ...failing });
    await h.start();
    await h.poll();
    await h.poll();
    expect(h.setTailnetBlock).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it("clears nothing that is set, and logs again only after a success", async () => {
    const h = harness({ relay: true, serve: serving({}) });
    await h.start();
    expect(h.setTailnetBlock.mock.calls).toEqual([["relay-missing"]]);

    h.state.serve = new Error("timed out");
    await h.poll();
    await h.poll();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledTimes(1);

    h.state.serve = serving({});
    await h.poll();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(1);

    h.state.serve = new Error("timed out");
    await h.poll();
    expect(h.log).toHaveBeenCalledTimes(2);
  });
});

describe("createTailnetGuard: while the bridge is unverified", () => {
  it("resends a verdict equal to the last one, after each successful read", async () => {
    const h = harness({ serve: serving({}) });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(1);

    h.state.unverified = true;
    await h.poll();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(2);
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith(undefined);

    // Taken, so the usual rule is back.
    await h.poll();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(2);
  });

  it("a failed read sends no verdict and says the read failed", async () => {
    const h = harness({ serve: refused, unverified: true });
    await h.start();
    expect(h.setTailnetBlock).not.toHaveBeenCalled();
    expect(h.readFailed).toHaveBeenCalledTimes(1);
  });

  it("a successful read does not say a read failed", async () => {
    const h = harness({ serve: serving({}) });
    await h.start();
    expect(h.readFailed).not.toHaveBeenCalled();
  });

  it("with the switch off nothing is read, so no read fails", async () => {
    const h = harness({ enabled: false, serve: refused });
    await h.start();
    expect(h.readFailed).not.toHaveBeenCalled();
  });
});

describe("createTailnetGuard: the bind address", () => {
  it("a bind Tailscale does not list blocks, and a later poll with it listed clears", async () => {
    const h = harness({ tailscaleIps: [] });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith("bad-bind");

    h.state.tailscaleIps = [BIND];
    await h.poll();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith(undefined);
  });

  it("a range-only address, not Tailscale's own, blocks", async () => {
    const h = harness({ bindAddress: "100.64.0.9" });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith("bad-bind");
  });

  it("compares addresses, not spellings", async () => {
    const h = harness({ bindAddress: "FD7A:115C:A1E0:0::1" });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith(undefined);
  });

  it("a failed read clears nothing that is set, on a poll or a checkNow", async () => {
    const h = harness({ tailscaleIps: [] });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith("bad-bind");

    h.state.tailscaleIps = undefined;
    await h.poll();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(1);

    await h.guard.checkNow();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(2);
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith("bad-bind");
  });

  it("a failed read sets nothing either", async () => {
    const h = harness({ tailscaleIps: undefined });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith(undefined);
  });

  it("relay mode skips it: loopback is no Tailscale address, and it is not asked", async () => {
    const h = harness({
      relay: true,
      bindAddress: "127.0.0.1",
      tailscaleIps: [],
      serve: serving(RELAYED),
    });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith(undefined);
    expect(h.calls("status")).toEqual([]);
  });

  it("Funnel wins, without asking", async () => {
    const h = harness({ tailscaleIps: [], serve: serving(FUNNEL_TCP) });
    await h.start();
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith("funnel");
    expect(h.calls("status")).toEqual([]);
  });

  it("the switch going off during the read sends nothing", async () => {
    const h = harness({ tailscaleIps: [] });
    h.exec.mockImplementationOnce(async () => fine);
    h.exec.mockImplementationOnce(async () => {
      return { code: 0, stdout: "{}", stderr: "" };
    });
    h.exec.mockImplementationOnce(async () => fine);
    h.exec.mockImplementationOnce(async () => {
      h.state.enabled = false;
      return { code: 0, stdout: JSON.stringify({ Self: { TailscaleIPs: [] } }), stderr: "" };
    });
    await h.start();
    expect(h.setTailnetBlock).not.toHaveBeenCalled();
  });
});

describe("createTailnetGuard: a listener that failed", () => {
  it("each poll asks the bridge to re-attempt it, after the verdict", async () => {
    const h = harness();
    await h.start();
    expect(h.retryListener).toHaveBeenCalledTimes(1);
    expect(h.setTailnetBlock.mock.invocationCallOrder[0]).toBeLessThan(
      h.retryListener.mock.invocationCallOrder[0] ?? 0,
    );

    await h.poll();
    expect(h.retryListener).toHaveBeenCalledTimes(2);
  });

  it("with the switch off it asks nothing", async () => {
    const h = harness({ enabled: false });
    await h.start();
    await h.poll();
    expect(h.retryListener).not.toHaveBeenCalled();
  });

  it("no second poll is armed until the retry has finished", async () => {
    const h = harness();
    let release: () => void = () => {};
    h.retryListener.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await h.start();
    expect(h.armed).toHaveLength(0);

    release();
    await h.flush();
    expect(h.armed).toHaveLength(1);
  });

  it("a failing retry is logged and the next poll still runs", async () => {
    const h = harness();
    h.retryListener.mockRejectedValueOnce(new Error("retry broke"));
    await h.start();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("retry broke"));
    expect(h.armed).toHaveLength(1);
  });
});

describe("createTailnetGuard: the switch", () => {
  it("does nothing while enabled() is false", async () => {
    const h = harness({
      enabled: false,
      serve: serving(FUNNEL_TCP),
      notAfter: NOW + DAY,
    });
    await h.start();
    await h.poll();
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.setTailnetBlock).not.toHaveBeenCalled();
    expect(h.certificateExpiry).not.toHaveBeenCalled();
    expect(h.reloadCertificate).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalled();
    expect(h.armed).toHaveLength(1);
  });

  it("sends no verdict when the switch went off during the read", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    h.exec.mockImplementationOnce(async () => {
      h.state.enabled = false;
      return fine;
    });
    await h.start();
    expect(h.setTailnetBlock).not.toHaveBeenCalled();
  });

  it("a verdict the bridge drops is not recorded as sent", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    h.setTailnetBlock.mockResolvedValueOnce(false);
    await h.start();
    await h.poll();
    await h.poll();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"], ["funnel"]]);
    expect(h.log).not.toHaveBeenCalled();
  });

  it("a poll that saw the switch off sends the verdict again once it is on", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    await h.start();
    h.state.enabled = false;
    await h.poll();
    h.state.enabled = true;
    await h.poll();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"], ["funnel"]]);
  });
});

describe("createTailnetGuard: checkNow", () => {
  it("always sends the verdict, even an unchanged one", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    await h.start();
    await h.guard.checkNow();
    await h.guard.checkNow();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"], ["funnel"], ["funnel"]]);
  });

  it("does nothing while enabled() is false", async () => {
    const h = harness({ enabled: false, serve: serving(FUNNEL_TCP) });
    await h.guard.checkNow();
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.setTailnetBlock).not.toHaveBeenCalled();
  });

  it("after a failed read the next good poll still sends, since the bridge may have rearmed", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    await h.start();

    h.state.serve = new Error("timed out");
    await h.guard.checkNow();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(1);

    h.state.serve = serving(FUNNEL_TCP);
    await h.poll();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"], ["funnel"]]);
  });

  it("waits for a poll in flight, then reads afresh", async () => {
    const h = harness({ serve: serving({}) });
    let release: () => void = () => {};
    let running = 0;
    let most = 0;
    const realExec = h.exec.getMockImplementation();
    h.exec.mockImplementation(async (command, args) => {
      running += 1;
      most = Math.max(most, running);
      if (args[0] === "serve" && h.calls("serve").length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const answer = await realExec?.(command, args);
      running -= 1;
      return answer as { code: number; stdout: string; stderr: string };
    });
    h.guard.start();
    await h.flush();
    expect(h.calls("serve")).toHaveLength(1);

    const check = h.guard.checkNow();
    await h.flush();
    expect(h.calls("serve")).toHaveLength(1);

    h.state.serve = serving(FUNNEL_TCP);
    release();
    await check;
    expect(h.calls("serve")).toHaveLength(2);
    expect(most).toBe(1);
    expect(h.setTailnetBlock).toHaveBeenLastCalledWith("funnel");
  });

  it("does not wait for a renewal, which can take a minute", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY, connected: 1 });
    const realExec = h.exec.getMockImplementation();
    let release: () => void = () => {};
    h.exec.mockImplementation(async (command, args) => {
      if (args[0] === "cert") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return (await realExec?.(command, args)) as { code: number; stdout: string; stderr: string };
    });
    await h.start();
    expect(h.calls("cert")).toHaveLength(1);

    await h.guard.checkNow();
    expect(h.setTailnetBlock).toHaveBeenCalledTimes(2);
    release();
  });

  it("a rejected verdict is logged, never thrown, and sent again next poll", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    h.setTailnetBlock.mockRejectedValueOnce(new Error("no"));
    await expect(h.guard.checkNow()).resolves.toBeUndefined();
    expect(h.log).toHaveBeenCalledTimes(1);
    await h.start();
    expect(h.setTailnetBlock.mock.calls).toEqual([["funnel"], ["funnel"]]);
  });
});

describe("createTailnetGuard: timers", () => {
  it("stop cancels the armed timer and nothing arms another", async () => {
    const h = harness();
    await h.start();
    expect(h.armed).toHaveLength(1);
    h.guard.stop();
    expect(h.armed).toHaveLength(0);
    h.guard.stop();
    await h.flush();
    expect(h.armed).toHaveLength(0);
  });

  it("a poll in flight at stop decides nothing and arms nothing", async () => {
    const h = harness({ serve: serving(FUNNEL_TCP) });
    h.guard.start();
    h.guard.stop();
    await h.flush();
    expect(h.setTailnetBlock).not.toHaveBeenCalled();
    expect(h.armed).toHaveLength(0);
  });

  it("the next poll is armed only after the last one finished", async () => {
    const h = harness();
    const realExec = h.exec.getMockImplementation();
    let release: () => void = () => {};
    h.exec.mockImplementation(async (command, args) => {
      if (args[0] === "serve") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return (await realExec?.(command, args)) as { code: number; stdout: string; stderr: string };
    });
    h.guard.start();
    await h.flush();
    expect(h.armed).toHaveLength(0);
    release();
    await h.flush();
    expect(h.armed).toHaveLength(1);
  });

  it("start twice runs one loop", async () => {
    const h = harness();
    h.guard.start();
    h.guard.start();
    await h.flush();
    expect(h.calls("serve")).toHaveLength(1);
    expect(h.armed).toHaveLength(1);
  });
});

describe("createTailnetGuard: renewal", () => {
  it("at 31 days does nothing", async () => {
    const h = harness({ notAfter: NOW + 31 * DAY });
    await h.start();
    expect(h.certificateExpiry).toHaveBeenCalledWith(CERT_PATH);
    expect(h.calls("cert")).toEqual([]);
    expect(h.reloadCertificate).not.toHaveBeenCalled();
  });

  it("at exactly 30 days does nothing: renewal is under 30", async () => {
    const h = harness({ notAfter: NOW + 30 * DAY });
    await h.start();
    expect(h.calls("cert")).toEqual([]);
  });

  it("checks daily, not every poll", async () => {
    const h = harness({ notAfter: NOW + 31 * DAY });
    await h.start();
    await h.poll();
    expect(h.certificateExpiry).toHaveBeenCalledTimes(1);

    h.state.now = NOW + DAY - 1;
    await h.poll();
    expect(h.certificateExpiry).toHaveBeenCalledTimes(1);

    h.state.now = NOW + DAY;
    await h.poll();
    expect(h.certificateExpiry).toHaveBeenCalledTimes(2);
  });

  it("at 29 days renews, and waits for no connected device before reloading", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY, connected: 2 });
    await h.start();
    expect(h.calls("cert")).toHaveLength(1);
    expect(h.calls("cert")[0]?.[1]).toEqual([
      "cert",
      "--cert-file",
      CERT_PATH,
      "--key-file",
      KEY_PATH,
      HOST,
    ]);
    expect(h.reloadCertificate).not.toHaveBeenCalled();

    h.state.connected = 1;
    await h.poll();
    expect(h.reloadCertificate).not.toHaveBeenCalled();

    h.state.connected = 0;
    await h.poll();
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);

    await h.poll();
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("at 29 days with nothing connected reloads on the same poll", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY, connected: 0 });
    await h.start();
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("a pending reload survives later days without renewing again", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY, connected: 2 });
    await h.start();
    // Before and after the renewal; nothing more while the reload waits.
    expect(h.certificateExpiry).toHaveBeenCalledTimes(2);
    for (let day = 1; day <= 3; day++) {
      h.state.now = NOW + day * DAY;
      await h.poll();
    }
    expect(h.calls("cert")).toHaveLength(1);
    expect(h.certificateExpiry).toHaveBeenCalledTimes(2);
    expect(h.reloadCertificate).not.toHaveBeenCalled();

    h.state.connected = 0;
    await h.poll();
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("a pending reload is forced once the served certificate reaches 7 days left", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY, connected: 2 });
    await h.start();

    h.state.now = NOW + 22 * DAY - 1;
    await h.poll();
    expect(h.reloadCertificate).not.toHaveBeenCalled();

    h.state.now = NOW + 22 * DAY;
    await h.poll();
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("at 6 days reloads regardless", async () => {
    const h = harness({ notAfter: NOW + 6 * DAY, connected: 3 });
    await h.start();
    expect(h.calls("cert")).toHaveLength(1);
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("`cert` exiting 0 with the expiry unchanged is not a renewal", async () => {
    // What upstream does on the first run once renewal is due: it renews in
    // the background and writes the cached certificate back.
    const notAfter = NOW + 29 * DAY;
    const h = harness({ notAfter, renewedNotAfter: notAfter, connected: 2 });
    await h.start();
    expect(h.calls("cert")).toHaveLength(1);
    expect(h.log).toHaveBeenCalledTimes(1);

    // Nothing pending: not reloaded when the devices leave, not forced later,
    // and not run again until the next daily check.
    h.state.connected = 0;
    await h.poll();
    expect(h.reloadCertificate).not.toHaveBeenCalled();
    expect(h.calls("cert")).toHaveLength(1);

    h.state.now = NOW + DAY;
    h.state.renewedNotAfter = NOW + 90 * DAY;
    h.state.connected = 2;
    await h.poll();
    expect(h.calls("cert")).toHaveLength(2);
    expect(h.reloadCertificate).not.toHaveBeenCalled();

    h.state.connected = 0;
    await h.poll();
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("an unchanged certificate at 6 days does not force a reload", async () => {
    const notAfter = NOW + 6 * DAY;
    const h = harness({ notAfter, renewedNotAfter: notAfter, connected: 3 });
    await h.start();
    expect(h.calls("cert")).toHaveLength(1);
    expect(h.reloadCertificate).not.toHaveBeenCalled();
  });

  it("an unreadable file after `cert` is not a renewal, and retries next day", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY });
    h.certificateExpiry.mockResolvedValueOnce(NOW + 29 * DAY);
    h.certificateExpiry.mockRejectedValueOnce(new Error("ENOENT"));
    await h.start();
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.reloadCertificate).not.toHaveBeenCalled();

    h.state.now = NOW + DAY;
    await h.poll();
    expect(h.calls("cert")).toHaveLength(1);
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("files replaced by a renewal that reported failure are still reloaded", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY });
    // `cert` wrote both files; tightening them afterwards fails.
    vi.mocked(h.deps.tailscale.fs.chmod)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("EPERM"));
    await h.start();
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.reloadCertificate).not.toHaveBeenCalled();

    h.state.now = NOW + DAY;
    await h.poll();
    expect(h.calls("cert")).toHaveLength(1);
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("a failed renewal keeps the old certificate and retries next day", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY, connected: 0, certCode: 1 });
    await h.start();
    expect(h.calls("cert")).toHaveLength(1);
    expect(h.reloadCertificate).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);

    await h.poll();
    expect(h.calls("cert")).toHaveLength(1);

    h.state.now = NOW + DAY;
    h.state.certCode = 0;
    await h.poll();
    expect(h.calls("cert")).toHaveLength(2);
    expect(h.reloadCertificate).toHaveBeenCalledTimes(1);
  });

  it("a failed reload stays pending, without renewing again", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY });
    h.reloadCertificate.mockRejectedValueOnce(new Error("no"));
    await h.start();
    expect(h.log).toHaveBeenCalledTimes(1);
    await h.poll();
    expect(h.reloadCertificate).toHaveBeenCalledTimes(2);
    expect(h.calls("cert")).toHaveLength(1);
  });

  it("an unreadable certificate is logged and retried next day", async () => {
    const h = harness();
    h.certificateExpiry.mockRejectedValueOnce(new Error("ENOENT"));
    await h.start();
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.calls("cert")).toEqual([]);
    await h.poll();
    expect(h.certificateExpiry).toHaveBeenCalledTimes(1);
    h.state.now = NOW + DAY;
    await h.poll();
    expect(h.certificateExpiry).toHaveBeenCalledTimes(2);
  });

  it("with no certificate configured there is nothing to renew", async () => {
    const h = harness({ certPath: undefined, keyPath: undefined, notAfter: NOW });
    await h.start();
    expect(h.certificateExpiry).not.toHaveBeenCalled();
    expect(h.calls("cert")).toEqual([]);
  });

  it("never writes over a pair other than the one tailscale issued here", async () => {
    const h = harness({
      notAfter: NOW + DAY,
      certPath: "/etc/ssl/mine.crt",
      keyPath: "/etc/ssl/mine.key",
    });
    await h.start();
    expect(h.calls("cert")).toEqual([]);
    expect(h.reloadCertificate).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledTimes(1);
  });

  it("a renewal after stop does not reload", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY });
    const realExec = h.exec.getMockImplementation();
    let release: () => void = () => {};
    h.exec.mockImplementation(async (command, args) => {
      if (args[0] === "cert") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return (await realExec?.(command, args)) as { code: number; stdout: string; stderr: string };
    });
    await h.start();
    expect(h.calls("cert")).toHaveLength(1);

    h.guard.stop();
    release();
    await h.flush();
    expect(h.reloadCertificate).not.toHaveBeenCalled();
    expect(h.armed).toHaveLength(0);
  });

  it("stop during the expiry read starts no renewal", async () => {
    const h = harness({ notAfter: NOW + 29 * DAY });
    h.certificateExpiry.mockImplementationOnce(async () => {
      h.guard.stop();
      return h.state.notAfter;
    });
    await h.start();
    expect(h.calls("cert")).toEqual([]);
  });
});
