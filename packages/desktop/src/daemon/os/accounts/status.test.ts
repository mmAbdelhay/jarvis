import { readFileSync } from "node:fs";
import { accountPaths, parseAccountPins } from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";
import type { AccountFs } from "./account-fs.js";
import { readAccountStatus } from "./status.js";

const PINS = parseAccountPins(
  JSON.parse(
    readFileSync(new URL("../../../../../../os/models/accounts.json", import.meta.url), "utf8"),
  ),
);

function fs(files: Record<string, string>): AccountFs {
  return {
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    exists: async (path) => path in files,
    makeDir: async () => {},
    removeTree: async () => {},
  };
}

describe("readAccountStatus", () => {
  it("is not installed without the pinned package", async () => {
    const paths = accountPaths("/home/r", "gemini");
    expect(await readAccountStatus(PINS.gemini, paths, fs({}))).toEqual({
      account: "gemini",
      installed: false,
      version: null,
      signedIn: false,
      identity: null,
    });
  });

  it("reports a wrong version as not installed", async () => {
    const paths = accountPaths("/home/r", "gemini");
    const files = {
      [`${paths.cliDir}/node_modules/@google/gemini-cli/package.json`]: '{"version":"0.50.0"}',
      [`${paths.cliDir}/node_modules/@google/gemini-cli/bundle/gemini.js`]: "",
    };
    expect(await readAccountStatus(PINS.gemini, paths, fs(files))).toMatchObject({
      installed: false,
      version: "0.50.0",
    });
  });

  it("reads signed-in state and identity from the CLI's own files only", async () => {
    const paths = accountPaths("/home/r", "gemini");
    const files = {
      [`${paths.cliDir}/node_modules/@google/gemini-cli/package.json`]: '{"version":"0.62.0"}',
      [`${paths.cliDir}/node_modules/@google/gemini-cli/bundle/gemini.js`]: "",
      [`${paths.configDir}/.gemini/oauth_creds.json`]: '{"refresh_token":"x"}',
      [`${paths.configDir}/.gemini/google_accounts.json`]: '{"active":"lina@gmail.com"}',
    };
    expect(await readAccountStatus(PINS.gemini, paths, fs(files))).toEqual({
      account: "gemini",
      installed: true,
      version: "0.62.0",
      signedIn: true,
      identity: "lina@gmail.com",
    });
  });

  it("copilot counts as signed in only with a logged-in user", async () => {
    const paths = accountPaths("/home/r", "copilot");
    const base = {
      [`${paths.cliDir}/node_modules/@github/copilot/package.json`]: '{"version":"1.0.89"}',
      [`${paths.cliDir}/node_modules/@github/copilot/npm-loader.js`]: "",
    };
    expect(
      (
        await readAccountStatus(
          PINS.copilot,
          paths,
          fs({ ...base, [`${paths.configDir}/config.json`]: "{}" }),
        )
      ).signedIn,
    ).toBe(false);
    const signed = {
      ...base,
      [`${paths.configDir}/config.json`]:
        '{"last_logged_in_user":{"host":"https://github.com","login":"octocat"}}',
    };
    expect(await readAccountStatus(PINS.copilot, paths, fs(signed))).toMatchObject({
      signedIn: true,
      identity: "octocat",
    });
  });
});
