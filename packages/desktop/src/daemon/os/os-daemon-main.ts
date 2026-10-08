// jarvisd for Jarvis OS (contracts §4): the agent behind the existing local
// control socket, with no window, no Electron and none of the desktop core.
//
//   /usr/lib/jarvis/node/bin/node /usr/lib/jarvis/daemon/jarvisd.mjs run   (the user unit)
//   node packages/desktop/dist/src/daemon/os/os-daemon-main.js run          (development, Linux)
//
// Start-up mirrors daemon-main.ts: the control server first (it is the
// single-instance lock; a second daemon exits 3), then the agent. Stop:
// SIGTERM, SIGINT, SIGHUP or a hello with intent "stop".
//
// Env: JARVIS_MCP_DIR (where jarvis-pkg/jarvis-diag live), JARVIS_FAKE_PROVIDER
// (a script that replaces the model, contracts §5 — never active otherwise),
// JARVISD_SUPERVISOR (set by the unit).
//
// No electron here (core/no-electron.test.ts); process.platform read once, here.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FakeTurn, parseFakeScript, TRUSTED_MCP_SERVERS } from "@jarvis/core";
import {
  auditLogPath,
  createAuditLog,
  createSecretToolStore,
  nodeAuditFs,
  nodeMcpSpawn,
  nodeSecretToolExec,
  PROVIDER_KEY_ATTRIBUTE,
} from "@jarvis/platform/model";
import { DAEMON_EXIT, DAEMON_USAGE, parseDaemonArgs } from "../args.js";
import { nodeControlDeps } from "../control/deps.js";
import { runDirectoryFor } from "../control/endpoint.js";
import { createControlServer } from "../control/server.js";
import { takeDaemonEnv } from "../env.js";
import { createShutdown } from "../lifecycle.js";
import {
  createDaemonLog,
  type DaemonLog,
  daemonLogPath,
  redirectConsole,
  scrubSecrets,
} from "../log-file.js";
import { createOsAgent } from "./agent-service.js";
import { connectOsMcpServers } from "./mcp-servers.js";
import { createModelStateReader } from "./model-state-reader.js";
import { createOsBinding } from "./os-binding.js";
import {
  buildStampCandidates,
  MODEL_STATE_PATH,
  mcpDirFrom,
  osConfigPath,
  readOsBuildId,
} from "./os-paths.js";
import { buildProvider } from "./provider-factory.js";

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

async function main(argv: readonly string[]): Promise<void> {
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
  if (platform !== "linux") {
    process.stderr.write("jarvisd OS mode runs on Linux only\n");
    process.exit(DAEMON_EXIT.usage);
  }

  const home = homedir();
  const here = dirname(fileURLToPath(import.meta.url));
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
  process.on("unhandledRejection", (reason) => error(`unhandled rejection: ${describe(reason)}`));

  const stamp = buildStampCandidates(here).find((path) => existsSync(path));
  const build = stamp === undefined ? "dev" : readOsBuildId(stamp);

  let fakeScript: FakeTurn[] | undefined;
  const fakePath = process.env["JARVIS_FAKE_PROVIDER"];
  if (fakePath !== undefined && fakePath !== "") {
    try {
      fakeScript = parseFakeScript(JSON.parse(readFileSync(fakePath, "utf8")));
      info(`JARVIS_FAKE_PROVIDER is set: the model is replaced by ${fakePath}`);
    } catch (thrown) {
      error(`JARVIS_FAKE_PROVIDER: ${describe(thrown)}`);
      restoreConsole();
      process.exit(DAEMON_EXIT.failed);
    }
  }

  const env = { ...process.env };
  const mcpDir = mcpDirFrom(env);
  const timers = {
    setTimeout: (callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms);
      handle.unref();
      return handle;
    },
    clearTimeout: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout),
    setInterval: (callback: () => void, ms: number) => {
      const handle = setInterval(callback, ms);
      handle.unref();
      return handle;
    },
    clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
  };
  let push: (channel: string, payload: unknown) => void = () => {};
  const agent = createOsAgent({
    push: (channel, payload) => push(channel, payload),
    configPath: osConfigPath(home),
    configIo: { readFile: (path) => readFile(path, "utf8"), writeFile: writeAtomically },
    secrets: createSecretToolStore(nodeSecretToolExec(env)),
    providerKeys: createSecretToolStore(nodeSecretToolExec(env), {
      attribute: PROVIDER_KEY_ATTRIBUTE,
    }),
    makeProvider: (section, apiKey) =>
      buildProvider(section, apiKey, { fetch: (url, init) => fetch(url, init) }),
    ...(fakeScript === undefined ? {} : { fakeScript }),
    connectMcp: () =>
      connectOsMcpServers({
        servers: TRUSTED_MCP_SERVERS,
        commandFor: (name) => ({ command: join(mcpDir, name), args: [] }),
        spawn: nodeMcpSpawn(env, info),
        timers,
        clientVersion: build,
        log: info,
      }),
    readModelState: createModelStateReader({
      path: MODEL_STATE_PATH,
      readFile: (path) => readFile(path, "utf8"),
      log: info,
    }),
    audit: createAuditLog({ path: auditLogPath(env, home), fs: nodeAuditFs }),
    now: Date.now,
    newId: () => randomBytes(8).toString("hex"),
    timers,
    log: info,
  });

  let requestStop: (reason: string) => void = () => {};
  const handlers = createOsBinding(agent, {
    requestStop: () => requestStop("stop intent"),
    defer: (callback) => setImmediate(callback),
  });
  const started = await createControlServer({
    platform,
    runDirectory: runDirectoryFor({ platform, home }),
    build,
    handlers,
    deps: nodeControlDeps(),
  });
  if (started.kind === "busy") {
    info("another jarvisd is already running; exiting");
    restoreConsole();
    process.exit(supervisor === undefined ? DAEMON_EXIT.busy : DAEMON_EXIT.ok);
  }
  const server = started.server;
  push = (channel, payload) => server.push(channel, payload);
  server.onConnect(() => agent.resync());

  const shutdown = createShutdown({
    stopCore: () => agent.shutdown(),
    closeControl: () => server.close(),
    exit: (code) => {
      restoreConsole();
      process.exit(code);
    },
    log: info,
    timers,
  });
  requestStop = (reason) => void shutdown.stop(reason);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => requestStop(signal));
  }

  info(`jarvisd (Jarvis OS) starting: pid ${process.pid}, build ${build}, MCP dir ${mcpDir}`);
  await agent.start();
  info(`jarvisd running on ${server.endpoint}`);
}

void main(process.argv.slice(2));
