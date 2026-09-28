// jarvisd: the core without a window, behind the local control socket.
//
//   node dist/src/daemon-main.js run                      (development, a server)
//   ELECTRON_RUN_AS_NODE=1 <Jarvis binary> …/daemon-main.js run   (packaged)
//
// Start-up: the control server first — it is the single-instance lock, so a
// second daemon exits with code 3 before it builds a second core — then the
// core, bound to the socket (daemon/binding.ts), then the remote bridge.
// Every request on the socket runs with DESKTOP_ORIGIN. Stop: SIGTERM,
// SIGINT, SIGHUP or daemon:stop, in daemon/lifecycle.ts's order.
//
// Logs: ~/.config/jarvis/logs/jarvisd.log (daemon/log-file.ts), mirrored to
// the terminal when run in one.
//
// No electron here, directly or through any local file
// (core/no-electron.test.ts), and process.platform read once, here.
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore, type Core } from "./core/compose.js";
import { DAEMON_EXIT, DAEMON_USAGE, parseDaemonArgs } from "./daemon/args.js";
import { createDaemonBinding } from "./daemon/binding.js";
import { takeDaemonEnv } from "./daemon/env.js";
import { readBuildId } from "./daemon/build-id.js";
import { nodeControlDeps } from "./daemon/control/deps.js";
import { runDirectoryFor } from "./daemon/control/endpoint.js";
import { createControlServer } from "./daemon/control/server.js";
import { createShutdown } from "./daemon/lifecycle.js";
import {
  createDaemonLog,
  type DaemonLog,
  daemonLogPath,
  redirectConsole,
  scrubSecrets,
} from "./daemon/log-file.js";
import { webExportDir } from "./web-export.js";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(argv: readonly string[]): Promise<void> {
  // First, before anything can spawn a child: see daemon/env.ts.
  const { supervisor } = takeDaemonEnv(process.env);
  const args = parseDaemonArgs(argv);
  if (args.kind === "help") {
    process.stdout.write(DAEMON_USAGE);
    return;
  }
  if (args.kind === "error") {
    process.stderr.write(`${args.message}\n${DAEMON_USAGE}`);
    process.exit(DAEMON_EXIT.usage);
  }

  const platform = process.platform;
  const home = homedir();
  const distSrc = dirname(fileURLToPath(import.meta.url));
  const fileLog = createDaemonLog({
    path: daemonLogPath(home),
    now: Date.now,
    fallback: (line) => process.stderr.write(line),
  });
  const log: DaemonLog = process.stderr.isTTY
    ? {
        write(level, message) {
          fileLog.write(level, message);
          process.stderr.write(`${scrubSecrets(message)}\n`);
        },
      }
    : fileLog;
  const restoreConsole = redirectConsole(log);
  const info = (line: string) => log.write("info", line);
  const error = (line: string) => log.write("error", line);
  let core: Core | undefined;

  process.on("uncaughtException", (thrown) => {
    error(
      `uncaught exception: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`,
    );
    try {
      core?.stop();
    } finally {
      process.exit(DAEMON_EXIT.failed);
    }
  });
  process.on("unhandledRejection", (reason) => {
    error(`unhandled rejection: ${describe(reason)}`);
  });

  const build = readBuildId(join(distSrc, "..", "build-stamp.json"));
  let requestStop: (reason: string, exitCode?: number) => void = () => {};
  const binding = createDaemonBinding({
    requestStop: () => requestStop("daemon:stop"),
    // Only a service manager brings a daemon back after it exits; without
    // one, Settings' Restart asks the user to restart jarvisd.
    ...(supervisor === undefined
      ? {}
      : { requestRestart: () => requestStop("restart", DAEMON_EXIT.restart) }),
    log: error,
    now: Date.now,
    timers: {
      setInterval(callback, ms) {
        const handle = setInterval(callback, ms);
        handle.unref();
        return handle;
      },
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
      defer: (callback) => setImmediate(callback),
    },
  });

  const started = await createControlServer({
    platform,
    runDirectory: runDirectoryFor({ platform, home }),
    build,
    handlers: binding.handlers,
    deps: nodeControlDeps(),
  });
  if (started.kind === "busy") {
    error("another jarvisd is already running; exiting");
    restoreConsole();
    process.exit(DAEMON_EXIT.busy);
  }
  const server = started.server;

  const shutdown = createShutdown({
    stopCore: async () => {
      await core?.shutdown();
    },
    closeControl: () => server.close(),
    exit: (code) => {
      restoreConsole();
      process.exit(code);
    },
    log: info,
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  requestStop = (reason, exitCode) => void shutdown.stop(reason, exitCode);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => requestStop(signal));
  }

  info(
    `jarvisd starting: pid ${process.pid}, build ${build}, ${supervisor === undefined ? "no service manager" : `run by ${supervisor}`}`,
  );
  try {
    // Packaged, this file is inside <resources>/app.asar (script-path.ts),
    // and the web export sits beside the archive in <resources>/web.
    const asar = distSrc.indexOf(`${sep}app.asar`);
    core = await createCore({
      platform,
      webExportDir: () =>
        webExportDir({
          packaged: asar >= 0,
          resourcesPath: asar >= 0 ? distSrc.slice(0, asar) : "",
          devDir: join(distSrc, "..", "..", "web"),
        }),
    });
  } catch (thrown) {
    error(`the core failed to start: ${describe(thrown)}`);
    await server.close().catch(() => {});
    restoreConsole();
    process.exit(DAEMON_EXIT.failed);
  }
  if (shutdown.stopping) {
    // A signal arrived while the core was starting: its stop found nothing
    // to stop, so what createCore started is released here.
    core.stop();
    return;
  }
  binding.bind(core, server);
  core.startRemote();
  info(`jarvisd running on ${server.endpoint}`);
}

void main(process.argv.slice(2));
