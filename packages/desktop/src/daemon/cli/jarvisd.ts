// jarvisd, the command: `jarvisd <command>` (args.ts, commands.ts).
//
//   node dist/src/daemon/cli/jarvisd.js status                      (development)
//   ELECTRON_RUN_AS_NODE=1 <Jarvis binary> \
//     <resources>/app.asar/dist/src/daemon/cli/jarvisd.js status   (packaged)
//
// Launcher note for Task 25: a `jarvisd` on PATH is a two-line wrapper that
// runs the second form with "$@" (a .cmd doing the same on Windows); it
// needs nothing else, since this file finds the daemon script, the build
// stamp and the QR encoder relative to itself. `jarvisd run` loads
// daemon-main.js into this same process, so the foreground daemon is the
// one the services start.
//
// This is an impure edge (platform-convention.test.ts): it reads
// process.platform, HOME and the real streams once, and hands them down.
//
// No electron here (core/no-electron.test.ts).
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRIMARY_LANGUAGE } from "../../messages.js";
import { encodeQr } from "../../vendor/qr.js";
import { readBuildId } from "../build-id.js";
import { connectControl } from "../control/client.js";
import { nodeControlDeps } from "../control/deps.js";
import { runDirectoryFor } from "../control/endpoint.js";
import { runCli } from "./commands.js";
import { nodeCliIo } from "./node-io.js";

async function main(argv: readonly string[]): Promise<void> {
  const platform = process.platform;
  const here = dirname(fileURLToPath(import.meta.url));
  const build = readBuildId(join(here, "..", "..", "..", "build-stamp.json"));
  const runDirectory = runDirectoryFor({ platform, home: homedir() });
  const io = nodeCliIo({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutIsTTY: process.stdout.isTTY === true,
    exit: (code) => process.exit(code),
    onSignal(signal, listener) {
      process.on(signal, listener);
      return () => process.off(signal, listener);
    },
  });

  const code = await runCli(argv, {
    io,
    language: PRIMARY_LANGUAGE,
    connect: () => connectControl({ platform, runDirectory, build, deps: nodeControlDeps() }),
    // daemon-main runs on import, reads the same argv (`run`), and exits
    // the process itself when it stops — this promise never settles.
    runDaemon: async () => {
      await import("../../daemon-main.js");
      return new Promise<number>(() => {});
    },
    encodeQr,
    now: Date.now,
    timers: {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  // Exit once what was written has been flushed: stdout on a pipe is
  // asynchronous on macOS, and an immediate exit could cut the answer short.
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

void main(process.argv.slice(2));
