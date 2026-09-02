import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  clusterUrlSegment,
  createHeadlampManager,
  defaultHeadlampBinary,
  frontendDirFor,
  skippedContexts,
  type HeadlampProcess,
  type HeadlampSpawner,
} from "./headlamp.js";

describe("clusterUrlSegment", () => {
  it("replaces slashes with double hyphens and leaves colons alone", () => {
    expect(clusterUrlSegment("arn:aws:eks:eu-west-1:123456789012:cluster/app_dev")).toBe(
      "arn:aws:eks:eu-west-1:123456789012:cluster--app_dev",
    );
  });

  it("leaves a context with no slash untouched", () => {
    expect(clusterUrlSegment("kind-kind")).toBe("kind-kind");
  });

  it("replaces every slash, not only the first", () => {
    expect(clusterUrlSegment("a/b/c")).toBe("a--b--c");
  });
});

describe("skippedContexts", () => {
  it("returns the contexts not kept", () => {
    expect(skippedContexts(["a", "b", "c", "d"], ["b", "d"])).toEqual(["a", "c"]);
  });

  it("returns nothing when every context is kept", () => {
    expect(skippedContexts(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("ignores a kept context the kubeconfig does not have", () => {
    expect(skippedContexts(["a"], ["a", "gone"])).toEqual([]);
  });

  // The flag silently ignores a name containing "/", so a raw EKS ARN here
  // would filter nothing and every project would list every cluster. The
  // comparison is still made on the raw names — that is the only form the
  // kubeconfig and `clusters:` share.
  it("rewrites a slash-bearing context to the form the flag matches", () => {
    expect(
      skippedContexts(
        ["arn:aws:eks:eu-west-1:1:cluster/Cast_AI", "arn:aws:eks:eu-west-1:2:cluster/app_dev"],
        ["arn:aws:eks:eu-west-1:2:cluster/app_dev"],
      ),
    ).toEqual(["arn:aws:eks:eu-west-1:1:cluster--Cast_AI"]);
  });

  it("keeps a context with no slash unchanged", () => {
    expect(skippedContexts(["kind-kind", "other"], ["other"])).toEqual(["kind-kind"]);
  });
});

describe("frontendDirFor", () => {
  it("is the sibling of the binary", () => {
    expect(frontendDirFor("/Applications/Headlamp.app/Contents/Resources/headlamp-server")).toBe(
      "/Applications/Headlamp.app/Contents/Resources/frontend",
    );
  });
});

describe("defaultHeadlampBinary", () => {
  it("is the app bundle on macOS", () => {
    expect(defaultHeadlampBinary("darwin", {})).toBe(
      "/Applications/Headlamp.app/Contents/Resources/headlamp-server",
    );
  });

  it("is /opt on Linux", () => {
    expect(defaultHeadlampBinary("linux", {})).toBe("/opt/Headlamp/resources/headlamp-server");
  });

  it("follows LOCALAPPDATA on Windows", () => {
    expect(defaultHeadlampBinary("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" })).toBe(
      join("C:\\Users\\a\\AppData\\Local", "Programs", "Headlamp", "resources", "headlamp-server.exe"),
    );
  });
});

function fakeProcess(): HeadlampProcess & { killed: boolean; exit: (code: number) => void } {
  const listeners: ((code: number | null) => void)[] = [];
  return {
    killed: false,
    kill() { this.killed = true; },
    onExit(listener) { listeners.push(listener); },
    exit(code) { for (const listener of listeners) listener(code); },
  };
}

function harness(overrides: Partial<Parameters<typeof createHeadlampManager>[0]> = {}) {
  const spawned: Parameters<HeadlampSpawner>[0][] = [];
  const processes: ReturnType<typeof fakeProcess>[] = [];
  let port = 5000;
  const manager = createHeadlampManager({
    spawn: (args) => {
      spawned.push(args);
      const process = fakeProcess();
      processes.push(process);
      return process;
    },
    findFreePort: () => Promise.resolve(port++),
    waitUntilReady: () => Promise.resolve(true),
    listContexts: () => Promise.resolve(["ctx-a", "ctx-b", "ctx-c"]),
    clusters: {
      opf: [{ name: "dev", context: "ctx-a" }],
      other: [{ name: "prod", context: "ctx-b" }],
    },
    binary: "/bundle/Resources/headlamp-server",
    kubeconfigPath: "/home/u/.kube/config",
    ...overrides,
  });
  return { manager, spawned, processes };
}

describe("createHeadlampManager", () => {
  it("returns a URL naming the context, under the instance's port", async () => {
    const { manager } = harness();
    const result = await manager.open("opf", "ctx-a");
    expect(result).toEqual({ ok: true, url: "http://127.0.0.1:5000/c/ctx-a" });
  });

  it("rewrites a slash in the context to a double hyphen", async () => {
    const { manager } = harness({
      listContexts: () => Promise.resolve(["arn:x:cluster/app_dev"]),
      clusters: { opf: [{ name: "dev", context: "arn:x:cluster/app_dev" }] },
    });
    const result = await manager.open("opf", "arn:x:cluster/app_dev");
    expect(result).toEqual({ ok: true, url: "http://127.0.0.1:5000/c/arn:x:cluster--app_dev" });
  });

  it("spawns once per project, not once per cluster", async () => {
    const { manager, spawned } = harness({
      clusters: { opf: [{ name: "dev", context: "ctx-a" }, { name: "b", context: "ctx-b" }] },
    });
    const first = await manager.open("opf", "ctx-a");
    const second = await manager.open("opf", "ctx-b");
    expect(spawned).toHaveLength(1);
    expect(first).toEqual({ ok: true, url: "http://127.0.0.1:5000/c/ctx-a" });
    expect(second).toEqual({ ok: true, url: "http://127.0.0.1:5000/c/ctx-b" });
  });

  it("spawns separately for a different project", async () => {
    const { manager, spawned } = harness();
    await manager.open("opf", "ctx-a");
    await manager.open("other", "ctx-b");
    expect(spawned).toHaveLength(2);
  });

  it("skips every context the project does not declare", async () => {
    const { manager, spawned } = harness();
    await manager.open("opf", "ctx-a");
    expect(spawned[0]?.skippedContexts).toEqual(["ctx-b", "ctx-c"]);
  });

  // Every EKS context on a real machine contains a slash, and the flag
  // ignores names that still have one — so a manager that passed raw names
  // would filter nothing and every project would list every cluster.
  it("hands the spawner contexts spelled the way the flag matches", async () => {
    const { manager, spawned } = harness({
      listContexts: () =>
        Promise.resolve(["arn:aws:eks:eu-west-1:1:cluster/Cast_AI", "arn:aws:eks:eu-west-1:2:cluster/app_dev"]),
      clusters: { opf: [{ name: "dev", context: "arn:aws:eks:eu-west-1:2:cluster/app_dev" }] },
    });
    await manager.open("opf", "arn:aws:eks:eu-west-1:2:cluster/app_dev");
    expect(spawned[0]?.skippedContexts).toEqual(["arn:aws:eks:eu-west-1:1:cluster--Cast_AI"]);
  });

  it("passes the binary, the derived frontend dir and the kubeconfig", async () => {
    const { manager, spawned } = harness();
    await manager.open("opf", "ctx-a");
    expect(spawned[0]).toMatchObject({
      binary: "/bundle/Resources/headlamp-server",
      frontendDir: "/bundle/Resources/frontend",
      kubeconfigPath: "/home/u/.kube/config",
      port: 5000,
    });
  });

  it("shares an in-flight start rather than spawning twice", async () => {
    let release: (ready: boolean) => void = () => {};
    const { manager, spawned } = harness({
      waitUntilReady: () => new Promise((resolve) => { release = resolve; }),
    });
    const first = manager.open("opf", "ctx-a");
    const second = manager.open("opf", "ctx-a");
    // start() awaits listContexts() then findFreePort() before it ever
    // calls waitUntilReady, so `release` is only assigned two microtask
    // ticks from here — same reasoning as code-server.test.ts's analogous
    // case, with one extra tick for the extra await.
    await Promise.resolve();
    await Promise.resolve();
    release(true);
    expect(await first).toEqual(await second);
    expect(spawned).toHaveLength(1);
  });

  it("kills the process and reports when it never becomes ready", async () => {
    const { manager, processes } = harness({ waitUntilReady: () => Promise.resolve(false) });
    const result = await manager.open("opf", "ctx-a");
    expect(result.ok).toBe(false);
    expect(processes[0]?.killed).toBe(true);
  });

  it("can be retried after a failed start", async () => {
    let ready = false;
    const { manager, spawned } = harness({ waitUntilReady: () => Promise.resolve(ready) });
    expect((await manager.open("opf", "ctx-a")).ok).toBe(false);
    ready = true;
    expect((await manager.open("opf", "ctx-a")).ok).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it("reports a spawn that throws instead of throwing", async () => {
    const { manager } = harness({
      spawn: () => { throw new Error("ENOENT"); },
    });
    expect(await manager.open("opf", "ctx-a")).toEqual({ ok: false, detail: "ENOENT" });
  });

  it("refuses a context the project does not declare", async () => {
    const { manager, spawned } = harness();
    const result = await manager.open("opf", "ctx-c");
    expect(result.ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it("starts a new instance after the old one exits", async () => {
    const { manager, spawned, processes } = harness();
    await manager.open("opf", "ctx-a");
    processes[0]?.exit(1);
    await manager.open("opf", "ctx-a");
    expect(spawned).toHaveLength(2);
  });

  it("kills every instance on stopAll", async () => {
    const { manager, processes } = harness();
    await manager.open("opf", "ctx-a");
    await manager.open("other", "ctx-b");
    manager.stopAll();
    expect(processes.every((process) => process.killed)).toBe(true);
  });
});
