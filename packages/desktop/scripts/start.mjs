// `pnpm start` — build, then run Electron with whatever this platform needs.
//
// It exists for one flag. Electron's sandbox uses a SUID helper binary that
// must be owned by root with mode 4755, and a helper that arrived inside
// node_modules is owned by the user who ran pnpm. Chromium refuses to start
// rather than run unsandboxed:
//
//   FATAL:setuid_sandbox_host.cc:166] The SUID sandbox helper binary was
//   found, but is not configured correctly. Rather than run without
//   sandboxing I'm aborting now.
//
// The alternatives are worse than the flag. `chown root` on a file inside
// node_modules needs sudo, does not survive a reinstall, and leaves a
// root-owned setuid binary in a directory a package manager rewrites. Every
// Electron app developed on Linux passes --no-sandbox for exactly this
// reason; the packaged AppImage is a different story and keeps its sandbox.
//
// macOS needs none of this and gets none of it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electron = require("electron");

const args = [".", ...process.argv.slice(2)];
if (process.platform === "linux") args.push("--no-sandbox");

const child = spawn(electron, args, { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
