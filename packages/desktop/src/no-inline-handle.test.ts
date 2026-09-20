import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// main.ts registers requests in exactly two places: the loop over the
// dispatch table, and registerDesktopOnly. A third `ipcMain.handle(` call
// site — however its channel argument is spelled — is a handler the remote
// bridge cannot see and the policy cannot classify.
describe("no inline ipcMain.handle in main.ts", () => {
  it("has exactly two", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source.match(/ipcMain\.handle\(/g)).toHaveLength(2);
  });
});
