import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codeServerKey,
  createCodeServerManager,
  createRealCodeServerSpawner,
  type CodeServerProcess,
  type CodeServerSpawner,
} from "./code-server.js";

class FakeProcess implements CodeServerProcess {
  killed = false;
  #listeners: ((code: number | null) => void)[] = [];
  kill(): void {
    this.killed = true;
  }
  onExit(listener: (code: number | null) => void): void {
    this.#listeners.push(listener);
  }
  emitExit(code: number | null): void {
    for (const listener of this.#listeners) listener(code);
  }
}

function manager(
  overrides: {
    spawn?: CodeServerSpawner;
    findFreePort?: () => Promise<number>;
    waitUntilReady?: (url: string) => Promise<boolean>;
  } = {},
) {
  const processes: FakeProcess[] = [];
  const spawnArgs: unknown[] = [];
  const spawn: CodeServerSpawner =
    overrides.spawn ??
    ((args) => {
      spawnArgs.push(args);
      const process = new FakeProcess();
      processes.push(process);
      return process;
    });
  const instance = createCodeServerManager({
    spawn,
    findFreePort: overrides.findFreePort ?? (() => Promise.resolve(51234)),
    waitUntilReady: overrides.waitUntilReady ?? (() => Promise.resolve(true)),
    userDataDir: "/jarvis/code-server/user-data",
    extensionsDir: "/jarvis/code-server/extensions",
  });
  return { instance, processes, spawnArgs };
}

describe("createCodeServerManager", () => {
  it("starts a process and returns a ready URL", async () => {
    const { instance } = manager({ findFreePort: () => Promise.resolve(51234) });

    const result = await instance.open("/p/acme");

    expect(result).toEqual({
      ok: true,
      url: "http://127.0.0.1:51234/?folder=%2Fp%2Facme",
    });
  });

  it("passes the port, project path and Jarvis-managed dirs to the spawner", async () => {
    const { instance, spawnArgs } = manager({ findFreePort: () => Promise.resolve(9001) });

    await instance.open("/p/acme");

    expect(spawnArgs).toEqual([
      {
        port: 9001,
        userDataDir: "/jarvis/code-server/user-data",
        extensionsDir: "/jarvis/code-server/extensions",
        folderPath: "/p/acme",
      },
    ]);
  });

  it("reuses the running instance for a project already open, without spawning again", async () => {
    const { instance, processes } = manager();

    const first = await instance.open("/p/acme");
    const second = await instance.open("/p/acme");

    expect(second).toEqual(first);
    expect(processes).toHaveLength(1);
  });

  it("spawns a separate process per project", async () => {
    let port = 51000;
    const { instance, processes } = manager({ findFreePort: () => Promise.resolve(++port) });

    await instance.open("/p/acme");
    await instance.open("/p/storefront");

    expect(processes).toHaveLength(2);
  });

  it("kills the process and reports failure if it never becomes ready", async () => {
    const { instance, processes } = manager({ waitUntilReady: () => Promise.resolve(false) });

    const result = await instance.open("/p/acme");

    expect(result.ok).toBe(false);
    expect(processes[0]?.killed).toBe(true);
  });

  it("starts a fresh process if the project is reopened after its process exited", async () => {
    const { instance, processes } = manager();

    await instance.open("/p/acme");
    processes[0]?.emitExit(1);
    await instance.open("/p/acme");

    expect(processes).toHaveLength(2);
  });

  it("kills every running process on stopAll", async () => {
    const { instance, processes } = manager();
    await instance.open("/p/acme");
    await instance.open("/p/storefront");

    instance.stopAll();

    expect(processes.every((process) => process.killed)).toBe(true);
  });

  // Whatever the project's own path looks like, it must not break the URL
  // or let its characters be interpreted as extra query parameters.
  it("encodes a project path with spaces and special characters", async () => {
    const { instance } = manager();

    const result = await instance.open("/p/my project & co");

    expect(result.ok && result.url).toContain(encodeURIComponent("/p/my project & co"));
  });

  // Measured: a warm code-server takes ~1.2s to answer, a cold one ~9s.
  // `running` was only populated *after* readiness, so every open() during
  // that window spawned another process — a second click on Editor, or the
  // pre-warm on hover followed by the click it exists to serve, both did.
  // The extra process was then orphaned until quit, since the map only ever
  // remembers the last one.
  it("shares one spawn between callers that open the same project while it is starting", async () => {
    let release: (ready: boolean) => void = () => undefined;
    const { instance, processes } = manager({
      waitUntilReady: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });

    const first = instance.open("/p/acme");
    const second = instance.open("/p/acme");
    // findFreePort is awaited before the spawn, so the readiness probe only
    // exists after the microtask queue has drained once.
    await Promise.resolve();
    await Promise.resolve();
    release(true);

    expect(await second).toEqual(await first);
    expect(processes).toHaveLength(1);
  });

  it("still spawns per project when two projects are starting at once", async () => {
    let port = 51000;
    const { instance, processes } = manager({ findFreePort: () => Promise.resolve(++port) });

    await Promise.all([instance.open("/p/acme"), instance.open("/p/storefront")]);

    expect(processes).toHaveLength(2);
  });

  // The in-flight entry must be dropped on failure too, or a project that
  // failed once could never be retried without restarting Jarvis.
  it("retries after a start that failed, rather than handing back the failure forever", async () => {
    let ready = false;
    const { instance, processes } = manager({ waitUntilReady: () => Promise.resolve(ready) });

    const failed = await instance.open("/p/acme");
    ready = true;
    const second = await instance.open("/p/acme");

    expect(failed.ok).toBe(false);
    expect(second.ok).toBe(true);
    expect(processes).toHaveLength(2);
  });

  it("survives a spawner that throws", async () => {
    const { instance } = manager({
      spawn: () => {
        throw new Error("boom");
      },
    });

    const result = await instance.open("/p/acme");

    expect(result.ok).toBe(false);
  });
});

// An editor root is a *sub-folder* of the project (config `editors:`), so a
// running instance is identified by the pair, not by the project alone.
describe("createCodeServerManager rooted at a sub-folder", () => {
  it("opens code-server at the sub-folder, not at the project", async () => {
    const { instance, spawnArgs } = manager({ findFreePort: () => Promise.resolve(9001) });

    const result = await instance.open("/p/acme", "/p/acme/portal-vue");

    expect(spawnArgs).toEqual([
      {
        port: 9001,
        userDataDir: "/jarvis/code-server/user-data",
        extensionsDir: "/jarvis/code-server/extensions",
        folderPath: "/p/acme/portal-vue",
      },
    ]);
    expect(result.ok && result.url).toContain(encodeURIComponent("/p/acme/portal-vue"));
  });

  it("reuses the instance already running for the same root", async () => {
    const { instance, processes } = manager();

    const first = await instance.open("/p/acme", "/p/acme/portal-vue");
    const second = await instance.open("/p/acme", "/p/acme/portal-vue");

    expect(second).toEqual(first);
    expect(processes).toHaveLength(1);
  });

  // Two roots of one project are two editors, and the whole project is a
  // third — the key is (project, root), not project.
  it("spawns a separate instance per root of the same project", async () => {
    let port = 51000;
    const { instance, processes } = manager({ findFreePort: () => Promise.resolve(++port) });

    await instance.open("/p/acme");
    await instance.open("/p/acme", "/p/acme/portal-vue");
    await instance.open("/p/acme", "/p/acme/services/api");

    expect(processes).toHaveLength(3);
  });

  // The manager is the last line before a real process is started at a real
  // path, so it refuses an escape itself rather than trusting parseEditors
  // to have caught it — the same reasoning the API handlers' own
  // "refuse a path outside the project" check records.
  it("refuses a root outside the project, without spawning anything", async () => {
    const { instance, processes } = manager();

    const climbed = await instance.open("/p/acme", "/p/acme/../secrets");
    const elsewhere = await instance.open("/p/acme", "/etc");
    const sibling = await instance.open("/p/acme", "/p/acme-evil");

    expect(climbed.ok).toBe(false);
    expect(elsewhere.ok).toBe(false);
    expect(sibling.ok).toBe(false);
    expect(processes).toEqual([]);
  });

  it("accepts the project directory itself as a root", async () => {
    const { instance } = manager();

    expect((await instance.open("/p/acme", "/p/acme")).ok).toBe(true);
  });

  it("kills a sub-folder instance on stopAll", async () => {
    const { instance, processes } = manager();
    await instance.open("/p/acme", "/p/acme/portal-vue");

    instance.stopAll();

    expect(processes[0]?.killed).toBe(true);
  });
});

describe("createCodeServerManager stopping one instance", () => {
  it("kills that instance, forgets it, and leaves the others alone", async () => {
    const { instance, processes } = manager();

    await instance.open("/p", "/p");
    await instance.open("/p", "/p/web");
    expect(instance.runningKeys()).toHaveLength(2);
    expect(instance.runningKeys()).toContain(codeServerKey("/p", "/p"));

    instance.stop(codeServerKey("/p", "/p"));

    expect(processes[0]?.killed).toBe(true);
    expect(processes[1]?.killed).toBe(false);
    expect(instance.runningKeys()).toEqual([codeServerKey("/p", "/p/web")]);
  });

  it("ignores a key it is not running", () => {
    const { instance, processes } = manager();
    instance.stop(codeServerKey("/p", "/p"));
    expect(processes).toHaveLength(0);
  });

  // Stopping is only safe because open() starts it again — that is what makes
  // an idle editor's 200 MB worth giving back.
  it("starts a fresh process for a root it stopped", async () => {
    const { instance, processes } = manager();

    await instance.open("/p", "/p");
    instance.stop(codeServerKey("/p", "/p"));
    const result = await instance.open("/p", "/p");

    expect(result.ok).toBe(true);
    expect(processes).toHaveLength(2);
    expect(instance.runningKeys()).toEqual([codeServerKey("/p", "/p")]);
  });
});

describe("createRealCodeServerSpawner", () => {
  it("reports a missing binary as an exit rather than crashing the process", async () => {
    // code-server is resolved on PATH, and a binary that is not there
    // arrives as an async "error" event, not a throw. Unhandled, it takes
    // the whole app down rather than disabling one button. PATH is emptied
    // so the lookup fails on a machine that does have code-server too.
    const path = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const spawned = createRealCodeServerSpawner()({
        port: 4455,
        userDataDir: "/tmp/jarvis-test/user-data",
        extensionsDir: "/tmp/jarvis-test/extensions",
        folderPath: "/tmp/jarvis-test",
      });

      const code = await new Promise<number | null>((resolve) => {
        spawned.onExit(resolve);
      });
      expect(code).toBeNull();
    } finally {
      process.env["PATH"] = path;
    }
  });
});

describe("createRealCodeServerSpawner PATH", () => {
  // The bug this covers: launched from Finder, a GUI app's PATH is
  // /usr/bin:/bin:/usr/sbin:/sbin — Homebrew's bin is not on it, so
  // `code-server` was never found and the Editor button failed silently in
  // the installed build while working perfectly from `pnpm start`. The
  // spawner therefore has to take the environment it is given (main.ts
  // hands it a login shell's) rather than inherit this process's.
  it("resolves the binary on the PATH it is handed, not the ambient one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-server-path-"));
    const marker = join(dir, "ran");
    // A shell script, or on Windows the .cmd shim an npm install actually
    // leaves — which only cmd.exe can run, and only a PATHEXT lookup finds.
    await writeFile(
      join(dir, process.platform === "win32" ? "code-server.cmd" : "code-server"),
      process.platform === "win32"
        ? `@echo off\r\ntype nul > "${marker}"\r\n`
        : // Redirection rather than `touch`: the fake runs with only `dir` on
          // its PATH, so it cannot call out to /usr/bin for anything.
          `#!/bin/sh\n: > ${marker}\n`,
      { mode: 0o755 },
    );

    // Emptied, so a machine that really has code-server installed cannot
    // pass this test by accident.
    const ambient = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const spawned = createRealCodeServerSpawner(
        { PATH: dir },
        process.platform,
      )({
        port: 4455,
        userDataDir: join(dir, "user-data"),
        extensionsDir: join(dir, "extensions"),
        folderPath: dir,
      });

      const code = await new Promise<number | null>((resolve) => {
        spawned.onExit(resolve);
      });
      expect(code).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      process.env["PATH"] = ambient;
    }
  });
});
