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
// JARVISD_SUPERVISOR (set by the unit), JARVIS_TOOL_PROFILE=readonly (the
// Docker image, M2.5 contracts §7 #14: only safe tools, no add-ons, a missing
// jarvis-pkg tolerated, keys from JARVIS_PROVIDER_KEY_<ID>). Provider keys in
// the env are removed from it at start whatever the profile, so no child
// process or log line sees them.
//
// No electron here (core/no-electron.test.ts); process.platform read once, here.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { langFromLocale, type FakeTurn, parseFakeScript, TRUSTED_MCP_SERVERS } from "@jarvis/core";
import {
  auditLogPath,
  createAuditLog,
  createSecretToolStore,
  nodeAuditFs,
  connectMcpServer,
  nodeMcpSpawn,
  nodeSecretToolExec,
  MEMORY_KEY_LABEL,
  PROVIDER_KEY_ATTRIBUTE,
} from "@jarvis/platform/model";
import {
  createOllamaEmbedder,
  openVectorCache,
  removeMemoryFile,
  type VectorCache,
} from "@jarvis/platform/store";
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
import { createEnvKeyStore, takeEnvProviderKeys } from "./provider-keys.js";
import { createMemoryBackendOpener } from "./memory-backend.js";
import { connectOsMcpServers } from "./mcp-servers.js";
import { createModelStateReader } from "./model-state-reader.js";
import { audioPlayer, onPath, PiperSpeech, runCommandWithLimits } from "@jarvis/platform/voice";
import { createBridge } from "@jarvis/remote";
import { listenTls, loadCertificate, nodeFs, nodeTimers } from "@jarvis/remote/listen";
import { createLockStore } from "./lock-store.js";
import { createOsBinding, createOsRouter, type OsRouter } from "./os-binding.js";
import { createOsRemote } from "./os-remote.js";
import { createSessionEnv } from "./session-env.js";
import { readOsRemoteConfig, writeOsRemoteSection } from "./remote-config.js";
import {
  createVoiceIo,
  PIPER_BIN,
  resolveVoiceModels,
  type Speaker,
  VOICE_DIR,
  WHISPER_BIN,
} from "./voice-io.js";
import { createOsVoice } from "./voice-service.js";

import {
  LOCK_CLIENT_PATH,
  lockStatePath,
  buildStampCandidates,
  MODEL_STATE_PATH,
  mcpConfigDir,
  mcpDirFrom,
  memoryDbPath,
  osConfigPath,
  readOsBuildId,
  registryIndexPath,
  toolIndexPath,
} from "./os-paths.js";
import { buildProvider } from "./provider-factory.js";
import {
  createRegistryServers,
  resolveRuntimeDir,
  nodeHashFile,
  nodeRunProbe,
  nodeStartTimer,
  nodeVerifyUnpacked,
  nodeWatchDirectory,
} from "./registry-servers.js";

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

  const envKeys = takeEnvProviderKeys(process.env);
  const readonlyProfile = process.env["JARVIS_TOOL_PROFILE"] === "readonly";
  if (readonlyProfile) {
    info(`read-only tool profile: safe tools only; ${envKeys.size} provider key(s) from the env`);
  } else if (envKeys.size > 0) {
    info("JARVIS_PROVIDER_KEY_* is ignored outside the read-only tool profile");
  }
  const env = { ...process.env };
  const mcpDir = mcpDirFrom(env);
  // Rafiq M3 §5.14: host servers get the graphical session's display and
  // desktop from the user manager, re-read before each turn (session-env.ts).
  const sessionEnv = createSessionEnv({
    base: env,
    read: async () => {
      const ran = await runCommandWithLimits(
        "systemctl",
        ["--user", "show-environment"],
        { timeoutMs: 5_000, maxOutputBytes: 262_144 },
        env,
      );
      return ran.code === 0 && !ran.timedOut && !ran.truncated ? ran.stdout : undefined;
    },
  });
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
  const runtimeDir =
    resolveRuntimeDir(env, process.getuid?.()) ?? `/run/user/${process.getuid?.() ?? 0}`;
  const registryServers = createRegistryServers({
    home,
    runtimeDir,
    dir: mcpConfigDir(home),
    indexPath: registryIndexPath(home),
    now: Date.now,
    listDir: async (dir) => {
      try {
        return await readdir(dir);
      } catch (thrown) {
        if ((thrown as { code?: unknown }).code === "ENOENT") return [];
        throw thrown;
      }
    },
    readFile: (path) => readFile(path, "utf8"),
    hashFile: nodeHashFile,
    verifyUnpacked: nodeVerifyUnpacked,
    startTimer: nodeStartTimer(env),
    runProbe: nodeRunProbe(env),
    connect: (name, argv) =>
      connectMcpServer({
        name,
        command: argv[0] ?? "systemd-run",
        args: argv.slice(1),
        spawn: nodeMcpSpawn(env, info),
        timers,
        clientVersion: build,
        log: info,
      }),
    log: info,
  });
  let vectorCache: VectorCache | undefined;
  try {
    vectorCache = openVectorCache({ path: toolIndexPath(home), now: Date.now });
  } catch (thrown) {
    error(`the tool index cache is unavailable: ${describe(thrown)}`);
  }
  // Tool search may cache tool descriptions in clear; memory gets its own
  // embedder with NO cache, so memory text never lands in tool-index.sqlite.
  const embedder = createOllamaEmbedder({
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    log: info,
    ...(vectorCache === undefined ? {} : { cache: vectorCache }),
  });
  const memoryEmbedder = createOllamaEmbedder({
    fetch: (url, init) => fetch(url, init),
    now: Date.now,
    log: info,
  });
  const memory = createMemoryBackendOpener({
    path: memoryDbPath(home),
    secrets: createSecretToolStore(nodeSecretToolExec(env), { label: MEMORY_KEY_LABEL }),
    fileExists: existsSync,
    removeFile: removeMemoryFile,
    randomKey: () => randomBytes(32),
    newId: () => randomBytes(8).toString("hex"),
    now: Date.now,
    log: info,
  });
  let push: (channel: string, payload: unknown) => void = () => {};
  const configIo = {
    readFile: (path: string) => readFile(path, "utf8"),
    writeFile: writeAtomically,
  };
  // Rafiq M3 §2/§3: the lock state survives a jarvisd restart, never a reboot.
  const lockPath = lockStatePath(env);
  if (lockPath === undefined)
    info("XDG_RUNTIME_DIR is not set: the lock state is kept in memory only");
  const lockStore =
    lockPath === undefined
      ? undefined
      : createLockStore(lockPath, {
          readFile: (path) => readFile(path, "utf8"),
          writeFile: writeAtomically,
        });

  // Rafiq M3 §2, §4: push-to-talk with Jarvis's whisper and Piper wrappers.
  const models = resolveVoiceModels({
    dir: VOICE_DIR,
    whisperBin: WHISPER_BIN,
    piperBin: PIPER_BIN,
    memTotalBytes: totalmem(),
    exists: existsSync,
  });
  const player = audioPlayer("linux", (command) => onPath(command, env));
  const speakers: Partial<Record<"en" | "ar", Speaker>> = {};
  for (const lang of ["en", "ar"] as const) {
    const installed = models.tts[lang];
    if (installed !== undefined) {
      speakers[lang] = new PiperSpeech({
        binary: models.piperBin,
        model: installed.path,
        platform: "linux",
        player,
      });
    }
  }
  const voiceIo = createVoiceIo({
    language: () => agent.language(),
    models,
    // mkdtemp makes a 0700 directory; the runtime dir is per-login tmpfs.
    makeTempDir: () => mkdtemp(join(env["XDG_RUNTIME_DIR"] ?? tmpdir(), "jarvis-voice-")),
    writeFile: (path, bytes) => writeFile(path, bytes, { mode: 0o600 }),
    removeDir: (path) => rm(path, { recursive: true, force: true }),
    run: async (command, args) => {
      const ran = await runCommandWithLimits(
        command,
        args,
        { timeoutMs: 60_000, maxOutputBytes: 1_048_576 },
        env,
      );
      // A timeout or a cut-off stream is a failure, never a short transcript.
      const code = ran.timedOut || ran.truncated ? ran.code || 1 : ran.code;
      return { code, stdout: ran.stdout, stderr: ran.stderr };
    },
    speakers,
  });
  info(
    `voice: ${models.stt?.id ?? "no speech-to-text model"}; voices: ${Object.keys(speakers).join(", ") || "none"}`,
  );

  let voice: ReturnType<typeof createOsVoice> | undefined;
  const agent = createOsAgent({
    defaultLanguage: langFromLocale({ LANG: process.env["LANG"] }),
    push: (channel, payload) => push(channel, payload),
    configPath: osConfigPath(home),
    configIo,
    ...(lockStore === undefined ? {} : { lockStore }),
    voiceAvailability: () => voice?.availability() ?? voiceIo.availability(),
    secrets: readonlyProfile
      ? createEnvKeyStore(new Map())
      : createSecretToolStore(nodeSecretToolExec(env)),
    providerKeys: readonlyProfile
      ? createEnvKeyStore(envKeys)
      : createSecretToolStore(nodeSecretToolExec(env), {
          attribute: PROVIDER_KEY_ATTRIBUTE,
        }),
    ...(readonlyProfile ? { toolProfile: "readonly" as const } : {}),
    makeProvider: (section, apiKey) =>
      buildProvider(section, apiKey, {
        fetch: (url, init) => fetch(url, init),
        language: () => agent.language(),
      }),
    ...(fakeScript === undefined ? {} : { fakeScript }),
    connectMcp: async () => {
      await sessionEnv.changed();
      return connectOsMcpServers({
        // The image ships no jarvis-pkg (M2.5 contracts §6, §7 #14).
        servers: readonlyProfile
          ? TRUSTED_MCP_SERVERS.filter((name) => existsSync(join(mcpDir, name)))
          : TRUSTED_MCP_SERVERS,
        commandFor: (name) => ({ command: join(mcpDir, name), args: [] }),
        spawn: nodeMcpSpawn(sessionEnv.current(), info),
        timers,
        clientVersion: build,
        log: info,
      });
    },
    sessionChanged: () => sessionEnv.changed(),
    ...(readonlyProfile ? {} : { registryServers }),
    embedder,
    memoryEmbedder,
    memory,
    watchRegistry: (onChange) => nodeWatchDirectory(mcpConfigDir(home), onChange, info),
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

  voice = createOsVoice({
    io: voiceIo,
    agent,
    push: (channel, payload) => push(channel, payload),
    log: info,
  });
  const remoteDir = join(home, ".config", "jarvis", "remote");
  let router: OsRouter | undefined;
  const remote = createOsRemote({
    language: () => agent.language(),
    createBridge,
    io: {
      dir: remoteDir,
      fs: nodeFs,
      random: randomBytes,
      now: Date.now,
      timers: nodeTimers,
      listen: listenTls,
      loadCertificate: (config) =>
        loadCertificate(config, {
          fs: nodeFs,
          dir: remoteDir,
          random: randomBytes,
          now: Date.now,
          enforceFileModes: true,
        }),
      // No sidecar proxy on Rafiq.
      createProxy: () => undefined,
      enforceFileModes: true,
      log: info,
    },
    router: () => {
      if (router === undefined) throw new Error("router not ready");
      return router;
    },
    readConfig: () => readOsRemoteConfig(osConfigPath(home), configIo),
    writeConfig: (patch) => writeOsRemoteSection(osConfigPath(home), patch, configIo),
    push: (channel, payload) => push(channel, payload),
    log: info,
  });
  router = createOsRouter({
    agent,
    voice,
    remote,
    // Rafiq M3 §3: the kernel names the peer program; only jarvis-lock may lock or unlock.
    isLockClient: async (connection) => (await connection.peerExecutable?.()) === LOCK_CLIENT_PATH,
  });
  let requestStop: (reason: string) => void = () => {};
  const handlers = createOsBinding(router, {
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
  push = (channel, payload) => {
    server.push(channel, payload);
    // Only agent:events and sys:snapshot ever reach a phone (phone-policy.ts).
    remote.forward(channel, payload);
  };
  server.onConnect(() => {
    agent.resync();
    voice?.resync();
    remote.resync();
  });

  const shutdown = createShutdown({
    stopCore: async () => {
      await remote
        .stop()
        .catch((thrown: unknown) => error(`phone bridge stop: ${describe(thrown)}`));
      voice?.stop();
      await agent.shutdown();
      vectorCache?.close();
    },
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

  info(`jarvisd (Rafiq) starting: pid ${process.pid}, build ${build}, MCP dir ${mcpDir}`);
  await agent.start();
  try {
    await remote.start();
  } catch (thrown) {
    error(`phone bridge did not start: ${describe(thrown)}`);
  }

  info(`jarvisd running on ${server.endpoint}`);
}

void main(process.argv.slice(2));
