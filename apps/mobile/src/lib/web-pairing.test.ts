import { formatPairingUri, type PairingLink, webPairingUrl } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import {
  CLEARED_HASH_PARAM,
  deviceNameFromUserAgent,
  fragmentArrivalAction,
  pairingLinkFromHash,
  pairingLinkFromText,
} from "./web-pairing";

const LINK: PairingLink = {
  host: "100.79.83.16",
  port: 7717,
  secret: "s".repeat(43),
  fingerprint: "a".repeat(64),
  name: "laptop.tail1234.ts.net",
};

function hashOf(link: PairingLink): string {
  return `#${formatPairingUri(link).slice("jarvis://pair?".length)}`;
}

describe("pairingLinkFromHash", () => {
  it("rebuilds the jarvis:// link from the fragment and validates it through parsePairingUri", () => {
    expect(pairingLinkFromHash(hashOf(LINK))).toEqual(LINK);
  });

  it("accepts the fragment without its leading #", () => {
    expect(pairingLinkFromHash(hashOf(LINK).slice(1))).toEqual(LINK);
  });

  it("answers undefined for an empty hash", () => {
    expect(pairingLinkFromHash("")).toBeUndefined();
    expect(pairingLinkFromHash("#")).toBeUndefined();
  });

  it("answers undefined when a field fails validation (bad secret)", () => {
    expect(pairingLinkFromHash(hashOf(LINK).replace("s".repeat(43), "short"))).toBeUndefined();
  });

  it("answers undefined for a fragment that smuggles a second ? or #", () => {
    expect(pairingLinkFromHash(`${hashOf(LINK)}#x=1`)).toBeUndefined();
    expect(pairingLinkFromHash(`#?${hashOf(LINK).slice(1)}`)).toBeUndefined();
  });
});

describe("pairingLinkFromText", () => {
  it("accepts the https://<name>:<webPort>/pair#... web link", () => {
    expect(pairingLinkFromText(`https://${LINK.name}:8443/pair${hashOf(LINK)}`)).toEqual(LINK);
  });

  it("accepts the jarvis://pair?... link too, trimmed", () => {
    expect(pairingLinkFromText(`  ${formatPairingUri(LINK)}\n`)).toEqual(LINK);
  });

  it("refuses an https link whose path is not /pair", () => {
    expect(pairingLinkFromText(`https://${LINK.name}:8443/other${hashOf(LINK)}`)).toBeUndefined();
  });

  it("refuses an http:// link and plain garbage", () => {
    expect(pairingLinkFromText(`http://${LINK.name}:8443/pair${hashOf(LINK)}`)).toBeUndefined();
    expect(pairingLinkFromText("hello")).toBeUndefined();
  });
});

describe("deviceNameFromUserAgent", () => {
  it("names Chrome on macOS", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    expect(deviceNameFromUserAgent(ua)).toBe("Chrome · macOS");
  });

  it("names Safari on iPhone", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(deviceNameFromUserAgent(ua)).toBe("Safari · iPhone");
  });

  it("names Edge on Windows (not Chrome)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
    expect(deviceNameFromUserAgent(ua)).toBe("Edge · Windows");
  });

  it("names Firefox on Linux and Chrome on Android", () => {
    expect(
      deviceNameFromUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ),
    ).toBe("Firefox · Linux");
    expect(
      deviceNameFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome · Android");
  });

  it("falls back to a generic name for an unknown or empty agent", () => {
    expect(deviceNameFromUserAgent("")).toBe("Web browser");
    expect(deviceNameFromUserAgent("curl/8.0")).toBe("Web browser");
  });
});

describe("webPairingUrl round trip (desktop QR → browser)", () => {
  it("the desktop's web pairing URL parses back to the same link, by hash and by paste", () => {
    const url = webPairingUrl(LINK, 7718);
    if (url === undefined) throw new Error("expected a web pairing URL");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://laptop.tail1234.ts.net:7718");
    expect(parsed.pathname).toBe("/pair");
    expect(pairingLinkFromHash(parsed.hash)).toEqual(LINK);
    expect(pairingLinkFromText(url)).toEqual(LINK);
  });

  it("round-trips on port 443 too", () => {
    const url = webPairingUrl(LINK, 443);
    if (url === undefined) throw new Error("expected a web pairing URL");
    expect(pairingLinkFromText(url)).toEqual(LINK);
  });
});

describe("fragmentArrivalAction (D6b)", () => {
  it("takes a link entered while the entry step shows, holds it while checking, drops it elsewhere", () => {
    expect(fragmentArrivalAction("scan")).toBe("intake");
    expect(fragmentArrivalAction("checking")).toBe("hold");
    for (const kind of ["alreadyPaired", "clearFailed", "confirm", "waiting", "error", "success"]) {
      expect(fragmentArrivalAction(kind)).toBe("drop");
    }
  });
});

describe("CLEARED_HASH_PARAM (D6a)", () => {
  it("never serialises to a visible hash the way undefined does", () => {
    // Expo Router builds its href from URLSearchParams over the route params.
    const cleared = new URLSearchParams([["#", CLEARED_HASH_PARAM]]).get("#") || undefined;
    expect(cleared).toBeUndefined();
    const withUndefined = new URLSearchParams([["#", undefined as unknown as string]]).get("#");
    expect(withUndefined).toBe("undefined");
  });
});
