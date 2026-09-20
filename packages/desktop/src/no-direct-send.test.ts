import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, not `.pathname` — `.pathname` keeps the URL's leading
// "/" in front of a Windows drive letter ("/D:/a/…"), and readdirSync
// below then resolves that against the current drive, doubling it
// ("D:\D:\a\…") and failing with ENOENT. `fileURLToPath` strips it
// correctly on every platform.
const DIR = fileURLToPath(new URL(".", import.meta.url));

// broadcast.ts is the one place allowed to reach the renderer directly; that
// is the whole reason it exists.
const ALLOWED = new Set(["broadcast.ts", "no-direct-send.test.ts"]);

function sources(): string[] {
  return readdirSync(DIR).filter(
    (name) => (name.endsWith(".ts") || name.endsWith(".cts")) && !ALLOWED.has(name),
  );
}

describe("pushes to the renderer", () => {
  // A new call site added directly would not reach a remote client, and
  // nothing else would notice until someone wondered why their phone never
  // saw one channel.
  it("go through the broadcaster, never webContents.send", () => {
    const offenders = sources().filter((name) =>
      readFileSync(join(DIR, name), "utf8").includes("webContents.send"),
    );

    expect(offenders).toEqual([]);
  });
});
