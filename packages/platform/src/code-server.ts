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

  return {
    async open(projectPath, folderPath = projectPath) {
      if (!isInside(projectPath, folderPath)) {
        return { ok: false, detail: "editor root is outside the project" };
      }

      // The pair, not the project: two roots of one project are two
      // editors, and each needs its own process rooted where it belongs.
      const key = `${projectPath}\u0000${folderPath}`;
      const existing = running.get(key);
      if (existing !== undefined) return { ok: true, url: existing.url };

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

      running.set(key, { url, process });
      process.onExit(() => running.delete(key));
      return { ok: true, url };
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
          setTimeout(attempt, 300);
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

    return {
      kill: () => child.kill(),
      onExit: (listener) => child.on("exit", (code) => listener(code)),
    };
  };
}
