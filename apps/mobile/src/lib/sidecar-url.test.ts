import { describe, expect, it } from "vitest";
import { isAllowedSidecarUrl, isOnSidecarOrigin, sidecarOrigin } from "./sidecar-url";

const NAME = "laptop.tail1234.ts.net";
const PORT = 8443;
const HANDLE = "0123456789abcdef0123456789abcdef";

describe("sidecarOrigin", () => {
  it("builds an https origin from name and port", () => {
    expect(sidecarOrigin(NAME, PORT)).toBe(`https://${NAME}:${PORT}`);
  });
});

describe("isAllowedSidecarUrl", () => {
  it("allows an https URL on the exact name and port under /s/<handle>/", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}:${PORT}/s/${HANDLE}/`, NAME, PORT)).toBe(true);
  });

  it("allows a URL with a path, query and fragment after the handle", () => {
    const url = `https://${NAME}:${PORT}/s/${HANDLE}/index.html?folder=%2Fapp#/c/prod`;
    expect(isAllowedSidecarUrl(url, NAME, PORT)).toBe(true);
  });

  it("refuses http:", () => {
    expect(isAllowedSidecarUrl(`http://${NAME}:${PORT}/s/${HANDLE}/`, NAME, PORT)).toBe(false);
  });

  it("refuses a different host", () => {
    expect(
      isAllowedSidecarUrl(`https://other.tail1234.ts.net:${PORT}/s/${HANDLE}/`, NAME, PORT),
    ).toBe(false);
  });

  it("refuses a different port", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}:9999/s/${HANDLE}/`, NAME, PORT)).toBe(false);
  });

  it("refuses an IP-literal host even when it resolves to the same box", () => {
    expect(isAllowedSidecarUrl(`https://127.0.0.1:${PORT}/s/${HANDLE}/`, NAME, PORT)).toBe(false);
  });

  it("refuses a path outside /s/", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}:${PORT}/rpc`, NAME, PORT)).toBe(false);
  });

  it("refuses a short handle", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}:${PORT}/s/abc123/`, NAME, PORT)).toBe(false);
  });

  it("refuses an upper-case handle", () => {
    const upper = HANDLE.toUpperCase();
    expect(isAllowedSidecarUrl(`https://${NAME}:${PORT}/s/${upper}/`, NAME, PORT)).toBe(false);
  });

  it("refuses a handle with no trailing slash", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}:${PORT}/s/${HANDLE}`, NAME, PORT)).toBe(false);
  });

  // M2 (final review): a bridge on the default HTTPS port has its URL's
  // port stripped by the WebView, so both shapes must be accepted.
  it("allows the explicit :443 shape when the port is 443", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}:443/s/${HANDLE}/`, NAME, 443)).toBe(true);
  });

  it("allows the default-port-omitted shape when the port is 443", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}/s/${HANDLE}/`, NAME, 443)).toBe(true);
  });

  it("refuses a hostname-suffix attack on the :443 shape", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}:443.evil/s/${HANDLE}/`, NAME, 443)).toBe(false);
  });

  it("refuses the default-port-omitted shape when the configured port isn't 443", () => {
    expect(isAllowedSidecarUrl(`https://${NAME}/s/${HANDLE}/`, NAME, 7717)).toBe(false);
  });
});

describe("isOnSidecarOrigin", () => {
  const ORIGIN = sidecarOrigin(NAME, PORT);

  it("allows the sidecar origin itself", () => {
    expect(isOnSidecarOrigin(ORIGIN, ORIGIN)).toBe(true);
  });

  it("allows a path under the origin", () => {
    expect(isOnSidecarOrigin(`${ORIGIN}/s/${HANDLE}/index.html`, ORIGIN)).toBe(true);
  });

  it("allows about:blank", () => {
    expect(isOnSidecarOrigin("about:blank", ORIGIN)).toBe(true);
  });

  // [bite-proof] making isOnSidecarOrigin return true unconditionally
  // makes this test fail: a suffix on the hostname is a different host,
  // not a prefix match, even though the string starts with the origin.
  it("refuses a hostname-suffix attack (origin + '.evil')", () => {
    expect(isOnSidecarOrigin(`${ORIGIN}.evil/x`, ORIGIN)).toBe(false);
  });

  it("refuses a port-suffix attack (origin + '0')", () => {
    expect(isOnSidecarOrigin(`${ORIGIN}0/x`, ORIGIN)).toBe(false);
  });

  it("refuses http: even for the same host and port", () => {
    expect(isOnSidecarOrigin(`http://${NAME}:${PORT}/x`, ORIGIN)).toBe(false);
  });

  // M2 (final review): the WebView reports a :443 origin's navigations
  // with the port stripped, so the gate must accept both shapes.
  describe("with the default HTTPS port", () => {
    const ORIGIN_443 = sidecarOrigin(NAME, 443);

    it("allows the explicit :443 shape", () => {
      expect(isOnSidecarOrigin(`${ORIGIN_443}/s/${HANDLE}/index.html`, ORIGIN_443)).toBe(true);
    });

    it("allows the default-port-omitted shape", () => {
      expect(isOnSidecarOrigin(`https://${NAME}/s/${HANDLE}/index.html`, ORIGIN_443)).toBe(true);
    });

    it("refuses a hostname-suffix attack on the omitted-port shape", () => {
      expect(isOnSidecarOrigin(`https://${NAME}.evil/x`, ORIGIN_443)).toBe(false);
    });

    it("refuses the default-port-omitted shape when the origin's port isn't 443", () => {
      expect(isOnSidecarOrigin(`https://${NAME}/x`, ORIGIN)).toBe(false);
    });
  });
});
