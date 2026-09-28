import type { RemoteStatus } from "@jarvis/remote";
import { describe, expect, it, vi } from "vitest";
import { MESSAGES } from "../../messages.js";
import { encodeQr } from "../../vendor/qr.js";
import { ControlRestartRequired } from "../control/client.js";
import { parseCliArgs } from "./args.js";
import { type CliClient, type CliDeps, type CliIo, PAIR_POLL_MS, runCli } from "./commands.js";
import { formatDevices, formatTime, terminalSafe } from "./format.js";
import { CLI_MESSAGES } from "./messages.js";
import { qrToBlocks } from "./qr-blocks.js";

const PASSWORD = "correct horse battery staple";
const OLD_PASSWORD = "an older owner password";

// --- doubles -----------------------------------------------------------

type FakeIo = CliIo & {
  outLines: string[];
  errLines: string[];
  prompts: string[];
  /** Everything the terminal was shown, prompts included. */
  all(): string;
  interrupt(): void;
};

function fakeIo(options: {
  tty?: boolean;
  /** stdout is a terminal unless said otherwise. */
  stdoutTty?: boolean;
  lines?: (string | undefined)[];
  hidden?: (string | undefined)[];
  /** Keep readLine pending instead of answering (Ctrl-C tests). */
  holdLines?: boolean;
}): FakeIo {
  const lines = [...(options.lines ?? [])];
  const hidden = [...(options.hidden ?? [])];
  const interrupts = new Set<() => void>();
  const io: FakeIo = {
    outLines: [],
    errLines: [],
    prompts: [],
    stdinIsTTY: options.tty ?? false,
    stdoutIsTTY: options.stdoutTty ?? true,
    out: (line) => void io.outLines.push(line),
    err: (line) => void io.errLines.push(line),
    readLine(prompt) {
      if (prompt !== undefined) io.prompts.push(prompt);
      if (options.holdLines) return new Promise(() => {});
      return Promise.resolve(lines.shift());
    },
    readHidden(prompt) {
      io.prompts.push(prompt);
      return Promise.resolve(hidden.shift());
    },
    onInterrupt(listener) {
      interrupts.add(listener);
      return () => interrupts.delete(listener);
    },
    all: () => [...io.outLines, ...io.errLines, ...io.prompts].join("\n"),
    interrupt: () => {
      for (const listener of interrupts) listener();
    },
  };
  return io;
}

function remoteStatus(overrides: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true,
    listening: {
      host: "100.79.83.16",
      port: 7717,
      fingerprint: "ab".repeat(32),
      certificate: { source: "self-signed", hostname: undefined },
    },
    pairing: { kind: "closed" },
    devices: [],
    problem: undefined,
    sidecarProxy: "off",
    web: { kind: "off" },
    ...overrides,
  };
}

type Call = { channel: string; args: unknown[] };

function fakeClient(answer: (channel: string, args: unknown[]) => unknown) {
  const calls: Call[] = [];
  const pushes = new Set<(channel: string, payload: unknown) => void>();
  const closes = new Set<() => void>();
  let closed = false;
  const client: CliClient & {
    calls: Call[];
    push(channel: string, payload: unknown): void;
    drop(): void;
    readonly closed: boolean;
  } = {
    calls,
    invoke: async (channel, args) => {
      calls.push({ channel, args });
      return answer(channel, args);
    },
    onPush: (listener) => {
      pushes.add(listener);
      return () => pushes.delete(listener);
    },
    onClose: (listener) => {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close: () => {
      closed = true;
    },
    push: (channel, payload) => {
      for (const listener of pushes) listener(channel, payload);
    },
    drop: () => {
      for (const listener of closes) listener();
    },
    get closed() {
      return closed;
    },
  };
  return client;
}

function deps(
  io: CliIo,
  client: CliClient | (() => Promise<CliClient>),
): CliDeps & {
  tick(): void;
} {
  const intervals = new Map<number, () => void>();
  let next = 1;
  return {
    io,
    language: "en",
    connect: typeof client === "function" ? client : async () => client,
    runDaemon: vi.fn(async () => 0),
    encodeQr,
    now: () => 1_000_000,
    timers: {
      setInterval(callback) {
        intervals.set(next, callback);
        return next++;
      },
      clearInterval(handle) {
        intervals.delete(handle as number);
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    tick() {
      for (const callback of intervals.values()) callback();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- parser ------------------------------------------------------------

describe("parseCliArgs", () => {
  it.each([
    [["run"], { kind: "run" }],
    [["status"], { kind: "status" }],
    [["set-password"], { kind: "set-password", stdin: false }],
    [["set-password", "--stdin"], { kind: "set-password", stdin: true }],
    [["pair"], { kind: "pair" }],
    [["devices"], { kind: "devices" }],
    [["revoke", "d-123"], { kind: "revoke", id: "d-123" }],
    [["revoke", "--", "-odd-id"], { kind: "revoke", id: "-odd-id" }],
    [["sign-out-all"], { kind: "sign-out-all", yes: false }],
    [["sign-out-all", "--yes"], { kind: "sign-out-all", yes: true }],
    [["sign-out-all", "-y"], { kind: "sign-out-all", yes: true }],
    [["web", "on"], { kind: "web", enabled: true }],
    [["web", "off"], { kind: "web", enabled: false }],
    [["stop"], { kind: "stop" }],
    [["help"], { kind: "help" }],
    [["--help"], { kind: "help" }],
    [["status", "-h"], { kind: "help" }],
  ])("%j", (argv, expected) => {
    expect(parseCliArgs(argv)).toEqual(expected);
  });

  it.each([
    [[], "missing-command"],
    [["frobnicate"], "unknown-command"],
    [["--verbose"], "unknown-option"],
    [["status", "extra"], "unexpected-argument"],
    [["run", "now"], "unexpected-argument"],
    [["revoke"], "missing-argument"],
    [["revoke", ""], "missing-argument"],
    [["revoke", "a", "b"], "unexpected-argument"],
    [["web"], "missing-argument"],
    [["web", "maybe"], "bad-web-value"],
    [["web", "ON"], "bad-web-value"],
    [["status", "--stdin"], "unknown-option"],
    [["set-password", "--yes"], "unknown-option"],
    [["sign-out-all", "--force"], "unknown-option"],
    [["constructor"], "unknown-command"],
  ])("%j is a usage error (%s)", (argv, code) => {
    expect(parseCliArgs(argv)).toMatchObject({ kind: "usage-error", problem: { code } });
  });

  it("exits 2 with the problem and the usage on bad input, without connecting", async () => {
    for (const argv of [[], ["nope"], ["web", "sideways"], ["revoke"]]) {
      const io = fakeIo({});
      const connect = vi.fn();
      const code = await runCli(argv, {
        ...deps(
          io,
          fakeClient(() => undefined),
        ),
        connect,
      });
      expect(code).toBe(2);
      expect(connect).not.toHaveBeenCalled();
      expect(io.errLines.join("\n")).toContain("Usage: jarvisd");
    }
  });

  it("prints help on stdout and exits 0", async () => {
    const io = fakeIo({});
    expect(
      await runCli(
        ["--help"],
        deps(
          io,
          fakeClient(() => undefined),
        ),
      ),
    ).toBe(0);
    expect(io.outLines.join("\n")).toContain("set-password");
  });

  it("hands `run` to the daemon", async () => {
    const io = fakeIo({});
    const d = deps(
      io,
      fakeClient(() => undefined),
    );
    const connect = vi.fn();
    await runCli(["run"], { ...d, connect });
    expect(d.runDaemon).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });

  it("has an Arabic usage and usage errors too", () => {
    expect(CLI_MESSAGES.usage("ar")).toContain("jarvisd");
    expect(CLI_MESSAGES.usage("ar")).not.toBe(CLI_MESSAGES.usage("en"));
    expect(CLI_MESSAGES.usageError({ code: "unknown-command", value: "x" }, "ar")).toContain("x");
  });
});

// --- connection failures ------------------------------------------------

describe("connection failures", () => {
  it("exits 3 when the daemon is not running", async () => {
    for (const code of ["ENOENT", "ECONNREFUSED"]) {
      const io = fakeIo({});
      const failing = async () => {
        throw Object.assign(new Error(`connect ${code}`), { code });
      };
      expect(await runCli(["status"], deps(io, failing))).toBe(3);
      expect(io.errLines).toEqual([CLI_MESSAGES.notRunning("en")]);
    }
  });

  it("exits 1 and says to restart when the daemon runs another build", async () => {
    const io = fakeIo({});
    const failing = async () => {
      throw new ControlRestartRequired("0.1.4+abc");
    };
    expect(await runCli(["devices"], deps(io, failing))).toBe(1);
    expect(io.errLines).toEqual([CLI_MESSAGES.restartRequired("en")]);
  });
});

// --- set-password ---------------------------------------------------------

describe("set-password", () => {
  const owner = (hasPassword: boolean) => (channel: string) => {
    if (channel === "remote:ownerStatus") return { hasPassword, passkeys: [] };
    if (channel === "remote:setOwnerPassword") return { ok: true };
    return undefined;
  };

  it("refuses a non-TTY stdin without --stdin, before connecting", async () => {
    const io = fakeIo({ tty: false, lines: [PASSWORD] });
    const connect = vi.fn();
    const code = await runCli(["set-password"], { ...deps(io, fakeClient(owner(false))), connect });
    expect(code).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    expect(io.errLines).toEqual([CLI_MESSAGES.needsTerminal("en")]);
  });

  it("reads one line with --stdin and never shows the password", async () => {
    const io = fakeIo({ tty: false, lines: [PASSWORD] });
    const client = fakeClient(owner(false));
    expect(await runCli(["set-password", "--stdin"], deps(io, client))).toBe(0);
    expect(client.calls.at(-1)).toEqual({
      channel: "remote:setOwnerPassword",
      args: [null, PASSWORD],
    });
    expect(io.outLines).toEqual([MESSAGES.remoteOwnerSaved("en")]);
    expect(io.all()).not.toContain(PASSWORD);
    expect(client.closed).toBe(true);
  });

  it("reads the current password first with --stdin when one is set", async () => {
    const io = fakeIo({ lines: [OLD_PASSWORD, PASSWORD] });
    const client = fakeClient(owner(true));
    expect(await runCli(["set-password", "--stdin"], deps(io, client))).toBe(0);
    expect(client.calls.at(-1)?.args).toEqual([OLD_PASSWORD, PASSWORD]);
    expect(io.all()).not.toContain(PASSWORD);
    expect(io.all()).not.toContain(OLD_PASSWORD);
  });

  it("fails when stdin ends before a password", async () => {
    const io = fakeIo({ lines: [] });
    const client = fakeClient(owner(false));
    expect(await runCli(["set-password", "--stdin"], deps(io, client))).toBe(1);
    expect(io.errLines).toEqual([CLI_MESSAGES.noPasswordOnStdin("en")]);
    expect(client.calls.map((call) => call.channel)).not.toContain("remote:setOwnerPassword");
  });

  it("asks without echo on a TTY: current, new, confirm", async () => {
    const io = fakeIo({ tty: true, hidden: [OLD_PASSWORD, PASSWORD, PASSWORD] });
    const client = fakeClient(owner(true));
    expect(await runCli(["set-password"], deps(io, client))).toBe(0);
    expect(io.prompts).toEqual([
      `${MESSAGES.remoteOwnerCurrentLabel("en")}: `,
      `${MESSAGES.remoteOwnerNewLabel("en")}: `,
      `${MESSAGES.remoteOwnerConfirmLabel("en")}: `,
    ]);
    expect(client.calls.at(-1)?.args).toEqual([OLD_PASSWORD, PASSWORD]);
    expect(io.all()).not.toContain(PASSWORD);
  });

  it("refuses a confirmation that does not match, sending nothing", async () => {
    const io = fakeIo({ tty: true, hidden: [PASSWORD, `${PASSWORD}!`] });
    const client = fakeClient(owner(false));
    expect(await runCli(["set-password"], deps(io, client))).toBe(1);
    expect(io.errLines).toContain(MESSAGES.remoteOwnerError("mismatch", "en"));
    expect(client.calls.map((call) => call.channel)).toEqual(["remote:ownerStatus"]);
    expect(io.all()).not.toContain(PASSWORD);
  });

  it("stops on Ctrl-C at a prompt", async () => {
    const io = fakeIo({ tty: true, hidden: [undefined] });
    const client = fakeClient(owner(false));
    expect(await runCli(["set-password"], deps(io, client))).toBe(1);
    expect(io.errLines).toContain(CLI_MESSAGES.cancelled("en"));
  });

  it("shows the daemon's refusal, not the password", async () => {
    const io = fakeIo({ lines: ["short"] });
    const client = fakeClient((channel) =>
      channel === "remote:ownerStatus"
        ? { hasPassword: false, passkeys: [] }
        : { ok: false, code: "too-short" },
    );
    expect(await runCli(["set-password", "--stdin"], deps(io, client))).toBe(1);
    expect(io.errLines).toEqual([MESSAGES.remoteOwnerError("too-short", "en")]);
    expect(io.all()).not.toContain("short\n");
  });

  it("keeps the password out of a transport failure's message", async () => {
    const io = fakeIo({ lines: [PASSWORD] });
    const client = fakeClient((channel) => {
      if (channel === "remote:ownerStatus") return { hasPassword: false, passkeys: [] };
      throw new Error("The control connection closed");
    });
    expect(await runCli(["set-password", "--stdin"], deps(io, client))).toBe(1);
    expect(io.all()).not.toContain(PASSWORD);
  });
});

// --- pair ------------------------------------------------------------------

describe("pair", () => {
  const URI = `jarvis://pair?v=2&host=100.79.83.16&port=7717&secret=${"s".repeat(43)}&fp=${"ab".repeat(31)}c0de`;
  const open = remoteStatus({
    pairing: { kind: "open", uri: URI, expiresAt: 1_000_000 + 120_000 },
  });
  const confirming = remoteStatus({
    pairing: {
      kind: "confirming",
      requestId: "req-1",
      deviceName: "Pixel\u001b[2J\u202eevil",
      address: "100.64.0.9",
      expiresAt: 1_060_000,
    },
  });

  function pairingClient(sequence: RemoteStatus[], decisionReached = true) {
    let index = 0;
    return fakeClient((channel) => {
      if (channel === "remote:pair") return { ok: true, value: undefined };
      if (channel === "remote:status") return sequence[Math.min(index++, sequence.length - 1)];
      if (channel === "remote:decidePair") return decisionReached;
      return undefined;
    });
  }

  it("prints the link, the QR and the fingerprint tail, then approves on y", async () => {
    const io = fakeIo({ lines: ["y"] });
    const client = pairingClient([open, open]);
    const d = deps(io, client);
    const done = runCli(["pair"], d);
    await flush();
    expect(io.outLines).toContain(URI);
    expect(io.outLines).toContain(MESSAGES.remotePairFingerprintTail("c0de", "en"));
    expect(io.outLines).toContain(MESSAGES.remotePairExpires(120, "en"));
    expect(io.outLines.some((line) => line.includes("█"))).toBe(true);

    client.push("remote:update", confirming);
    expect(await done).toBe(0);
    expect(client.calls.at(-1)).toEqual({ channel: "remote:decidePair", args: ["req-1", true] });
    // The device's own name, printed without its escape or bidi characters.
    expect(io.outLines).toContain(`${MESSAGES.remoteConfirmDeviceLabel("en")}: Pixel[2Jevil`);
    expect(io.all()).not.toContain("\u001b[2J");
    expect(io.outLines).toContain(CLI_MESSAGES.pairApproved("en"));
  });

  it("denies on anything but y, found by polling", async () => {
    for (const answer of ["", "n", "no", "maybe", undefined]) {
      const io = fakeIo({ lines: [answer] });
      const client = pairingClient([open, confirming]);
      const d = deps(io, client);
      const done = runCli(["pair"], d);
      await flush();
      d.tick();
      expect(await done).toBe(1);
      expect(client.calls.at(-1)).toEqual({
        channel: "remote:decidePair",
        args: ["req-1", false],
      });
      expect(io.errLines).toContain(CLI_MESSAGES.pairDeclined("en"));
    }
  });

  it("cancels the pairing window on Ctrl-C, even at the y/N prompt", async () => {
    for (const ask of [false, true]) {
      const io = fakeIo({ holdLines: true });
      const client = pairingClient(ask ? [open, confirming] : [open, open]);
      const d = deps(io, client);
      const done = runCli(["pair"], d);
      await flush();
      d.tick();
      await flush();
      io.interrupt();
      expect(await done).toBe(1);
      expect(client.calls.at(-1)?.channel).toBe("remote:cancelPair");
      expect(client.calls.map((call) => call.channel)).not.toContain("remote:decidePair");
      expect(io.errLines).toContain(CLI_MESSAGES.cancelled("en"));
    }
  });

  it("refuses when stdout is not a terminal, before connecting", async () => {
    const io = fakeIo({ stdoutTty: false });
    const connect = vi.fn();
    const code = await runCli(["pair"], { ...deps(io, pairingClient([open])), connect });
    expect(code).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    expect(io.outLines).toEqual([]);
    expect(io.errLines).toEqual([CLI_MESSAGES.pairNeedsTerminal("en")]);
    expect(CLI_MESSAGES.pairNeedsTerminal("ar")).not.toBe(CLI_MESSAGES.pairNeedsTerminal("en"));
  });

  it("reports a request that ended before the answer, never 'Approved'", async () => {
    for (const answer of ["y", "n"]) {
      const io = fakeIo({ lines: [answer] });
      const client = pairingClient([open, confirming], false);
      const d = deps(io, client);
      const done = runCli(["pair"], d);
      await flush();
      d.tick();
      expect(await done).toBe(1);
      expect(client.calls.at(-1)?.channel).toBe("remote:decidePair");
      expect(io.errLines).toContain(CLI_MESSAGES.pairRequestGone("en"));
      expect(io.outLines).not.toContain(CLI_MESSAGES.pairApproved("en"));
      expect(io.errLines).not.toContain(CLI_MESSAGES.pairDeclined("en"));
    }
  });

  it("prints the browser link while browser access is on", async () => {
    const io = fakeIo({ lines: ["n"] });
    const withWeb = remoteStatus({
      web: { kind: "on", port: 7718, origin: "https://mac.tail.ts.net:7718" },
      pairing: {
        kind: "open",
        uri: URI,
        expiresAt: 1_120_000,
        webUri: "https://mac.tail.ts.net:7718/pair#secret",
      },
    });
    const client = pairingClient([withWeb, confirming]);
    const d = deps(io, client);
    const done = runCli(["pair"], d);
    await flush();
    expect(io.outLines).toContain("https://mac.tail.ts.net:7718/pair#secret");
    d.tick();
    await done;
  });

  it("fails when the window closes with no request, or pairing is refused", async () => {
    const io = fakeIo({});
    const client = pairingClient([open, remoteStatus()]);
    const d = deps(io, client);
    const done = runCli(["pair"], d);
    await flush();
    d.tick();
    expect(await done).toBe(1);
    expect(io.errLines).toContain(CLI_MESSAGES.pairClosed("en"));

    const refusedIo = fakeIo({});
    const refused = fakeClient(() => ({
      ok: false,
      text: "Remote access is off.",
      language: "en",
    }));
    expect(await runCli(["pair"], deps(refusedIo, refused))).toBe(1);
    expect(refusedIo.errLines).toEqual(["Remote access is off."]);
  });

  it("fails when the daemon goes away mid-pairing", async () => {
    const io = fakeIo({});
    const client = pairingClient([open, open]);
    const done = runCli(["pair"], deps(io, client));
    await flush();
    client.drop();
    expect(await done).toBe(1);
    expect(io.errLines.at(-1)).toBe(CLI_MESSAGES.connectionLost("en"));
  });

  it("polls at PAIR_POLL_MS", () => {
    expect(PAIR_POLL_MS).toBe(1_000);
  });
});

// --- other commands --------------------------------------------------------

describe("status, devices, revoke, sign-out-all, web, stop", () => {
  it("status shows the owner password state", async () => {
    const io = fakeIo({});
    const client = fakeClient((channel) =>
      channel === "remote:status"
        ? remoteStatus({ problem: "no-owner-password", listening: undefined })
        : { hasPassword: false, passkeys: [] },
    );
    expect(await runCli(["status"], deps(io, client))).toBe(0);
    const text = io.outLines.join("\n");
    expect(text).toContain(CLI_MESSAGES.daemonRunning("en"));
    expect(text).toContain(MESSAGES.remoteOwnerNoPassword("en"));
    expect(text).toContain(MESSAGES.remoteProblem("no-owner-password", "en"));
  });

  it("revoke passes the id and reports a refusal", async () => {
    const io = fakeIo({});
    const client = fakeClient(() => ({ ok: true, value: undefined }));
    expect(await runCli(["revoke", "dev-1"], deps(io, client))).toBe(0);
    expect(client.calls).toEqual([{ channel: "remote:revoke", args: ["dev-1"] }]);

    const failIo = fakeIo({});
    const failing = fakeClient(() => ({ ok: false, text: "Could not revoke.", language: "en" }));
    expect(await runCli(["revoke", "dev-1"], deps(failIo, failing))).toBe(1);
    expect(failIo.errLines).toEqual(["Could not revoke."]);
  });

  it("sign-out-all asks y/N unless --yes", async () => {
    const declined = fakeClient(() => undefined);
    expect(await runCli(["sign-out-all"], deps(fakeIo({ lines: ["n"] }), declined))).toBe(1);
    expect(declined.calls).toEqual([]);

    const accepted = fakeClient(() => undefined);
    expect(await runCli(["sign-out-all"], deps(fakeIo({ lines: ["y"] }), accepted))).toBe(0);
    expect(accepted.calls).toEqual([{ channel: "remote:signOutEverywhere", args: [] }]);

    const io = fakeIo({});
    const forced = fakeClient(() => undefined);
    expect(await runCli(["sign-out-all", "--yes"], deps(io, forced))).toBe(0);
    expect(io.prompts).toEqual([]);
    expect(forced.calls).toEqual([{ channel: "remote:signOutEverywhere", args: [] }]);
  });

  it("web on|off saves the whole config with only remote.web.enabled changed", async () => {
    const config = {
      language: "en",
      remote: { enabled: true, port: 7717, web: { enabled: false, port: 9000 } },
    };
    const io = fakeIo({});
    const client = fakeClient((channel) => (channel === "settings:read" ? config : { ok: true }));
    expect(await runCli(["web", "on"], deps(io, client))).toBe(0);
    expect(client.calls[1]).toEqual({
      channel: "settings:save",
      args: [{ ...config, remote: { ...config.remote, web: { enabled: true, port: 9000 } } }],
    });
    expect(config.remote.web.enabled).toBe(false);
    expect(io.outLines).toEqual([CLI_MESSAGES.webSaved(true, "en")]);

    const failIo = fakeIo({});
    const failing = fakeClient((channel) =>
      channel === "settings:read"
        ? config
        : { ok: false, text: "Invalid settings.", detail: "remote.web.port", language: "en" },
    );
    expect(await runCli(["web", "off"], deps(failIo, failing))).toBe(1);
    expect(failIo.errLines).toEqual(["Invalid settings. remote.web.port"]);
  });

  it("stop sends daemon:stop and waits for the connection to close", async () => {
    const io = fakeIo({});
    const client = fakeClient((channel) => {
      if (channel === "daemon:stop") setTimeout(() => client.drop(), 0);
      return { stopping: true };
    });
    expect(await runCli(["stop"], deps(io, client))).toBe(0);
    expect(client.calls).toEqual([{ channel: "daemon:stop", args: [] }]);
    expect(io.outLines).toEqual([CLI_MESSAGES.stopping("en"), CLI_MESSAGES.stopped("en")]);
  });
});

// --- formatting -----------------------------------------------------------

describe("devices table", () => {
  const device = (overrides: Partial<RemoteStatus["devices"][number]>) => ({
    id: "d1",
    name: "Phone",
    pairedAt: Date.UTC(2026, 8, 1, 10, 0),
    lastSeenAt: undefined,
    connected: false,
    ...overrides,
  });

  it("strips control and bidi characters from an untrusted name", () => {
    const text = formatDevices(
      [
        device({ id: "d1", name: "Bad\u001b[31mName\u0007\r\n\u202eX\u2066", client: "web" }),
        device({ id: "d2", name: "Tablet", connected: true, lastSeenAt: Date.UTC(2026, 8, 2) }),
      ],
      "en",
    );
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point.
      expect(line).not.toMatch(/[\u0000-\u001f\u007f\u202e\u2066]/);
    }
    const [header, first, second] = lines;
    expect(header).toMatch(/^ID\s+NAME\s+CLIENT\s+STATE\s+PAIRED\s+LAST SEEN$/);
    expect(first).toContain("Bad[31mNameX");
    expect(first).toContain(MESSAGES.remoteWebDeviceClient("web", "en"));
    expect(first).toContain(CLI_MESSAGES.never("en"));
    expect(second).toContain(MESSAGES.remoteWebDeviceClient("app", "en"));
    expect(second).toContain(MESSAGES.remoteDeviceConnected("en"));
    expect(second).toContain(formatTime(Date.UTC(2026, 8, 2)));
    // Columns line up: every row's CLIENT cell starts at the same offset.
    const clientAt = header!.indexOf("CLIENT");
    expect(first!.slice(clientAt).startsWith("Browser")).toBe(true);
    expect(second!.slice(clientAt).startsWith("App")).toBe(true);
  });

  it("truncates a very long name and says so when nothing is paired", () => {
    expect(terminalSafe("x".repeat(100), 40)).toBe(`${"x".repeat(39)}…`);
    expect(formatDevices([], "en")).toBe(MESSAGES.remoteNoDevices("en"));
  });
});

describe("terminal QR", () => {
  it("draws a fixed matrix as exact half-blocks", () => {
    const qr = {
      size: 3,
      modules: [
        [true, false, true],
        [true, true, false],
        [false, true, false],
      ],
    };
    expect(qrToBlocks(qr, 1)).toEqual([
      "\u001b[30;107m \u2584 \u2584 \u001b[0m",
      "\u001b[30;107m \u2580\u2588  \u001b[0m",
      "\u001b[30;107m     \u001b[0m",
    ]);
  });

  it("is deterministic for a fixed string and decodes back to the encoder's modules", () => {
    const text = "jarvis://pair?v=2&host=127.0.0.1&port=7717";
    const qr = encodeQr(text);
    const lines = qrToBlocks(qr);
    expect(qrToBlocks(encodeQr(text))).toEqual(lines);
    const quiet = 2;
    const width = qr.size + quiet * 2;
    expect(lines).toHaveLength(Math.ceil(width / 2));
    for (const [index, line] of lines.entries()) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the colour escapes is the point.
      const cells = [...line.replace(/\u001b\[[0-9;]*m/g, "")];
      expect(cells).toHaveLength(width);
      for (const [column, cell] of cells.entries()) {
        const top = qr.modules[index * 2 - quiet]?.[column - quiet] === true;
        const bottom = qr.modules[index * 2 + 1 - quiet]?.[column - quiet] === true;
        expect(cell).toBe(top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ");
      }
    }
  });
});
