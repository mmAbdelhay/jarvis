import { NATIVE_ORIGIN } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { originAllowed } from "./origin.js";

describe("originAllowed", () => {
  const webOrigin = "https://mac.tail.ts.net:4318";

  const cases: [string | string[] | undefined, string | undefined, boolean][] = [
    [undefined, undefined, true],
    [NATIVE_ORIGIN, undefined, true],
    [webOrigin, webOrigin, true],
    [webOrigin, undefined, false],
    ["https://mac.tail.ts.net:4317", webOrigin, false],
    ["null", webOrigin, false],
    ["http://mac.tail.ts.net:4318", webOrigin, false],
    ["https://mac.tail.ts.net:9999", webOrigin, false],
    ["HTTPS://mac.tail.ts.net:4318", webOrigin, false],
    ["https://MAC.tail.ts.net:4318", webOrigin, false],
    [[NATIVE_ORIGIN], webOrigin, false],
    [[NATIVE_ORIGIN, webOrigin], webOrigin, false],
    [`${webOrigin}/`, webOrigin, false],
  ];

  it.each(cases)("checks header=%j with web origin=%j", (header, configuredWebOrigin, allowed) => {
    expect(originAllowed(header, configuredWebOrigin)).toBe(allowed);
  });
});
