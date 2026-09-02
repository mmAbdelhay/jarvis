import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { DbGateConnection, DbGateEngine } from "./dbgate-types.js";

/** DbGate names an engine as `<engine>@<plugin package>`; the plugin half
 *  is not derivable from the engine name (mariadb is served by the mysql
 *  plugin), so this is a table, not a template. */
const ENGINE_STRINGS: Record<DbGateEngine, string> = {
  mysql: "mysql@dbgate-plugin-mysql",
  mariadb: "mariadb@dbgate-plugin-mysql",
  postgres: "postgres@dbgate-plugin-postgres",
  sqlite: "sqlite@dbgate-plugin-sqlite",
};

/**
 * Translates a project's connections into the environment DbGate reads at
 * startup — CONNECTIONS plus SERVER_<id>, PORT_<id>, ENGINE_<id> and the
 * rest of its per-connection variables.
 *
 * An empty list returns an empty environment *on purpose*: per DbGate's own
 * documentation, setting CONNECTIONS at all disables its "Add connection"
 * and "Edit connection" commands. Seeding and hand-adding cannot coexist in
 * one instance, so a project that declares nothing must get an instance
 * with no CONNECTIONS key whatsoever — that is the only way its own
 * add-connection UI keeps working.
 *
 * A password is never taken from config. `passwordEnv` names a variable,
 * looked up in `env` (Jarvis's own environment, passed in rather than read
 * from process.env so this stays a pure function). If it names nothing, or
 * names a variable that is unset, DbGate is told to ask instead — the
 * password then lives in that project's own DbGate workspace and never in
 * jarvis.yaml.
 */
export function connectionEnv(
  connections: readonly DbGateConnection[],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (connections.length === 0) return {};

  const result: Record<string, string> = {
    CONNECTIONS: connections.map((connection) => connection.id).join(","),
  };

  for (const connection of connections) {
    const { id } = connection;
    result[`LABEL_${id}`] = connection.label ?? id;
    result[`ENGINE_${id}`] = ENGINE_STRINGS[connection.engine];
    if (connection.host !== undefined) result[`SERVER_${id}`] = connection.host;
    if (connection.port !== undefined) result[`PORT_${id}`] = String(connection.port);
    if (connection.user !== undefined) result[`USER_${id}`] = connection.user;
    if (connection.database !== undefined) result[`DATABASE_${id}`] = connection.database;
    if (connection.file !== undefined) result[`FILE_${id}`] = connection.file;
    if (connection.readonly === true) result[`READONLY_${id}`] = "1";

    const password = connection.passwordEnv === undefined ? undefined : env[connection.passwordEnv];
    if (password === undefined) result[`PASSWORD_MODE_${id}`] = "askPassword";
    else result[`PASSWORD_${id}`] = password;
  }

  return result;
}

export type DbGateProcess = {
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
  /** DbGate announces the port it actually bound on stdout; the manager
   *  has no other way to learn it. Chunks arrive as the OS delivers them
   *  and may split the line anywhere, so listeners must buffer. */
  onStdout(listener: (chunk: string) => void): void;
};

export type DbGateSpawner = (args: {
  env: Record<string, string>;
  workspaceDir: string;
}) => DbGateProcess;

export type DbGateResult =
  | { ok: true; url: string; login: string; password: string }
  | { ok: false; detail: string };

export type DbGateManager = {
  /** Starts (or reuses) the DbGate instance for `project` and returns its
   *  URL plus the credential that instance is guarded with. */
  open(project: string): Promise<DbGateResult>;
  /** Kills every running instance — called on app quit. Each instance is a
   *  live child process; it does not go away with the window on its own. */
  stopAll(): void;
};

export type DbGateManagerDeps = {
  spawn: DbGateSpawner;
  /** Only a *hint*: DbGate's npm build runs getPort() over it and may bind
   *  somewhere else entirely. See waitForPort below. */
  findFreePort: () => Promise<number>;
  waitUntilReady: (url: string) => Promise<boolean>;
  /** DbGate creates its own subdirectories with a non-recursive mkdir, so
   *  the workspace directory itself has to exist before it starts. */
  ensureDir: (path: string) => Promise<void>;
  workspaceRoot: string;
  connectionsFor: (project: string) => readonly DbGateConnection[];
  /** Jarvis's own environment, the source for every `passwordEnv` lookup. */
  env: Readonly<Record<string, string | undefined>>;
  randomPassword: () => string;
  portTimeoutMs?: number;
};

/** The line DbGate's npm build logs once it is listening. Parsing someone
 *  else's log output is a real coupling, and it is deliberate: the npm
 *  build picks its own port, so this is the only place the truth exists.
 *  A release that reformats this line fails loudly (a timeout, then
 *  databaseUnavailable), never silently. */
const PORT_LINE = /DbGate API listening on port (\d+)/;

/** How long to wait for that line. Measured on this machine: a warm
 *  dbgate-serve prints it after ~1.0-1.2s, but the first start after a boot
 *  — cold page cache, npm-installed JS read off disk for the first time —
 *  took 21.6s. The old 20s budget therefore turned the very first Database
 *  open of a session into a flat failure ("Could not open the database
 *  browser."), reproduced in the app. 60s is a timeout for a process that
 *  is genuinely not coming, not a normal cold start; the Workspace now
 *  shows a running "starting…" state for the whole wait, so a long one
 *  reads as slow rather than as frozen. */
const DEFAULT_PORT_TIMEOUT_MS = 60_000;

/**
 * One DbGate process per project, started lazily on first use and reused
 * after that — reopening a project you already have open returns the same
 * URL without spawning a second instance. Structured to mirror
 * createCodeServerManager, with the three differences DbGate forces:
 * the port is read from stdout rather than assigned, the workspace
 * directory is created up front, and every instance is guarded by a
 * generated login because DbGate always binds 0.0.0.0 and offers no
 * bind-address option of its own.
 */
export function createDbGateManager(deps: DbGateManagerDeps): DbGateManager {
  const running = new Map<string, { result: DbGateResult; process: DbGateProcess }>();
  // Projects whose process is spawned but has not answered yet — the same
  // in-flight guard createCodeServerManager carries, for the same measured
  // reason. It matters more here: a second spawn would also mint a second
  // random password, so the credential shown to the user could belong to
  // the instance that ended up orphaned rather than to the one behind the
  // tab. It is also what makes pre-warming free.
  const starting = new Map<string, Promise<DbGateResult>>();

  async function start(project: string): Promise<DbGateResult> {
    const workspaceDir = `${deps.workspaceRoot}/${project}`;
    const password = deps.randomPassword();

    let child: DbGateProcess;
    try {
      await deps.ensureDir(workspaceDir);
      const hint = await deps.findFreePort();
      child = deps.spawn({
        workspaceDir,
        env: {
          PORT: String(hint),
          WORKSPACE_DIR: workspaceDir,
          // DbGate listens on 0.0.0.0 with no way to ask for loopback, so
          // an unguarded instance is reachable from the local network for
          // as long as it runs. This credential is generated per spawn and
          // lives only in the child's environment.
          LOGIN: "jarvis",
          PASSWORD: password,
          ...connectionEnv(deps.connectionsFor(project), deps.env),
        },
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }

    const port = await waitForPort(child, deps.portTimeoutMs ?? DEFAULT_PORT_TIMEOUT_MS);
    if (!port.ok) {
      child.kill();
      return port;
    }

    const url = `http://127.0.0.1:${port.port}/`;
    if (!(await deps.waitUntilReady(url))) {
      child.kill();
      return { ok: false, detail: "dbgate-serve did not become ready in time" };
    }

    const result: DbGateResult = { ok: true, url, login: "jarvis", password };
    running.set(project, { result, process: child });
    child.onExit(() => running.delete(project));
    return result;
  }

  return {
    open(project) {
      const existing = running.get(project);
      if (existing !== undefined) return Promise.resolve(existing.result);

      const inFlight = starting.get(project);
      if (inFlight !== undefined) return inFlight;

      const attempt = start(project);
      starting.set(project, attempt);
      // Cleared on failure too, or a project that failed once could never
      // be retried without restarting Jarvis.
      void attempt.then(
        () => starting.delete(project),
        () => starting.delete(project),
      );
      return attempt;
    },

    stopAll() {
      for (const { process } of running.values()) process.kill();
      running.clear();
    },
  };
}

/** Buffers stdout until DbGate reports the port it bound, or gives up.
 *  A process that exits first is its own answer — waiting out the full
 *  timeout for a child that is already gone helps nobody. */
function waitForPort(
  child: DbGateProcess,
  timeoutMs: number,
): Promise<{ ok: true; port: number } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const settle = (value: { ok: true; port: number } | { ok: false; detail: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(
      () => settle({ ok: false, detail: "dbgate-serve did not report a port in time" }),
      timeoutMs,
    );

    child.onStdout((chunk) => {
      buffer += chunk;
      const match = PORT_LINE.exec(buffer);
      if (match?.[1] !== undefined) settle({ ok: true, port: Number(match[1]) });
    });
    child.onExit(() => settle({ ok: false, detail: "dbgate-serve exited before it started listening" }));
  });
}

/**
 * The real spawner: `dbgate-serve` (community edition, installed globally
 * via npm) with Jarvis's environment layered over the process's own.
 *
 * `cwd` is the project's own workspace directory, and that is not
 * incidental: dbgate-serve's bin script runs `dotenv.config()` against its
 * working directory, so starting it anywhere else would let a stray .env —
 * a project's Laravel .env, say — silently reconfigure the database
 * browser. The workspace directory is one Jarvis created and controls.
 *
 * stdout is piped because the port is only knowable from it. stderr is
 * ignored, same as code-server's spawner.
 */
export function createRealDbGateSpawner(): DbGateSpawner {
  return ({ env, workspaceDir }) => {
    const child = spawn("dbgate-serve", [], {
      cwd: workspaceDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    });

    const exitListeners: ((code: number | null) => void)[] = [];
    // A missing binary arrives as an async "error" event, not a throw. Left
    // unhandled it takes the process down; treated as an exit it becomes an
    // ordinary "never reported a port" failure the caller already handles.
    child.on("error", () => {
      for (const listener of exitListeners) listener(null);
    });

    return {
      kill: () => child.kill(),
      onExit: (listener) => {
        exitListeners.push(listener);
        child.on("exit", (code) => listener(code));
      },
      onStdout: (listener) => {
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => listener(chunk));
      },
    };
  };
}

/** The per-instance web password. 32 hex characters from the platform CSPRNG
 *  — this is the only thing standing between a DbGate instance and anyone
 *  else on the network, so it is not Math.random(). */
export function randomPassword(): string {
  return randomBytes(16).toString("hex");
}
