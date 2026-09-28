import { describe, expect, it } from "vitest";
import { AUTH_CHANNELS } from "@jarvis/wire";
import {
  CLOSE,
  type ClientMessage,
  encodeMessage,
  formatPairingUri,
  type PairingLink,
  parseClientMessage,
  parseAuthArgs,
  parsePairingUri,
  parsePairMessage,
} from "./protocol.js";

// Fixed valid values reused across fixtures below, each satisfying exactly
// one pattern from protocol.ts: a 32-char lowercase-hex device id, a
// 43-char token/secret (SECRET_PATTERN), and a 64-char lowercase-hex
// fingerprint.
const DEVICE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "A".repeat(43);
const FINGERPRINT = "0123456789abcdef".repeat(4);

describe("parseClientMessage", () => {
  const wellFormed: [string, ClientMessage][] = [
    ["hello", { t: "hello", v: 1, deviceId: DEVICE_ID, token: TOKEN, client: "ios-1.0" }],
    ["req", { t: "req", id: 1, ch: "remote:decidePair", a: [1, "two", null] }],
    ["sub with keys", { t: "sub", add: ["remote:update"], drop: ["remote:old"] }],
    ["sub without keys", { t: "sub" }],
    [
      "sub with keyed targets",
      {
        t: "sub",
        add: ["metrics:update", { ch: "terminal:data", key: "tab-1" }],
        drop: ["metrics:update", { ch: "terminal:data", key: "tab-1" }],
      },
    ],
    ["blob", { t: "blob", id: 2, ch: "files:upload", a: ["name.txt"], bytes: 1024, chunks: 4 }],
    ["pong", { t: "pong", seq: 7 }],
    ["bye", { t: "bye" }],
  ];

  it.each(wellFormed)("parses a well-formed %s frame to an equal object", (_label, message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each<[string, string, number | undefined]>([
    ["{", "{", undefined],
    ["[]", "[]", undefined],
    ["unknown t with id 1", JSON.stringify({ t: "nope", id: 1 }), 1],
    ["req with no id", JSON.stringify({ t: "req", ch: "remote:decidePair", a: [] }), undefined],
    [
      "fractional id",
      JSON.stringify({ t: "req", id: 1.5, ch: "remote:decidePair", a: [] }),
      undefined,
    ],
    ["a:{} with id 2", JSON.stringify({ t: "req", id: 2, ch: "remote:decidePair", a: {} }), 2],
    ['ch:"__proto__" with id 3', JSON.stringify({ t: "req", id: 3, ch: "__proto__", a: [] }), 3],
    ["80-char channel", JSON.stringify({ t: "req", id: 4, ch: `a${"b".repeat(77)}:c`, a: [] }), 4],
    ['sub add:["../x"]', JSON.stringify({ t: "sub", add: ["../x"] }), undefined],
    [
      "sub target missing key",
      JSON.stringify({ t: "sub", add: [{ ch: "terminal:data" }] }),
      undefined,
    ],
    [
      'sub target key:"a b"',
      JSON.stringify({ t: "sub", add: [{ ch: "terminal:data", key: "a b" }] }),
      undefined,
    ],
    [
      "sub target key:7",
      JSON.stringify({ t: "sub", add: [{ ch: "terminal:data", key: 7 }] }),
      undefined,
    ],
    [
      'sub target ch:"__proto__"',
      JSON.stringify({ t: "sub", add: [{ ch: "__proto__", key: "tab-1" }] }),
      undefined,
    ],
    [
      "sub with 65 targets",
      JSON.stringify({ t: "sub", add: Array(65).fill("remote:update") }),
      undefined,
    ],
    ["sub target null", JSON.stringify({ t: "sub", add: [null] }), undefined],
    [
      "hello with short token",
      JSON.stringify({ t: "hello", v: 1, deviceId: DEVICE_ID, token: "short", client: "x" }),
      undefined,
    ],
    [
      "hello with upper-case deviceId",
      JSON.stringify({
        t: "hello",
        v: 1,
        deviceId: DEVICE_ID.toUpperCase(),
        token: TOKEN,
        client: "x",
      }),
      undefined,
    ],
    ["pong without seq", JSON.stringify({ t: "pong" }), undefined],
    // Ruling P1: hello.v must be a non-negative safe integer; a stringified
    // "1" is not one, even though it round-trips through JSON.
    [
      'hello with v:"1"',
      JSON.stringify({ t: "hello", v: "1", deviceId: DEVICE_ID, token: TOKEN, client: "x" }),
      undefined,
    ],
  ])("treats %s as invalid", (_label, text, id) => {
    expect(parseClientMessage(text)).toEqual({ t: "invalid", id });
  });

  it("rejects a frame over MAX_TEXT_FRAME_BYTES, discarding even a well-formed id", () => {
    const text = JSON.stringify({
      t: "req",
      id: 1,
      ch: "remote:decidePair",
      a: ["x".repeat(1_048_576)],
    });
    expect(parseClientMessage(text)).toEqual({ t: "invalid", id: undefined });
  });

  it("rebuilds the message rather than returning the parsed object, so an own __proto__ key goes nowhere [bite-proof]", () => {
    const text = '{"t":"req","id":5,"ch":"remote:decidePair","a":[],"__proto__":{"polluted":true}}';
    const result = parseClientMessage(text);
    expect(Object.keys(result)).toEqual(["t", "id", "ch", "a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rebuilds a sub target so extra keys and an own __proto__ go nowhere [bite-proof: return the parsed target object]", () => {
    const text =
      '{"t":"sub","add":[{"ch":"terminal:data","key":"tab-1","__proto__":{"polluted":1},"extra":1}]}';
    const result = parseClientMessage(text) as Extract<ClientMessage, { t: "sub" }>;
    const target = result.add?.[0];
    expect(target).toEqual({ ch: "terminal:data", key: "tab-1" });
    expect(Object.keys(target as object)).toEqual(["ch", "key"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("parsePairMessage", () => {
  it("parses a well-formed pair frame", () => {
    const message = {
      t: "pair" as const,
      v: 1,
      secret: TOKEN,
      deviceName: "Phone",
      client: "ios-1.0",
    };
    expect(parsePairMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each<[string, string]>([
    [
      "a hello",
      JSON.stringify({ t: "hello", v: 1, deviceId: DEVICE_ID, token: TOKEN, client: "x" }),
    ],
    [
      "a short secret",
      JSON.stringify({ t: "pair", v: 1, secret: "short", deviceName: "Phone", client: "x" }),
    ],
    [
      "an empty name",
      JSON.stringify({ t: "pair", v: 1, secret: TOKEN, deviceName: "", client: "x" }),
    ],
    [
      "a 300-char name",
      JSON.stringify({ t: "pair", v: 1, secret: TOKEN, deviceName: "a".repeat(300), client: "x" }),
    ],
    [
      'v:"1"',
      JSON.stringify({ t: "pair", v: "1", secret: TOKEN, deviceName: "Phone", client: "x" }),
    ],
  ])("refuses %s", (_label, text) => {
    expect(parsePairMessage(text)).toBeUndefined();
  });
});

describe("encodeMessage", () => {
  it("is JSON.stringify", () => {
    const message: ClientMessage = { t: "bye" };
    expect(encodeMessage(message)).toBe(JSON.stringify(message));
  });
});

describe("pairing URI", () => {
  it("round-trips, including a zoned host", () => {
    const link: PairingLink = {
      host: "fe80::1%en0",
      port: 8443,
      secret: TOKEN,
      fingerprint: FINGERPRINT,
    };
    expect(parsePairingUri(formatPairingUri(link))).toEqual(link);
  });

  const validFields = { v: "2", host: "127.0.0.1", port: "8443", secret: TOKEN, fp: FINGERPRINT };
  const uriWith = (scheme: string, overrides: Partial<typeof validFields> = {}) => {
    const params = new URLSearchParams({ ...validFields, ...overrides });
    return `${scheme}pair?${params.toString()}`;
  };

  it.each<[string, string]>([
    ["the https:// scheme", uriWith("https://")],
    ["v=1", uriWith("jarvis://", { v: "1" })],
    ["a hostname", uriWith("jarvis://", { host: "example.com" })],
    ["::ffff:127.0.0.1 (not canonical)", uriWith("jarvis://", { host: "::ffff:127.0.0.1" })],
    ["port 0", uriWith("jarvis://", { port: "0" })],
    ["a short secret", uriWith("jarvis://", { secret: "short" })],
    ["an upper-case fingerprint", uriWith("jarvis://", { fp: "A".repeat(64) })],
  ])("refuses %s", (_label, uri) => {
    expect(parsePairingUri(uri)).toBeUndefined();
  });
});

describe("CLOSE", () => {
  it("has unauthorized at 4401, congested at 4413, and every application code at or above 4000 and unique", () => {
    expect(CLOSE.unauthorized).toBe(4401);
    expect(CLOSE.congested).toBe(4413);
    const applicationCodes = [
      CLOSE.badFrame,
      CLOSE.unauthorized,
      CLOSE.pairingDenied,
      CLOSE.handshakeTimeout,
      CLOSE.revoked,
      CLOSE.congested,
      CLOSE.versionMismatch,
      CLOSE.tooManyRequests,
      CLOSE.overCapacity,
    ];
    for (const code of applicationCodes) {
      expect(code).toBeGreaterThanOrEqual(4000);
    }
    expect(new Set(applicationCodes).size).toBe(applicationCodes.length);
  });
});

describe("auth channels pass the frame parser's channel check", () => {
  it.each([...AUTH_CHANNELS])("a req on %s parses as a req", (ch) => {
    const text = JSON.stringify({ t: "req", id: 1, ch, a: [] });
    expect(parseClientMessage(text)).toEqual({ t: "req", id: 1, ch, a: [] });
  });

  it("auth:passkeyBegin passes isChannel", () => {
    const text = JSON.stringify({ t: "req", id: 2, ch: "auth:passkeyBegin", a: [] });
    expect(parseClientMessage(text)).toMatchObject({ t: "req", ch: "auth:passkeyBegin" });
  });
});

describe("parseAuthArgs", () => {
  const HEX64 = "0123456789abcdef".repeat(4);
  const B64 = "AbC-_9";
  const finish = {
    credentialId: B64,
    clientDataJSON: B64,
    authenticatorData: B64,
    signature: B64,
  };
  const registerFinish = {
    credentialId: B64,
    clientDataJSON: B64,
    attestationObject: B64,
    label: "My laptop",
  };

  it.each<[string, unknown[], unknown]>([
    ["auth:status", [], {}],
    ["auth:status", [{}], {}],
    ["auth:passkeyBegin", [], {}],
    ["auth:logout", [{ extra: 1 }], {}],
    ["auth:login", [{ password: "p" }], { password: "p" }],
    ["auth:login", [{ password: "x".repeat(1024) }], { password: "x".repeat(1024) }],
    ["auth:refresh", [{ refreshToken: HEX64 }], { refreshToken: HEX64 }],
    ["auth:resume", [{ accessToken: HEX64 }], { accessToken: HEX64 }],
    ["auth:passkeyFinish", [finish], finish],
    ["auth:passkeyFinish", [{ ...finish, userHandle: B64 }], { ...finish, userHandle: B64 }],
    ["auth:passkeyRegisterBegin", [{ password: "p" }], { password: "p" }],
    ["auth:passkeyRegisterFinish", [registerFinish], registerFinish],
    [
      "auth:passkeyRegisterFinish",
      [{ ...registerFinish, attestationObject: "A".repeat(65_536), label: "l".repeat(64) }],
      { ...registerFinish, attestationObject: "A".repeat(65_536), label: "l".repeat(64) },
    ],
  ])("%s accepts %j", (ch, args, expected) => {
    expect(parseAuthArgs(ch, args)).toEqual(expected);
  });

  it("an oversized password is bad-request (undefined)", () => {
    expect(parseAuthArgs("auth:login", [{ password: "x".repeat(1025) }])).toBeUndefined();
    expect(
      parseAuthArgs("auth:passkeyRegisterBegin", [{ password: "x".repeat(1025) }]),
    ).toBeUndefined();
  });

  it.each<[string, string, unknown[]]>([
    ["unknown channel", "auth:nope", []],
    ["non-auth channel", "remote:decidePair", [{}]],
    ["prototype key as channel", "__proto__", []],
    ["two args", "auth:status", [{}, {}]],
    ["non-object arg", "auth:status", ["x"]],
    ["array arg", "auth:status", [[]]],
    ["null arg", "auth:status", [null]],
    ["login with no args", "auth:login", []],
    ["empty password", "auth:login", [{ password: "" }]],
    ["numeric password", "auth:login", [{ password: 1234 }]],
    ["short refresh token", "auth:refresh", [{ refreshToken: "a".repeat(63) }]],
    ["upper-case refresh token", "auth:refresh", [{ refreshToken: HEX64.toUpperCase() }]],
    ["access token given as refresh key", "auth:resume", [{ refreshToken: HEX64 }]],
    ["non-hex access token", "auth:resume", [{ accessToken: "g".repeat(64) }]],
    [
      "passkey finish missing signature",
      "auth:passkeyFinish",
      [{ ...finish, signature: undefined }],
    ],
    ["passkey finish with padding", "auth:passkeyFinish", [{ ...finish, signature: "AA==" }]],
    ["passkey finish with + char", "auth:passkeyFinish", [{ ...finish, clientDataJSON: "a+b" }]],
    ["passkey finish with empty field", "auth:passkeyFinish", [{ ...finish, credentialId: "" }]],
    [
      "passkey finish field over 16384",
      "auth:passkeyFinish",
      [{ ...finish, authenticatorData: "A".repeat(16_385) }],
    ],
    [
      "passkey finish with null userHandle",
      "auth:passkeyFinish",
      [{ ...finish, userHandle: null }],
    ],
    [
      "attestationObject over 65536",
      "auth:passkeyRegisterFinish",
      [{ ...registerFinish, attestationObject: "A".repeat(65_537) }],
    ],
    [
      "register clientDataJSON over 16384",
      "auth:passkeyRegisterFinish",
      [{ ...registerFinish, clientDataJSON: "A".repeat(16_385) }],
    ],
    ["empty label", "auth:passkeyRegisterFinish", [{ ...registerFinish, label: "" }]],
    ["65-char label", "auth:passkeyRegisterFinish", [{ ...registerFinish, label: "l".repeat(65) }]],
    ["label with a newline", "auth:passkeyRegisterFinish", [{ ...registerFinish, label: "a\nb" }]],
    [
      "label with a bidi override",
      "auth:passkeyRegisterFinish",
      [{ ...registerFinish, label: "a\u202Eb" }],
    ],
    ["non-string label", "auth:passkeyRegisterFinish", [{ ...registerFinish, label: 5 }]],
  ])("%s is bad-request (undefined)", (_label, ch, args) => {
    expect(parseAuthArgs(ch, args)).toBeUndefined();
  });

  it("rebuilds the args field by field, so extra keys and an own __proto__ go nowhere [bite-proof]", () => {
    const parsed = JSON.parse(
      `{"password":"p","extra":1,"__proto__":{"polluted":true}}`,
    ) as unknown;
    const result = parseAuthArgs("auth:login", [parsed]);
    expect(result).toEqual({ password: "p" });
    expect(Object.keys(result as object)).toEqual(["password"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("omits an absent userHandle rather than setting it to undefined", () => {
    const result = parseAuthArgs("auth:passkeyFinish", [finish]);
    expect(Object.keys(result as object)).not.toContain("userHandle");
  });
});
