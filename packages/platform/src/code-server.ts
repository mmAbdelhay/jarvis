import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { isAbsolute, relative } from "node:path";

/**
 * One entry of a project's `editors:` list in jarvis.yaml: a folder inside
 * the project that the Editor button can be rooted at, and the name shown
 * for it. `path` is always relative to the project directory — see
 * parseEditors (desktop/src/config.ts) for why an absolute one is refused.
 */
export type EditorRoot = { name: string; path: string };

/** Project name to that project's editor roots. A project absent from this
 *  record keeps the original behaviour: the editor opens at the project
 *  directory itself. Most projects have no entry. */
export type EditorsConfig = Record<string, EditorRoot[]>;

export type CodeServerProcess = {
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
};

export type CodeServerSpawner = (args: {
  port: number;
  userDataDir: string;
  extensionsDir: string;
  /** The folder code-server is rooted at: the project directory, or one of
   *  its configured editor roots. Named for what it is rather than
   *  "projectPath", since the two stopped being the same thing. */
  folderPath: string;
}) => CodeServerProcess;

export type CodeServerResult =
  | { ok: true; url: string }
  | { ok: false; detail: string };

export type CodeServerManager = {
  /** Starts (or reuses) a code-server instance rooted at `folderPath` (the
   *  project directory when omitted) and returns the URL once it is
   *  actually accepting connections. A `folderPath` outside `projectPath`
   *  is refused rather than opened. */
  open(projectPath: string, folderPath?: string): Promise<CodeServerResult>;
  /** Kills every running instance — called on app quit. Each instance is a
   *  live child process; it does not go away with the window on its own. */
  stopAll(): void;
};

export type CodeServerManagerDeps = {
  spawn: CodeServerSpawner;
  findFreePort: () => Promise<number>;
  /** Polls `url` until code-server answers or the attempt is given up on. */
  waitUntilReady: (url: string) => Promise<boolean>;
  userDataDir: string;
  extensionsDir: string;
};

/**
 * One code-server process per (project, root), started lazily on first use
 * and reused after that — reopening a root you already have open returns
 * the same URL without spawning a second instance. A project with no
 * configured root has exactly one, at the project directory, which is what
 * "one per project" meant before `editors:` existed. The real filesystem/
 * network/process wiring lives behind the injected deps (createCodeServer*
 * below), so this orchestration — reuse, one-per-project, cleanup on a
 * failed readiness check, cleanup on exit — is testable with a fake process
 * and no real port or binary.
 */
export function createCodeServerManager(deps: CodeServerManagerDeps): CodeServerManager {
  const running = new Map<string, { url: string; process: CodeServerProcess }>();
  // Projects whose process has been spawned but has not answered yet.
  // `running` is only populated once readiness is confirmed, and readiness
  // was measured at ~1.2s warm and ~9s cold — a long window in which a
  // second open() (an impatient second click, or the pre-warm on hover
  // followed by the click it exists to serve) used to spawn a *second*
  // code-server and orphan one of them until quit. Sharing the in-flight
  // promise is also what makes pre-warming free: the click costs nothing
  // beyond whatever is left of a start already under way.
  const starting = new Map<string, Promise<CodeServerResult>>();

  async function start(projectPath: string, folderPath: string): Promise<CodeServerResult> {
    let port: number;
    let process: CodeServerProcess;
    try {
      port = await deps.findFreePort();
      process = deps.spawn({
        port,
        userDataDir: deps.userDataDir,
        extensionsDir: deps.extensionsDir,
        folderPath,
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }

    const url = `http://127.0.0.1:${port}/?folder=${encodeURIComponent(folderPath)}`;

    const ready = await deps.waitUntilReady(url);
    if (!ready) {
      process.kill();
      return { ok: false, detail: "code-server did not become ready in time" };
    }

    const key = `${projectPath}\u0000${folderPath}`;
    running.set(key, { url, process });
    process.onExit(() => running.delete(key));
    return { ok: true, url };
  }

  return {
    open(projectPath, folderPath = projectPath) {
      if (!isInside(projectPath, folderPath)) {
        return Promise.resolve({ ok: false, detail: "editor root is outside the project" });
      }

      // The pair, not the project: two roots of one project are two
      // editors, and each needs its own process rooted where it belongs.
      // It is also the key the in-flight map must use, or a start for one
      // root would be handed back as the answer for another.
      const key = `${projectPath}\u0000${folderPath}`;

      const existing = running.get(key);
      if (existing !== undefined) return Promise.resolve({ ok: true, url: existing.url });

      const inFlight = starting.get(key);
      if (inFlight !== undefined) return inFlight;

      const attempt = start(projectPath, folderPath);
      starting.set(key, attempt);
      // Cleared on failure as well as success, or a root that failed to
      // start once could never be retried without restarting Jarvis.
      void attempt.then(
        () => starting.delete(key),
        () => starting.delete(key),
      );
      return attempt;
    },

    stopAll() {
      for (const { process } of running.values()) process.kill();
      running.clear();
    },
  };
}

/**
 * Whether `folderPath` is `projectPath` or something under it, decided on
 * the strings alone. Deliberately not resolvesInside(): this runs before a
 * process is spawned, not before a file is read, and the paths it judges
 * come from parseEditors — which already refuses anything absolute or
 * climbing, so there is no symlink to chase, only a last check that the
 * two layers agree.
 */
function isInside(projectPath: string, folderPath: string): boolean {
  const rel = relative(projectPath, folderPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Asks the OS for a free TCP port by binding to port 0 and reading back
 *  what it chose, then releasing it immediately. There is a narrow race
 *  (something else could claim the port between this call returning and
 *  code-server binding it) — accepted, same as any "find a free port then
 *  hand it to a different process" pattern; a bind failure surfaces as an
 *  ordinary readiness-timeout in open() above, not a crash. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("Could not determine a free port"));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

/** How long to wait between readiness probes. Measured against a real
 *  code-server: the earliest instant it answered was 1087ms, and the old
 *  300ms grid resolved at 1261ms — up to a fifth of a second of a warm open
 *  spent asleep on a server that was already up. A loopback GET that is
 *  refused costs microseconds, so the grid can be much finer; 25ms bounds
 *  the waste at roughly the cost of one refused connection. It is not the
 *  bulk of the wait (process boot is), but it is the part that was ours. */
const READY_POLL_INTERVAL_MS = 25;

/** Polls `url` with plain GET requests until code-server answers with any
 *  HTTP response (even an auth challenge counts — the process is up) or
 *  `timeoutMs` elapses. */
export function waitUntilReady(url: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const attempt = (): void => {
      fetch(url, { signal: AbortSignal.timeout(1_000) })
        .then(() => resolve(true))
        .catch(() => {
          if (Date.now() >= deadline) {
            resolve(false);
            return;
          }
          setTimeout(attempt, READY_POLL_INTERVAL_MS);
        });
    };
    attempt();
  });
}

/**
 * The real spawner: `code-server` bound to loopback only, no auth (safe
 * because nothing outside this machine's own processes can reach 127.0.0.1
 * on a port only Jarvis knows), pointed at one folder — a project, or a
 * configured root inside it.
 *
 * `--auth none` is a real trade-off, not a default taken lightly: anything
 * already running as this user on this Mac could in principle reach the
 * port and use code-server's own terminal. Binding to loopback keeps it off
 * the network; there is currently no further access control beyond that.
 */
export function createRealCodeServerSpawner(): CodeServerSpawner {
  return ({ port, userDataDir, extensionsDir, folderPath }) => {
    const child = spawn(
      "code-server",
      [
        "--auth",
        "none",
        "--bind-addr",
        `127.0.0.1:${port}`,
        "--user-data-dir",
        userDataDir,
        "--extensions-dir",
        extensionsDir,
        "--disable-telemetry",
        "--disable-update-check",
        folderPath,
      ],
      { stdio: "ignore" },
    );

    const exitListeners: ((code: number | null) => void)[] = [];
    // A code-server that is not installed arrives as an async "error"
    // event, not a throw. Left unhandled it takes the process down; treated
    // as an exit it becomes an ordinary "never reported a port" failure the
    // caller already handles. Same as dbgate.ts and headlamp.ts.
    child.on("error", () => {
      for (const listener of exitListeners) listener(null);
    });

    return {
      kill: () => child.kill(),
      onExit: (listener) => {
        exitListeners.push(listener);
        child.on("exit", (code) => listener(code));
      },
    };
  };
}
