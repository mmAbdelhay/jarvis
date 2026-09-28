// `pnpm build` step: writes dist/build-stamp.json, the build the app and
// jarvisd compare in their control handshake (src/daemon/build-id.ts).
//
// The build time makes every rebuild a different build — committed or not —
// so a daemon left running from an older build is restarted rather than
// served by an app it no longer matches. The commit is there for humans
// reading a status line; outside a git checkout it is left out.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

let commit;
try {
  commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  commit = undefined;
}

const stamp = { version, ...(commit ? { commit } : {}), builtAt: new Date().toISOString() };
mkdirSync(new URL("../dist", import.meta.url), { recursive: true });
writeFileSync(new URL("../dist/build-stamp.json", import.meta.url), `${JSON.stringify(stamp)}\n`);
