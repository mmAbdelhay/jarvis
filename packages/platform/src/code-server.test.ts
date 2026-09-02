import { describe, expect, it, vi } from "vitest";
import {
  createCodeServerManager,
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

function manager(overrides: {
  spawn?: CodeServerSpawner;
  findFreePort?: () => Promise<number>;
  waitUntilReady?: (url: string) => Promise<boolean>;
} = {}) {
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
        projectPath: "/p/acme",
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
