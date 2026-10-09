// Rafiq M4 §3: daemon code reads every user-visible table in the live
// language, never pinned to English.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const PINNED = /\b(USER_TEXT|CONTROL_TEXT|DOCTOR_TEXT|FAILOVER_TEXT|TOOL_ACTIVITY)\.en\b/;

describe("daemon user texts", () => {
  it("never pins a user-visible table to English", () => {
    const offenders = readdirSync(DIR)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => PINNED.test(readFileSync(join(DIR, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});
