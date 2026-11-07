import { CLOSE, HANDSHAKE_TIMEOUT_MS, PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import type { PairingLink } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import { FakeKeychain } from "./fake-machines";
import {
  JOINED_FINGERPRINT,
  JOINED_HOST,
  JOIN_WAIT_MS,
  joinMachine,
  linkRefusedOn,
  needsHost,
  pair,
  withHost,
} from "./pairing";
import type { JoinOutcome, PairOutcome } from "./pairing";
import { loadPairingAt, savePairingAt } from "./pairing-record";
import type { Transport, TransportEvent, TransportSocket } from "./transport";

const LINK: PairingLink = {
  host: "192.168.1.5",
  port: 4317,
  secret: "s".repeat(43),
  fingerprint: "a".repeat(64),
};
const CLIENT_STRING = "jarvis-mobile/1.0.0/ios";
const DEVICE_NAME = "Aziz's iPhone";

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function setup() {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  return {
    transport,
    clock,
    deps: { transport, clock, client: CLIENT_STRING, platform: "native" as const },
  };
}

describe("pair", () => {
  it("sends exactly one pair frame on open and resolves ok on a valid paired reply, closing 1000", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);

    socket.emit({ kind: "open" });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      t: "pair",
      v: PROTOCOL_VERSION,
      secret: LINK.secret,
      deviceName: DEVICE_NAME,
      client: CLIENT_STRING,
    });
    expect(socket.url).toBe(`wss://${LINK.host}:${LINK.port}/pair`);
    expect(socket.trust).toEqual({ kind: "pin", fingerprint: LINK.fingerprint });

    const deviceId = "d".repeat(32);
    const token = "T".repeat(43);
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "paired", v: PROTOCOL_VERSION, deviceId, token }),
    });

    const outcome = await promise;
    expect(outcome).toEqual({
      ok: true,
      record: {
        deviceId,
        host: LINK.host,
        port: LINK.port,
        fingerprint: LINK.fingerprint,
        pairedAt: 0,
      },
      credential: { deviceId, token },
    });
    expect(socket.closedWith).toEqual({ code: 1000, reason: "paired" });
  });

  it("maps close 4403 to denied", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: CLOSE.pairingDenied, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "denied" });
  });

  it("maps close 4401 to expired", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: CLOSE.unauthorized, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("maps close 4408 to timeout", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: CLOSE.handshakeTimeout, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("maps a close with reason fingerprint to fingerprint, even before open", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "error", message: "invalid fingerprint" });
    socket.emit({ kind: "close", code: 1006, reason: "fingerprint" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "fingerprint" });
  });

  it("maps a close (any code) before open to unreachable", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "close", code: 1006, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("maps an error before open (no fingerprint reason) followed by close to unreachable", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "error", message: "connection refused" });
    socket.emit({ kind: "close", code: 1006, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("maps a malformed paired frame (bad deviceId) to protocol", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "paired",
        v: PROTOCOL_VERSION,
        deviceId: "not-hex",
        token: "T".repeat(43),
      }),
    });
    await expect(promise).resolves.toEqual({ ok: false, reason: "protocol" });
    expect(socket.closedWith?.code).toBe(1000);
  });

  it("maps any other close code after open to protocol", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: 1011, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "protocol" });
  });

  it("ignores a second frame after paired", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    const deviceId = "d".repeat(32);
    const token = "T".repeat(43);
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "paired", v: PROTOCOL_VERSION, deviceId, token }),
    });
    // A second, different frame must not change the already-settled outcome.
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "paired", v: PROTOCOL_VERSION, deviceId: "e".repeat(32), token }),
    });
    const outcome = await promise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record.deviceId).toBe(deviceId);
    }
  });

  it(
    "bite-proof: times out and closes the socket when no frame arrives within 75000ms of open " +
      "(dropping the timer would leave the promise unsettled)",
    async () => {
      const { transport, clock, deps } = setup();
      let settled = false;
      const promise = pair(deps, LINK, DEVICE_NAME).then((outcome) => {
        settled = true;
        return outcome;
      });
      const socket = latestSocket(transport);
      socket.emit({ kind: "open" });

      clock.advance(74_999);
      expect(settled).toBe(false);

      clock.advance(1);
      const outcome = await promise;
      expect(settled).toBe(true);
      expect(outcome).toEqual({ ok: false, reason: "timeout" });
      expect(socket.closedWith).toBeDefined();
    },
  );

  it(
    "does not put the secret anywhere on the resolved outcome " +
      "[bite-proof: return link inside record and this fails]",
    async () => {
      const { transport, deps } = setup();
      const promise = pair(deps, LINK, DEVICE_NAME);
      const socket = latestSocket(transport);
      socket.emit({ kind: "open" });
      const deviceId = "d".repeat(32);
      const token = "T".repeat(43);
      socket.emit({
        kind: "message",
        text: encodeMessage({ t: "paired", v: PROTOCOL_VERSION, deviceId, token }),
      });
      const outcome = await promise;
      expect(JSON.stringify(outcome)).not.toContain(LINK.secret);
    },
  );

  it("maps a paired frame with the wrong protocol version to protocol", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "paired",
        v: PROTOCOL_VERSION + 1,
        deviceId: "d".repeat(32),
        token: "T".repeat(43),
      }),
    });
    await expect(promise).resolves.toEqual({ ok: false, reason: "protocol" });
  });

  it(
    "maps no `open` within HANDSHAKE_TIMEOUT_MS of the call to unreachable " +
      "[bite-proof: drop the pre-open deadline and this test times out instead of resolving]",
    async () => {
      const { transport, clock, deps } = setup();
      const promise = pair(deps, LINK, DEVICE_NAME);
      // No socket.emit({kind: "open"}) at all — the transport never connects.
      clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
      const socket = latestSocket(transport);
      expect(socket.closedWith).toBeUndefined();

      clock.advance(1);
      await expect(promise).resolves.toEqual({ ok: false, reason: "unreachable" });
      expect(socket.closedWith).toBeDefined();
    },
  );

  it(
    "does not let a synchronous open() clobber the post-open wait timer with the pre-open deadline " +
      "[bite-proof: remove the `if (!opened)` guard around the pre-open timer and this test fails]",
    async () => {
      const clock = createFakeClock();
      let onEventRef: ((event: TransportEvent) => void) | undefined;
      const transport: Transport = {
        open(_url, _fingerprint, onEvent) {
          onEventRef = onEvent;
          const socket: TransportSocket = {
            send() {
              // Nothing to assert here: `pair()`'s own `socket` variable
              // isn't assigned yet at this point (see the comment below),
              // so this call can't be reached — the point of this test.
            },
            sendBinary() {
              // Unused by /pair — pairing never uploads a blob.
            },
            close() {
              // no-op for this test
            },
          };
          // Unlike every real transport today (native-transport.ts's
          // module always delivers `open` asynchronously), fire `open`
          // synchronously — before this function even returns the socket
          // to `pair()`, so `pair()`'s own `socket` variable is not yet
          // assigned when its "open" handler runs.
          onEvent({ kind: "open" });
          return socket;
        },
      };

      let settled = false;
      let outcome: PairOutcome | undefined;
      const promise = pair(
        { transport, clock, client: CLIENT_STRING, platform: "native" as const },
        LINK,
        DEVICE_NAME,
      ).then((o) => {
        settled = true;
        outcome = o;
        return o;
      });

      // If the pre-open deadline were armed unconditionally after
      // `transport.open()` returns, it would silently replace the 75s
      // post-open timer that the synchronous `open` handler already armed
      // — advancing past the 5s mark would then wrongly settle
      // "unreachable" even though pairing had already moved past "open".
      clock.advance(HANDSHAKE_TIMEOUT_MS);
      expect(settled).toBe(false);

      // The state machine is still coherent afterwards: once `deps.transport.open()`
      // has returned and `socket` is assigned, a close settles through the
      // normal post-open path, not the pre-open "unreachable" one.
      onEventRef?.({ kind: "close", code: 1011, reason: "" });
      await promise;
      expect(settled).toBe(true);
      expect(outcome).toEqual({ ok: false, reason: "protocol" });
    },
  );

  it(
    "does not resend (or send an empty secret) if `open` fires more than once " +
      '[bite-proof: send secret ?? "" again instead of returning early and this test fails]',
    async () => {
      const clock = createFakeClock();
      const sent: string[] = [];
      let capturedOnEvent: ((event: TransportEvent) => void) | undefined;
      const transport: Transport = {
        open(_url, _fingerprint, onEvent) {
          capturedOnEvent = onEvent;
          return {
            send(text) {
              sent.push(text);
            },
            sendBinary() {
              // Unused by /pair — pairing never uploads a blob.
            },
            close() {
              // no-op for this test
            },
          };
        },
      };

      pair(
        { transport, clock, client: CLIENT_STRING, platform: "native" as const },
        LINK,
        DEVICE_NAME,
      );
      capturedOnEvent?.({ kind: "open" });
      // A hypothetical buggy transport re-firing `open` after the first —
      // none of ours does this today, but `pair()` must not resend.
      capturedOnEvent?.({ kind: "open" });

      expect(sent).toHaveLength(1);
      expect((JSON.parse(sent[0]) as { secret: string }).secret).toBe(LINK.secret);
    },
  );
});

describe("pair: system-trust mode (M11 rulings.md 1)", () => {
  const NAMED_LINK: PairingLink = { ...LINK, name: "mac.tail.ts.net" };

  it("pairs over wss://<name>:<port>/pair with system trust when the link carries a name", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, NAMED_LINK, DEVICE_NAME);
    const socket = latestSocket(transport);

    expect(socket.url).toBe(`wss://${NAMED_LINK.name}:${NAMED_LINK.port}/pair`);
    expect(socket.trust).toEqual({ kind: "system" });

    socket.emit({ kind: "open" });
    const deviceId = "d".repeat(32);
    const token = "T".repeat(43);
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "paired", v: PROTOCOL_VERSION, deviceId, token }),
    });

    const outcome = await promise;
    expect(outcome).toEqual({
      ok: true,
      record: {
        deviceId,
        host: NAMED_LINK.host,
        port: NAMED_LINK.port,
        fingerprint: NAMED_LINK.fingerprint,
        name: NAMED_LINK.name,
        pairedAt: 0,
      },
      credential: { deviceId, token },
    });
  });

  it("dials by host/pin, and the record carries no `name`, when the link has none", async () => {
    const { transport, deps } = setup();
    const promise = pair(deps, LINK, DEVICE_NAME);
    const socket = latestSocket(transport);

    expect(socket.url).toBe(`wss://${LINK.host}:${LINK.port}/pair`);
    expect(socket.trust).toEqual({ kind: "pin", fingerprint: LINK.fingerprint });

    socket.emit({ kind: "open" });
    const deviceId = "d".repeat(32);
    const token = "T".repeat(43);
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "paired", v: PROTOCOL_VERSION, deviceId, token }),
    });

    const outcome = await promise;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record).not.toHaveProperty("name");
    }
  });
});

describe("needsHost", () => {
  it("is true for 0.0.0.0", () => {
    expect(needsHost({ ...LINK, host: "0.0.0.0" })).toBe(true);
  });

  it("is true for ::", () => {
    expect(needsHost({ ...LINK, host: "::" })).toBe(true);
  });

  it("is false for a concrete address", () => {
    expect(needsHost(LINK)).toBe(false);
  });

  it(
    "is false for an unspecified host once `name` is set (M11 rulings.md 1) " +
      "[bite-proof: drop the `link.name !== undefined` short-circuit and this fails]",
    () => {
      expect(needsHost({ ...LINK, host: "0.0.0.0", name: "mac.tail.ts.net" })).toBe(false);
    },
  );
});

describe("withHost", () => {
  it("substitutes a valid IPv4 literal", () => {
    const result = withHost(LINK, "192.168.1.10");
    expect(result).toEqual({ ...LINK, host: "192.168.1.10" });
  });

  it("returns undefined for a hostname", () => {
    expect(withHost(LINK, "laptop.local")).toBeUndefined();
  });

  it("substitutes a valid IPv6 literal, canonicalised", () => {
    const result = withHost(LINK, "2001:0db8::0001");
    expect(result).toEqual({ ...LINK, host: "2001:db8::1" });
  });

  it("returns undefined for 0.0.0.0 (still unspecified, not a dialable host)", () => {
    expect(withHost(LINK, "0.0.0.0")).toBeUndefined();
  });

  it("returns undefined for :: (still unspecified, not a dialable host)", () => {
    expect(withHost(LINK, "::")).toBeUndefined();
  });
});

describe("linkRefusedOn (Task 13: the browser build needs a real certificate)", () => {
  it("refuses a fingerprint-only link (no name) on web", () => {
    expect(linkRefusedOn(LINK, "web")).toBe(true);
  });

  it("accepts a link with a name on web, and every link on native", () => {
    expect(linkRefusedOn({ ...LINK, name: "laptop.tail1234.ts.net" }, "web")).toBe(false);
    expect(linkRefusedOn(LINK, "native")).toBe(false);
  });
});

describe("pair on web", () => {
  it("resolves web-needs-certificate for a fingerprint-only link without ever opening a socket", async () => {
    const transport = createFakeTransport();
    const clock = createFakeClock();
    const outcome = await pair(
      { transport, clock, client: "web", platform: "web" },
      LINK,
      DEVICE_NAME,
    );
    expect(outcome).toEqual({ ok: false, reason: "web-needs-certificate" });
    expect(transport.sockets).toHaveLength(0);
  });

  it('dials a named link through system trust and sends client "web"', () => {
    const transport = createFakeTransport();
    const clock = createFakeClock();
    const name = "laptop.tail1234.ts.net";
    void pair({ transport, clock, client: "web", platform: "web" }, { ...LINK, name }, DEVICE_NAME);
    const socket = latestSocket(transport);
    expect(socket.url).toBe(`wss://${name}:${LINK.port}/pair`);
    expect(socket.trust).toEqual({ kind: "system" });
    socket.emit({ kind: "open" });
    expect(JSON.parse(socket.sent[0]).client).toBe("web");
  });
});

describe("joinMachine", () => {
  const ADDRESS = { name: "mac.tail1234.ts.net", port: 7717 };
  const PASSWORD = "correct horse battery staple";
  const DEVICE_ID = "d".repeat(32);
  const TOKEN = "T".repeat(43);
  const TOKENS = {
    accessToken: "a".repeat(64),
    refreshToken: "b".repeat(64),
    accessExpiresAt: 900_000,
  };
  const JOINED = {
    t: "joined",
    v: PROTOCOL_VERSION,
    deviceId: DEVICE_ID,
    token: TOKEN,
    tokens: TOKENS,
  };

  function start() {
    const { transport, deps, clock } = setup();
    const promise = joinMachine(deps, ADDRESS, PASSWORD, DEVICE_NAME);
    return { promise, socket: latestSocket(transport), clock, transport };
  }

  function expectNoPassword(outcome: JoinOutcome): void {
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD);
  }

  it("names the joined record's constants and its wait", () => {
    expect(JOINED_HOST).toBe("0.0.0.0");
    expect(JOINED_FINGERPRINT).toBe("0".repeat(64));
    expect(JOIN_WAIT_MS).toBe(30_000);
  });

  it("dials /pair by name with system trust, and sends nothing before open", () => {
    const { socket } = start();
    expect(socket.url).toBe("wss://mac.tail1234.ts.net:7717/pair");
    expect(socket.trust).toEqual({ kind: "system" });
    expect(socket.sent).toEqual([]);
  });

  it("sends exactly one frame with the given fields", () => {
    const { socket } = start();
    socket.emit({ kind: "open" });
    expect(socket.sent.map((text) => JSON.parse(text))).toEqual([
      {
        t: "join",
        v: PROTOCOL_VERSION,
        password: PASSWORD,
        deviceName: DEVICE_NAME,
        client: CLIENT_STRING,
      },
    ]);
  });

  it("never sends a second frame on a repeated open", () => {
    const { socket } = start();
    socket.emit({ kind: "open" });
    socket.emit({ kind: "open" });
    expect(socket.sent).toHaveLength(1);
  });

  it("a repeated open does not put the wait back", async () => {
    const { socket, clock, promise } = start();
    socket.emit({ kind: "open" });
    clock.advance(JOIN_WAIT_MS - 1);
    socket.emit({ kind: "open" });
    clock.advance(1);
    await expect(promise).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("joined answers a record a store can read back, and the tokens", async () => {
    const { socket, promise } = start();
    socket.emit({ kind: "open" });
    socket.emit({ kind: "message", text: JSON.stringify(JOINED) });

    const outcome = await promise;
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.record).toEqual({
      deviceId: DEVICE_ID,
      host: JOINED_HOST,
      port: 7717,
      fingerprint: JOINED_FINGERPRINT,
      name: "mac.tail1234.ts.net",
      pairedAt: 0,
      laptopName: "mac",
    });
    expect(outcome.credential).toEqual({ deviceId: DEVICE_ID, token: TOKEN });
    expect(outcome.tokens).toEqual(TOKENS);
    expect(socket.closedWith).toEqual({ code: CLOSE.normal, reason: "joined" });
    expectNoPassword(outcome);

    // parseRecord is what reads a record back.
    const keychain = new FakeKeychain();
    const keys = { record: "r", token: "t" };
    await savePairingAt(keychain, keys, outcome.record, outcome.credential);
    expect(await loadPairingAt(keychain, keys)).toEqual({
      record: outcome.record,
      credential: outcome.credential,
    });
  });

  it("4401 answers refused", async () => {
    const { socket, promise } = start();
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: CLOSE.unauthorized, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "refused" });
  });

  it("4429 answers rate-limited", async () => {
    const { socket, promise } = start();
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: CLOSE.tooManyRequests, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "rate-limited" });
  });

  it("a close before open answers unreachable, and nothing was sent", async () => {
    const { socket, promise } = start();
    socket.emit({ kind: "close", code: 1006, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "unreachable" });
    expect(socket.sent).toEqual([]);
  });

  it("no open within the handshake time answers unreachable and closes", async () => {
    const { socket, clock, promise } = start();
    clock.advance(HANDSHAKE_TIMEOUT_MS);
    await expect(promise).resolves.toEqual({ ok: false, reason: "unreachable" });
    expect(socket.closedWith).toBeDefined();
    socket.emit({ kind: "open" });
    expect(socket.sent).toEqual([]);
  });

  it("a transport that throws answers unreachable, with nothing of the error", async () => {
    const { deps } = setup();
    const outcome = await joinMachine(
      {
        ...deps,
        transport: {
          open() {
            throw new Error(`could not dial with ${PASSWORD}`);
          },
        },
      },
      ADDRESS,
      PASSWORD,
      DEVICE_NAME,
    );
    expect(outcome).toEqual({ ok: false, reason: "unreachable" });
    expectNoPassword(outcome);
  });

  it("a send that throws answers unreachable, with nothing of the error", async () => {
    const { socket, promise } = start();
    socket.send = () => {
      throw new Error(`could not send ${PASSWORD}`);
    };
    socket.emit({ kind: "open" });
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, reason: "unreachable" });
    expectNoPassword(outcome);
  });

  it("silence past 30 s answers timeout and closes, and not a moment before", async () => {
    const { socket, clock, promise } = start();
    socket.emit({ kind: "open" });
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    clock.advance(JOIN_WAIT_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    await expect(promise).resolves.toEqual({ ok: false, reason: "timeout" });
    expect(socket.closedWith).toBeDefined();
  });

  it("a connection lost after open answers unreachable", async () => {
    const { socket, promise } = start();
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: 1006, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("a target that closes for any other reason answers protocol", async () => {
    const { socket, promise } = start();
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: CLOSE.badFrame, reason: "" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "protocol" });
  });

  it.each<[string, string]>([
    ["not JSON", "nope"],
    ["a paired frame", JSON.stringify({ ...JOINED, t: "paired" })],
    ["a bad deviceId", JSON.stringify({ ...JOINED, deviceId: "nope" })],
    ["a bad token", JSON.stringify({ ...JOINED, token: "short" })],
    ["a wrong v", JSON.stringify({ ...JOINED, v: PROTOCOL_VERSION + 1 })],
    ["no tokens", JSON.stringify({ ...JOINED, tokens: undefined })],
    ["tokens not an object", JSON.stringify({ ...JOINED, tokens: "x" })],
    [
      "a bad access token",
      JSON.stringify({ ...JOINED, tokens: { ...TOKENS, accessToken: "A".repeat(64) } }),
    ],
    [
      "a bad refresh token",
      JSON.stringify({ ...JOINED, tokens: { ...TOKENS, refreshToken: "short" } }),
    ],
    [
      "a bad expiry",
      JSON.stringify({ ...JOINED, tokens: { ...TOKENS, accessExpiresAt: "later" } }),
    ],
  ])("%s answers protocol and closes", async (_label, text) => {
    const { socket, promise } = start();
    socket.emit({ kind: "open" });
    socket.emit({ kind: "message", text });
    const outcome = await promise;
    expect(outcome).toEqual({ ok: false, reason: "protocol" });
    expect(socket.closedWith).toBeDefined();
    expectNoPassword(outcome);
  });
});
