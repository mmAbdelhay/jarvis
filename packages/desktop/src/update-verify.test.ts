import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSums, sha256File, verifyFile } from "./update-verify.js";

const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("parseSums", () => {
  it("reads sha256sum's text and binary formats, lowercasing the hash", () => {
    const sums = parseSums(
      `${ABC.toUpperCase()}  Jarvis-0.1.9-arm64.dmg\n${EMPTY} *Jarvis-0.1.9.AppImage\r\n`,
    );
    expect(sums).toEqual(
      new Map([
        ["Jarvis-0.1.9-arm64.dmg", ABC],
        ["Jarvis-0.1.9.AppImage", EMPTY],
      ]),
    );
  });

  it("ignores lines that are not a 64-hex hash and a name", () => {
    const sums = parseSums(
      [
        "",
        "# comment",
        `${ABC.slice(1)}  short-hash`,
        `${ABC}x  long-hash`,
        `${ABC} one-space`,
        `${ABC}  `,
        `${"g".repeat(64)}  not-hex`,
        `${ABC}  good`,
      ].join("\n"),
    );
    expect([...sums.keys()]).toEqual(["good"]);
  });

  it("drops a name listed twice with different hashes", () => {
    expect(parseSums(`${ABC}  a\n${EMPTY}  a\n`).has("a")).toBe(false);
    expect(parseSums(`${ABC}  a\n${ABC}  a\n`).get("a")).toBe(ABC);
  });
});

describe("sha256File / verifyFile", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const file = (content: string): string => {
    dir = mkdtempSync(join(tmpdir(), "jarvis-verify-"));
    const path = join(dir, "asset");
    writeFileSync(path, content);
    return path;
  };

  it("hashes a file's contents", async () => {
    expect(await sha256File(file("abc"))).toBe(ABC);
  });

  it("verifies a matching hash in either case and rejects a mismatch", async () => {
    const path = file("abc");
    expect(await verifyFile(path, ABC)).toBe(true);
    expect(await verifyFile(path, ABC.toUpperCase())).toBe(true);
    expect(await verifyFile(path, EMPTY)).toBe(false);
    expect(await verifyFile(path, "")).toBe(false);
  });

  it("fails loudly when the file cannot be read", async () => {
    await expect(sha256File("/nonexistent/jarvis-asset")).rejects.toThrow();
  });
});
