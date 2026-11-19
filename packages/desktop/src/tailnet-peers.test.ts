// tailnet-peers.ts: which tailnet peers are other Jarvis machines. Every
// dependency is faked — no real `tailscale` binary, no real network.
import { describe, expect, it, vi } from "vitest";
import { createDispatchTable, type Origin } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";
import { createTailnetPeers, type TailnetPeersDeps } from "./tailnet-peers.js";
import type { TailscaleCertDeps, TailscaleExec } from "./tailscale-cert.js";

const SELF = { UserID: 1, DNSName: "mac.tail1.ts.net.", Online: true };

type Peer = {
  UserID?: unknown;
  DNSName?: unknown;
  Online?: unknown;
  Tags?: unknown;
};

const peer = (name: string, extra: Partial<Peer> = {}): Peer => ({
  UserID: 1,
  DNSName: `${name}.`,
  Online: true,
  ...extra,
});

const statusJson = (peers: Peer[], backend = "Running") =>
  JSON.stringify({
    BackendState: backend,
    Self: SELF,
    Peer: Object.fromEntries(peers.map((p, i) => [`nodekey:${i}`, p])),
  });

const reply = (name: string, label = name.split(".")[0]!) => ({
  name,
  label,
  v: 1,
  bridgePort: 7717,
  webPort: 7718,
});

function setup(
  options: {
    stdout?: string;
    code?: number;
    noCli?: boolean;
    probe?: TailnetPeersDeps["probe"];
  } = {},
) {
  let clock = 0;
  const exec = vi.fn<TailscaleExec>(async (_command, args) => {
    if (args[0] === "version") {
      return options.noCli
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: "1.0", stderr: "" };
    }
    return { code: options.code ?? 0, stdout: options.stdout ?? statusJson([]), stderr: "" };
  });
  const tailscale: TailscaleCertDeps = {
    exec,
    fs: {
      access: vi.fn(async () => {
        if (options.noCli) throw new Error("ENOENT");
      }),
      mkdir: vi.fn(async () => undefined),
      chmod: vi.fn(async () => undefined),
    },
    homedir: () => "/Users/x",
    platform: "darwin",
  };
  const probe = vi.fn<TailnetPeersDeps["probe"]>(
    options.probe ?? (async (name: string) => reply(name)),
  );
  const peers = createTailnetPeers({ tailscale, probe, now: () => clock });
  const statusRuns = () => exec.mock.calls.filter(([, args]) => args[0] === "status").length;
  return {
    peers,
    exec,
    probe,
    statusRuns,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createTailnetPeers", () => {
  it("reads the full status with its own limits", async () => {
    const { peers, exec } = setup();
    await peers.list();
    expect(exec).toHaveBeenCalledWith(
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ["status", "--json"],
      { timeoutMs: 10_000, maxOutputBytes: 4_000_000 },
    );
  });

  it("probes only this user's untagged, online, named peers, never itself", async () => {
    const stdout = statusJson([
      peer("mac.tail1.ts.net"), // this machine's own name, listed as a peer
      peer("tagged.tail1.ts.net", { Tags: ["tag:server"] }),
      peer("shared.tail1.ts.net", { UserID: 2 }),
      peer("offline.tail1.ts.net", { Online: false }),
      { UserID: 1, DNSName: "", Online: true },
      { UserID: 1, Online: true },
      peer("empty-tags.tail1.ts.net", { Tags: [] }),
      peer("good.tail1.ts.net"),
    ]);
    const { peers, probe } = setup({ stdout });
    const result = await peers.list();
    expect(probe.mock.calls.map(([name]) => name).sort()).toEqual([
      "empty-tags.tail1.ts.net",
      "good.tail1.ts.net",
    ]);
    expect(probe).toHaveBeenCalledWith("good.tail1.ts.net", 7718, 2000);
    expect(result).toEqual({
      state: "ok",
      machines: [reply("empty-tags.tail1.ts.net"), reply("good.tail1.ts.net")],
    });
  });

  it("drops a peer whose reply names another machine", async () => {
    const stdout = statusJson([peer("a.tail1.ts.net"), peer("b.tail1.ts.net")]);
    const { peers } = setup({
      stdout,
      probe: async (name) => (name === "a.tail1.ts.net" ? reply("evil.tail1.ts.net") : reply(name)),
    });
    expect((await peers.list()).machines).toEqual([reply("b.tail1.ts.net")]);
  });

  it.each([
    ["not an object", "hello"],
    ["null", null],
    ["missing label", { name: "a.tail1.ts.net", v: 1, bridgePort: 7717, webPort: 7718 }],
    ["string version", { ...reply("a.tail1.ts.net"), v: "1" }],
    ["string port", { ...reply("a.tail1.ts.net"), bridgePort: "7717" }],
    ["port out of range", { ...reply("a.tail1.ts.net"), bridgePort: 70000 }],
    ["fractional port", { ...reply("a.tail1.ts.net"), webPort: 7718.5 }],
  ])("drops a malformed reply (%s)", async (_label, value) => {
    const { peers } = setup({
      stdout: statusJson([peer("a.tail1.ts.net")]),
      probe: async () => value,
    });
    expect(await peers.list()).toEqual({ state: "ok", machines: [] });
  });

  it("drops a peer whose probe fails or times out, and keeps the rest", async () => {
    const stdout = statusJson([
      peer("a.tail1.ts.net"),
      peer("b.tail1.ts.net"),
      peer("c.tail1.ts.net"),
    ]);
    const { peers } = setup({
      stdout,
      probe: async (name) => {
        if (name === "a.tail1.ts.net") throw new Error("timeout");
        if (name === "b.tail1.ts.net") return Promise.reject(new Error("ECONNREFUSED"));
        return reply(name);
      },
    });
    expect(await peers.list()).toEqual({ state: "ok", machines: [reply("c.tail1.ts.net")] });
  });

  it("probes every candidate at once", async () => {
    const stdout = statusJson([peer("a.tail1.ts.net"), peer("b.tail1.ts.net")]);
    let started = 0;
    const release: Array<() => void> = [];
    const { peers } = setup({
      stdout,
      probe: (name) =>
        new Promise((resolve) => {
          started += 1;
          release.push(() => resolve(reply(name)));
        }),
    });
    const pending = peers.list();
    await vi.waitFor(() => expect(started).toBe(2));
    for (const r of release) r();
    expect((await pending).machines).toHaveLength(2);
  });

  it("answers no-cli when Tailscale is not installed", async () => {
    const { peers, statusRuns } = setup({ noCli: true });
    expect(await peers.list()).toEqual({ state: "no-cli", machines: [] });
    expect(statusRuns()).toBe(0);
  });

  it.each([
    ["a non-zero exit", { code: 1 }],
    ["output that is not JSON", { stdout: "{oops" }],
    ["JSON that is not an object", { stdout: "[1]" }],
    ["a stopped backend", { stdout: statusJson([peer("a.tail1.ts.net")], "Stopped") }],
    ["a missing backend state", { stdout: JSON.stringify({ Self: SELF, Peer: {} }) }],
  ])("answers not-running for %s", async (_label, options) => {
    const { peers, probe } = setup(options);
    expect(await peers.list()).toEqual({ state: "not-running", machines: [] });
    expect(probe).not.toHaveBeenCalled();
  });

  it("answers not-running when the status run itself throws", async () => {
    const { peers, exec } = setup();
    exec.mockImplementation(async (_c, args) => {
      if (args[0] === "status") throw new Error("spawn failed");
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(await peers.list()).toEqual({ state: "not-running", machines: [] });
  });

  it("reuses the last answer for 30 s, then reads again", async () => {
    const { peers, probe, statusRuns, advance } = setup({
      stdout: statusJson([peer("a.tail1.ts.net")]),
    });
    const first = await peers.list();
    advance(30_000);
    expect(await peers.list()).toBe(first);
    expect(statusRuns()).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    advance(1);
    await peers.list();
    expect(statusRuns()).toBe(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("shares one run between two callers at once", async () => {
    const { peers, probe, statusRuns } = setup({
      stdout: statusJson([peer("a.tail1.ts.net")]),
    });
    const [a, b] = await Promise.all([peers.list(), peers.list()]);
    expect(a).toBe(b);
    expect(statusRuns()).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("sorts by label, then by name", async () => {
    const stdout = statusJson([
      peer("z.tail1.ts.net"),
      peer("y.tail1.ts.net"),
      peer("x.tail1.ts.net"),
    ]);
    const labels: Record<string, string> = {
      "z.tail1.ts.net": "Alpha",
      "y.tail1.ts.net": "Beta",
      "x.tail1.ts.net": "Beta",
    };
    const { peers } = setup({ stdout, probe: async (name) => reply(name, labels[name]) });
    expect((await peers.list()).machines.map((m) => m.name)).toEqual([
      "z.tail1.ts.net",
      "x.tail1.ts.net",
      "y.tail1.ts.net",
    ]);
  });
});

describe("tailnet:peers dispatch", () => {
  it("answers a phone with the finder's list", async () => {
    const answer = { state: "ok" as const, machines: [reply("a.tail1.ts.net")] };
    const tailnetPeers = { list: vi.fn(async () => answer) };
    const table = createDispatchTable(fakeDeps({ tailnetPeers })) as Record<
      string,
      (args: readonly unknown[], origin: Origin) => unknown
    >;
    const remote: Origin = { kind: "remote", deviceId: "d1", deviceName: "Phone" };
    expect(await table["tailnet:peers"]!([], remote)).toBe(answer);
    expect(tailnetPeers.list).toHaveBeenCalledTimes(1);
  });
});
