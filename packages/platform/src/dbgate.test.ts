import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionEnv,
  createDbGateManager,
  createRealDbGateSpawner,
  randomPassword,
  type DbGateProcess,
} from "./dbgate.js";
import type { DbGateConnection } from "./dbgate-types.js";

/** What a fake binary must be called to be found and run on this platform:
 *  a bare name with a shebang on POSIX, a `.cmd` on Windows. */
function fakeName(command: string): string {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

describe("connectionEnv", () => {
  it("produces nothing at all for an empty list", () => {
    expect(connectionEnv([], {})).toEqual({});
  });

  it("maps one connection onto DbGate's per-connection variables", () => {
    const env = connectionEnv(
      [
        {
          id: "main",
          label: "Sail (local)",
          engine: "mysql",
          host: "127.0.0.1",
          port: 3306,
          user: "sail",
          database: "store_saas",
          passwordEnv: "STORE_SAAS_DB_PASSWORD",
        },
      ],
      { STORE_SAAS_DB_PASSWORD: "secret" },
    );

    expect(env).toEqual({
      CONNECTIONS: "main",
      LABEL_main: "Sail (local)",
      ENGINE_main: "mysql@dbgate-plugin-mysql",
      SERVER_main: "127.0.0.1",
      PORT_main: "3306",
      USER_main: "sail",
      DATABASE_main: "store_saas",
      PASSWORD_main: "secret",
    });
  });

  it("lists every connection in CONNECTIONS", () => {
    const env = connectionEnv(
      [
        { id: "main", engine: "mysql" },
        { id: "readonly", engine: "mysql", readonly: true },
      ],
      {},
    );

    expect(env["CONNECTIONS"]).toBe("main,readonly");
    expect(env["READONLY_readonly"]).toBe("1");
    expect(env["READONLY_main"]).toBeUndefined();
  });

  it("asks DbGate to prompt when no password can be resolved", () => {
    const askedFor = connectionEnv([{ id: "main", engine: "mysql", passwordEnv: "NOT_SET" }], {});
    const neverNamed = connectionEnv([{ id: "main", engine: "mysql" }], {});

    expect(askedFor["PASSWORD_MODE_main"]).toBe("askPassword");
    expect(askedFor["PASSWORD_main"]).toBeUndefined();
    expect(neverNamed["PASSWORD_MODE_main"]).toBe("askPassword");
  });

  it("never sets both a password and a prompt for the same connection", () => {
    const env = connectionEnv([{ id: "main", engine: "mysql", passwordEnv: "PW" }], { PW: "s3cret" });

    expect(env["PASSWORD_main"]).toBe("s3cret");
    expect(env["PASSWORD_MODE_main"]).toBeUndefined();
  });

  it("falls back to the connection's own id when it has no label", () => {
    expect(connectionEnv([{ id: "main", engine: "mysql" }], {})["LABEL_main"]).toBe("main");
  });

  it.each([
    ["mysql", "mysql@dbgate-plugin-mysql"],
    ["mariadb", "mariadb@dbgate-plugin-mysql"],
    ["postgres", "postgres@dbgate-plugin-postgres"],
    ["sqlite", "sqlite@dbgate-plugin-sqlite"],
  ] as const)("maps engine %s to %s", (engine, expected) => {
    expect(connectionEnv([{ id: "c", engine }], {})["ENGINE_c"]).toBe(expected);
  });

  it("passes a SQLite file path through as FILE_<id>", () => {
    const env = connectionEnv([{ id: "local", engine: "sqlite", file: "/p/app.sqlite" }], {});

    expect(env["FILE_local"]).toBe("/p/app.sqlite");
    expect(env["SERVER_local"]).toBeUndefined();
  });
});

class FakeProcess implements DbGateProcess {
  killed = false;
  #exit: ((code: number | null) => void)[] = [];
  #stdout: ((chunk: string) => void)[] = [];
  kill(): void {
    this.killed = true;
  }
  onExit(listener: (code: number | null) => void): void {
    this.#exit.push(listener);
  }
  onStdout(listener: (chunk: string) => void): void {
    this.#stdout.push(listener);
  }
  emitExit(code: number | null): void {
    for (const listener of this.#exit) listener(code);
  }
  emitStdout(chunk: string): void {
    for (const listener of this.#stdout) listener(chunk);
  }
}

const READY_LINE = (port: number) => `DBGM-00031 DbGate API listening on port ${port} (NPM build)\n`;

function manager(
  overrides: {
    announce?: (process: FakeProcess, args: { env: Record<string, string> }) => void;
    findFreePort?: () => Promise<number>;
    waitUntilReady?: (url: string) => Promise<boolean>;
    connectionsFor?: (project: string) => readonly DbGateConnection[];
    env?: Record<string, string | undefined>;
    portTimeoutMs?: number;
  } = {},
) {
  const processes: FakeProcess[] = [];
  const spawnArgs: { env: Record<string, string>; workspaceDir: string }[] = [];
  const ensured: string[] = [];
  // A real dbgate-serve prints its port a moment after spawn; the default
  // fake announces the port it was handed as soon as a listener attaches.
  const announce =
    overrides.announce ??
    ((process, args) => process.emitStdout(READY_LINE(Number(args.env["PORT"]))));

  const instance = createDbGateManager({
    spawn: (args) => {
      spawnArgs.push(args);
      const process = new FakeProcess();
      processes.push(process);
      queueMicrotask(() => announce(process, args));
      return process;
    },
    findFreePort: overrides.findFreePort ?? (() => Promise.resolve(51234)),
    waitUntilReady: overrides.waitUntilReady ?? (() => Promise.resolve(true)),
    ensureDir: (path) => {
      ensured.push(path);
      return Promise.resolve();
    },
    workspaceRoot: "/jarvis/dbgate",
    connectionsFor: overrides.connectionsFor ?? (() => []),
    env: overrides.env ?? {},
    randomPassword: () => "pw-fixed",
    portTimeoutMs: overrides.portTimeoutMs ?? 50,
  });
  return { instance, processes, spawnArgs, ensured };
}

describe("createDbGateManager", () => {
  it("returns a ready URL with the generated login", async () => {
    const { instance } = manager();

    const result = await instance.open("acme");

    expect(result).toEqual({
      ok: true,
      url: "http://127.0.0.1:51234/",
      login: "jarvis",
      password: "pw-fixed",
    });
  });

  // DbGate's npm build treats PORT as a starting hint and walks past it if
  // the port is taken, so the requested port is never assumed to be the
  // one it actually listens on.
  it("takes the port from stdout, not from the one it asked for", async () => {
    const { instance } = manager({
      announce: (process) => process.emitStdout(READY_LINE(51999)),
    });

    const result = await instance.open("acme");

    expect(result.ok && result.url).toBe("http://127.0.0.1:51999/");
  });

  it("reads a port line split across two stdout chunks", async () => {
    const { instance } = manager({
      announce: (process) => {
        process.emitStdout("DBGM-00031 DbGate API listen");
        process.emitStdout("ing on port 51777 (NPM build)\n");
      },
    });

    const result = await instance.open("acme");

    expect(result.ok && result.url).toBe("http://127.0.0.1:51777/");
  });

  it("reuses the running instance for a project already open", async () => {
    const { instance, processes } = manager();

    const first = await instance.open("acme");
    const second = await instance.open("acme");

    expect(second).toEqual(first);
    expect(processes).toHaveLength(1);
  });

  it("spawns a separate process per project", async () => {
    const { instance, processes } = manager();

    await instance.open("acme");
    await instance.open("storefront");

    expect(processes).toHaveLength(2);
  });

  it("gives each project its own workspace directory, created before spawn", async () => {
    const { instance, spawnArgs, ensured } = manager();

    await instance.open("storefront");

    expect(spawnArgs[0]?.workspaceDir).toBe("/jarvis/dbgate/storefront");
    expect(spawnArgs[0]?.env["WORKSPACE_DIR"]).toBe("/jarvis/dbgate/storefront");
    expect(ensured).toEqual(["/jarvis/dbgate/storefront"]);
  });

  it("guards every instance with a generated login", async () => {
    const { instance, spawnArgs } = manager();

    await instance.open("acme");

    expect(spawnArgs[0]?.env["LOGIN"]).toBe("jarvis");
    expect(spawnArgs[0]?.env["PASSWORD"]).toBe("pw-fixed");
  });

  it("seeds the project's declared connections", async () => {
    const { instance, spawnArgs } = manager({
      connectionsFor: () => [{ id: "main", engine: "mysql", host: "127.0.0.1" }],
    });

    await instance.open("storefront");

    expect(spawnArgs[0]?.env["CONNECTIONS"]).toBe("main");
    expect(spawnArgs[0]?.env["SERVER_main"]).toBe("127.0.0.1");
  });

  it("sets no CONNECTIONS key at all for a project that declares none", async () => {
    const { instance, spawnArgs } = manager();

    await instance.open("acme");

    expect(spawnArgs[0]?.env["CONNECTIONS"]).toBeUndefined();
  });

  it("kills the process and fails when the port line never arrives", async () => {
    const { instance, processes } = manager({ announce: () => undefined });

    const result = await instance.open("acme");

    expect(result).toEqual({ ok: false, detail: "dbgate-serve did not report a port in time" });
    expect(processes[0]?.killed).toBe(true);
  });

  it("kills the process and fails when it never becomes ready", async () => {
    const { instance, processes } = manager({ waitUntilReady: () => Promise.resolve(false) });

    const result = await instance.open("acme");

    expect(result).toEqual({ ok: false, detail: "dbgate-serve did not become ready in time" });
    expect(processes[0]?.killed).toBe(true);
  });

  it("fails when the process dies before reporting a port", async () => {
    const { instance } = manager({ announce: (process) => process.emitExit(1) });

    const result = await instance.open("acme");

    expect(result).toEqual({ ok: false, detail: "dbgate-serve exited before it started listening" });
  });

  it("forgets an instance whose process exits, and spawns again next time", async () => {
    const { instance, processes } = manager();

    await instance.open("acme");
    processes[0]?.emitExit(0);
    await instance.open("acme");

    expect(processes).toHaveLength(2);
  });

  it("kills every running instance on stopAll", async () => {
    const { instance, processes } = manager();

    await instance.open("acme");
    await instance.open("storefront");
    instance.stopAll();

    expect(processes.map((process) => process.killed)).toEqual([true, true]);
  });

  // Same defect, and the same measurement, as createCodeServerManager's:
  // `running` is only written once the instance has answered (~1.2s warm,
  // ~22s cold), so a second open() inside that window used to spawn a
  // second dbgate-serve — and with it a second random password, so the
  // credential the user was shown could belong to the instance that got
  // orphaned rather than the one behind the tab.
  it("shares one spawn between callers that open the same project while it is starting", async () => {
    let release: (ready: boolean) => void = () => undefined;
    const { instance, processes } = manager({
      waitUntilReady: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });

    const first = instance.open("acme");
    const second = instance.open("acme");
    // ensureDir, findFreePort and the port line are all awaited before the
    // readiness probe exists.
    for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    release(true);

    expect(await second).toEqual(await first);
    expect(processes).toHaveLength(1);
  });

  it("retries after a start that failed, rather than handing back the failure forever", async () => {
    let ready = false;
    const { instance, processes } = manager({ waitUntilReady: () => Promise.resolve(ready) });

    const failed = await instance.open("acme");
    ready = true;
    const second = await instance.open("acme");

    expect(failed.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(processes).toHaveLength(2);
  });

  it("spawns again after stopAll", async () => {
    const { instance, processes } = manager();

    await instance.open("acme");
    instance.stopAll();
    await instance.open("acme");

    expect(processes).toHaveLength(2);
  });
});

describe("createDbGateManager stopping one instance", () => {
  it("kills that project's instance, forgets it, and leaves the others alone", async () => {
    const { instance, processes } = manager();

    await instance.open("acme");
    await instance.open("storefront");
    expect(instance.runningKeys().sort()).toEqual(["acme", "storefront"]);

    instance.stop("acme");

    expect(processes[0]?.killed).toBe(true);
    expect(processes[1]?.killed).toBe(false);
    expect(instance.runningKeys()).toEqual(["storefront"]);
  });

  it("ignores a project it is not running", () => {
    const { instance, processes } = manager();
    instance.stop("acme");
    expect(processes).toHaveLength(0);
  });

  // Stopping is only safe because open() starts it again. A restarted DbGate
  // mints a new password, which is exactly why open() is the only way back in.
  it("starts a fresh process for a project it stopped", async () => {
    const { instance, processes } = manager();

    await instance.open("acme");
    instance.stop("acme");
    const result = await instance.open("acme");

    expect(result.ok).toBe(true);
    expect(processes).toHaveLength(2);
    expect(instance.runningKeys()).toEqual(["acme"]);
  });
});

describe("randomPassword", () => {
  it("returns 32 hex characters", () => {
    expect(randomPassword()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not repeat itself", () => {
    expect(randomPassword()).not.toBe(randomPassword());
  });
});

describe("createRealDbGateSpawner", () => {
  // The same GUI-PATH bug code-server had: `dbgate-serve` lives wherever
  // npm or Homebrew put it, which is not on a Finder-launched app's PATH.
  // The spawn failed as an async "error" event, which the manager reports
  // as "exited before it started listening" — a silent dead Database
  // button in the installed build only.
  it("resolves the binary on the PATH it is handed, not the ambient one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbgate-path-"));
    // A shell script, or on Windows the .cmd shim every npm bin actually is
    // there — which is the case worth proving: only cmd.exe can run one, and
    // only a PATHEXT lookup finds it from the bare name.
    await writeFile(
      join(dir, fakeName("dbgate-serve")),
      process.platform === "win32"
        ? "@echo off\r\necho DbGate API listening on port 3210\r\n"
        : '#!/bin/sh\nprintf "DbGate API listening on port 3210\\n"\n',
      { mode: 0o755 },
    );

    const ambient = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const child = createRealDbGateSpawner({ PATH: dir }, process.platform)({
        env: {},
        workspaceDir: dir,
      });

      let output = "";
      child.onStdout((chunk) => {
        output += chunk;
      });
      await new Promise<number | null>((resolve) => {
        child.onExit(resolve);
      });
      expect(output).toContain("DbGate API listening on port 3210");
    } finally {
      process.env["PATH"] = ambient;
    }
  });

  // The per-spawn LOGIN/PASSWORD/CONNECTIONS must still reach the child,
  // and must win over anything of the same name in the inherited
  // environment — the credential the user is shown belongs to this spawn.
  it("layers the instance environment over the one it inherits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dbgate-env-"));
    await writeFile(
      join(dir, fakeName("dbgate-serve")),
      process.platform === "win32"
        ? "@echo off\r\necho PASSWORD=%PASSWORD% MARKER=%MARKER%\r\n"
        : '#!/bin/sh\nprintf "PASSWORD=$PASSWORD MARKER=$MARKER\\n"\n',
      { mode: 0o755 },
    );

    const child = createRealDbGateSpawner(
      { PATH: dir, MARKER: "inherited", PASSWORD: "stale" },
      process.platform,
    )({
      env: { PASSWORD: "fresh" },
      workspaceDir: dir,
    });

    let output = "";
    child.onStdout((chunk) => {
      output += chunk;
    });
    await new Promise<number | null>((resolve) => {
      child.onExit(resolve);
    });
    expect(output).toContain("PASSWORD=fresh");
    expect(output).toContain("MARKER=inherited");
  });
});
