import { CLOSE, PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import type { PairingLink } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import { PAIR_CONNECT_TIMEOUT_MS, needsHost, pair, pairWithFallback, withHost } from "./pairing";
import type { PairOutcome } from "./pairing";
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
    deps: { transport, clock, client: CLIENT_STRING },
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
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: "fingerprint",
      detail: "invalid fingerprint",
    });
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
    await expect(promise).resolves.toEqual({
      ok: false,
      reason: "unreachable",
      detail: "connection refused",
    });
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
    "maps no `open` within PAIR_CONNECT_TIMEOUT_MS of the call to unreachable " +
      "[bite-proof: drop the pre-open deadline and this test times out instead of resolving]",
    async () => {
      const { transport, clock, deps } = setup();
      const promise = pair(deps, LINK, DEVICE_NAME);
      // No socket.emit({kind: "open"}) at all — the transport never connects.
      clock.advance(PAIR_CONNECT_TIMEOUT_MS - 1);
      const socket = latestSocket(transport);
      expect(socket.closedWith).toBeUndefined();

      clock.advance(1);
      await expect(promise).resolves.toEqual({
        ok: false,
        reason: "unreachable",
        detail: `no connection within ${PAIR_CONNECT_TIMEOUT_MS / 1000}s`,
      });
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
      const promise = pair({ transport, clock, client: CLIENT_STRING }, LINK, DEVICE_NAME).then(
        (o) => {
          settled = true;
          outcome = o;
          return o;
        },
      );

      // If the pre-open deadline were armed unconditionally after
      // `transport.open()` returns, it would silently replace the 75s
      // post-open timer that the synchronous `open` handler already armed
      // — advancing past the 5s mark would then wrongly settle
      // "unreachable" even though pairing had already moved past "open".
      clock.advance(PAIR_CONNECT_TIMEOUT_MS);
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

      pair({ transport, clock, client: CLIENT_STRING }, LINK, DEVICE_NAME);
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

describe("pairWithFallback (iOS sideload fix: pinned-IP fallback + detail)", () => {
  const NAMED_LINK: PairingLink = { ...LINK, name: "laptop.tailfee19e.ts.net" };
  const PAIRED_REPLY = encodeMessage({
    t: "paired",
    v: PROTOCOL_VERSION,
    deviceId: "d".repeat(32),
    token: "T".repeat(43),
  });

  function failUnopened(socket: FakeSocket, message: string): void {
    socket.emit({ kind: "error", message });
    socket.emit({ kind: "close", code: 1006, reason: "" });
  }

  it("a by-name dial that dies unreached retries pinned by IP and stores a record without name", async () => {
    const { transport, deps } = setup();
    const promise = pairWithFallback(deps, NAMED_LINK, DEVICE_NAME);
    failUnopened(latestSocket(transport), "TLS handshake failed");
    await Promise.resolve();
    await Promise.resolve();

    expect(transport.sockets).toHaveLength(2);
    const second = latestSocket(transport);
    expect(second.url).toBe(`wss://${LINK.host}:${LINK.port}/pair`);
    expect(second.trust).toEqual({ kind: "pin", fingerprint: LINK.fingerprint });

    second.emit({ kind: "open" });
    second.emit({ kind: "message", text: PAIRED_REPLY });
    const outcome = await promise;
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.record.name).toBeUndefined();
    expect(outcome.record.host).toBe(LINK.host);
  });

  it("never falls back when the server was reached (denied consumed the secret)", async () => {
    const { transport, deps } = setup();
    const promise = pairWithFallback(deps, NAMED_LINK, DEVICE_NAME);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({ kind: "close", code: CLOSE.pairingDenied, reason: "" });

    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "denied" });
    expect(transport.sockets).toHaveLength(1);
  });

  it("never falls back on a link without a name", async () => {
    const { transport, deps } = setup();
    const promise = pairWithFallback(deps, LINK, DEVICE_NAME);
    failUnopened(latestSocket(transport), "connrefused");
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "unreachable" });
    expect(transport.sockets).toHaveLength(1);
  });

  it("both paths dead: reports the by-name failure with its transport detail", async () => {
    const { transport, deps } = setup();
    const promise = pairWithFallback(deps, NAMED_LINK, DEVICE_NAME);
    failUnopened(latestSocket(transport), "The certificate for this server is invalid");
    await Promise.resolve();
    await Promise.resolve();
    failUnopened(latestSocket(transport), "connrefused");
    const outcome = await promise;
    expect(outcome).toMatchObject({
      ok: false,
      reason: "unreachable",
      detail: "The certificate for this server is invalid",
    });
  });

  it("a fallback fingerprint mismatch always surfaces over the by-name failure", async () => {
    const { transport, deps } = setup();
    const promise = pairWithFallback(deps, NAMED_LINK, DEVICE_NAME);
    failUnopened(latestSocket(transport), "stall");
    await Promise.resolve();
    await Promise.resolve();
    const second = latestSocket(transport);
    second.emit({ kind: "close", code: 1006, reason: "fingerprint" });
    const outcome = await promise;
    expect(outcome).toMatchObject({ ok: false, reason: "fingerprint" });
  });
});
