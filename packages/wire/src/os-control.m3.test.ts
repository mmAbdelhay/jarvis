import { describe, expect, it } from "vitest";
import {
  isIpLiteral,
  OS_CONTROL_BLOBS,
  OS_CONTROL_PUSHES,
  OS_CONTROL_REQUESTS,
  parseOwnerPassword,
  parsePairingAnswer,
  parseRemoteConfigure,
  parseRemoteRevoke,
  parseSetLocked,
  parseSetSpeak,
  parseVoiceUtteranceMeta,
} from "./os-control.js";

describe("Rafiq M3 control channels (contracts §2)", () => {
  it("names the M3 channels exactly", () => {
    expect(OS_CONTROL_REQUESTS.voiceSetSpeak).toBe("voice:setSpeak");
    expect(OS_CONTROL_REQUESTS.voiceStop).toBe("voice:stop");
    expect(OS_CONTROL_REQUESTS.agentUndo).toBe("agent:undo");
    expect(OS_CONTROL_REQUESTS.pairingAnswer).toBe("pairing:answer");
    expect(OS_CONTROL_REQUESTS.sysSetLocked).toBe("sys:setLocked");
    expect(OS_CONTROL_BLOBS.voiceUtterance).toBe("voice:utterance");
    expect(OS_CONTROL_PUSHES.voiceState).toBe("voice:state");
    expect(OS_CONTROL_PUSHES.pairingPending).toBe("pairing:pending");
  });

  it("parses the voice:utterance header field by field", () => {
    expect(parseVoiceUtteranceMeta([])).toEqual({ ok: true, value: { lang: "auto" } });
    expect(parseVoiceUtteranceMeta([{}])).toEqual({ ok: true, value: { lang: "auto" } });
    expect(parseVoiceUtteranceMeta([{ lang: "ar", cardId: "c1", extra: 1 }])).toEqual({
      ok: true,
      value: { lang: "ar", cardId: "c1" },
    });
    expect(parseVoiceUtteranceMeta([{ ticked: ["item-1", "item-2"] }])).toEqual({
      ok: true,
      value: { lang: "auto", ticked: ["item-1", "item-2"] },
    });
    expect(parseVoiceUtteranceMeta([{ lang: "fr" }]).ok).toBe(false);
    expect(parseVoiceUtteranceMeta([{ cardId: "../x" }]).ok).toBe(false);
    expect(parseVoiceUtteranceMeta([{ ticked: ["a", "a"] }]).ok).toBe(false);
    expect(parseVoiceUtteranceMeta([{}, {}]).ok).toBe(false);
  });

  it("parses pairing:answer, sys:setLocked and remote:revoke", () => {
    expect(parsePairingAnswer([{ requestId: "r1", approve: true }])).toEqual({
      ok: true,
      value: { requestId: "r1", approve: true },
    });
    expect(parsePairingAnswer([{ requestId: "r1", approve: false, code: "ignored" }])).toEqual({
      ok: true,
      value: { requestId: "r1", approve: false },
    });
    expect(parsePairingAnswer([{ approve: "yes" }]).ok).toBe(false);
    expect(parsePairingAnswer([{ approve: true, requestId: "a\u0007b" }]).ok).toBe(false);
    expect(parseSetLocked([{ locked: true }])).toEqual({ ok: true, value: { locked: true } });
    expect(parseSetLocked([{ locked: 1 }]).ok).toBe(false);
    expect(parsePairingAnswer([{ approve: true }]).ok).toBe(false);
    expect(parseSetSpeak([{ on: true, extra: 1 }])).toEqual({ ok: true, value: { on: true } });
    expect(parseSetSpeak([{ on: 1 }]).ok).toBe(false);
    expect(parseRemoteRevoke([{ deviceId: "a".repeat(32) }])).toEqual({
      ok: true,
      value: { deviceId: "a".repeat(32) },
    });
    expect(parseRemoteRevoke([{ deviceId: "nope" }]).ok).toBe(false);
  });

  it("parses remote:configure with IP literals only", () => {
    expect(parseRemoteConfigure([{ enabled: true }])).toEqual({
      ok: true,
      value: { enabled: true },
    });
    expect(parseRemoteConfigure([{ enabled: true, bindAddress: "0.0.0.0", port: 7717 }])).toEqual({
      ok: true,
      value: { enabled: true, bindAddress: "0.0.0.0", port: 7717 },
    });
    expect(parseRemoteConfigure([{ enabled: true, bindAddress: "fd7a::1" }]).ok).toBe(true);
    expect(parseRemoteConfigure([{ enabled: true, bindAddress: "laptop.local" }]).ok).toBe(false);
    expect(parseRemoteConfigure([{ enabled: true, port: 0 }]).ok).toBe(false);
    expect(parseRemoteConfigure([{ enabled: true, port: 70000 }]).ok).toBe(false);
    expect(isIpLiteral("256.1.1.1")).toBe(false);
    expect(isIpLiteral("127.0.0.1")).toBe(true);
  });

  it("parses remote:setOwnerPassword without echoing the password in errors", () => {
    expect(parseOwnerPassword([{ next: "correct horse" }])).toEqual({
      ok: true,
      value: { next: "correct horse" },
    });
    expect(parseOwnerPassword([{ current: "old", next: "new pass" }])).toEqual({
      ok: true,
      value: { current: "old", next: "new pass" },
    });
    const bad = parseOwnerPassword([{ next: "x".repeat(1025) }]);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("xxxx");
  });
});
