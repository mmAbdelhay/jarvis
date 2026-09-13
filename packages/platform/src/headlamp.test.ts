import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clusterUrlSegment,
  createHeadlampManager,
  createRealHeadlampSpawner,
  defaultHeadlampBinary,
  frontendDirFor,
  headlampArgs,
  loginShellPath,
  parseKubeContexts,
  skippedContexts,
  withLocalBin,
  type HeadlampProcess,
  type HeadlampSpawner,
} from "./headlamp.js";
import * as spawnModule from "./spawn.js";

describe("withLocalBin", () => {
  it("adds ~/.local/bin to a macOS PATH, which never carries it", () => {
    // /etc/paths on a stock Mac, which is what a login shell starts from.
    const env = withLocalBin({ PATH: "/usr/local/bin:/usr/bin:/bin" }, "darwin", "/Users/x");
    expect(env["PATH"]).toBe("/usr/local/bin:/usr/bin:/bin:/Users/x/.local/bin");
  });

  it("appends, so a tool the user installed themselves keeps winning", () => {
    const env = withLocalBin({ PATH: "/opt/homebrew/bin" }, "darwin", "/Users/x");
    expect(env["PATH"]?.split(":")[0]).toBe("/opt/homebrew/bin");
  });

  it("leaves a PATH that already has it alone", () => {
    const source = { PATH: "/home/u/.local/bin:/usr/bin" };
    expect(withLocalBin(source, "linux", "/home/u")).toBe(source);
  });

  it("gives an empty PATH just the one directory, with no stray separator", () => {
    expect(withLocalBin({}, "linux", "/home/u")["PATH"]).toBe("/home/u/.local/bin");
  });

  it("does nothing on Windows, where nothing is linked there", () => {
    const source = { PATH: "C:\\bin" };
    expect(withLocalBin(source, "win32", "C:\\Users\\x")).toBe(source);
  });
});

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
    // join(): spelled with the platform's own separator.
    expect(frontendDirFor("/Applications/Headlamp.app/Contents/Resources/headlamp-server")).toBe(
      join("/Applications/Headlamp.app/Contents/Resources", "frontend"),
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
      join(
        "C:\\Users\\a\\AppData\\Local",
        "Programs",
        "Headlamp",
        "resources",
        "headlamp-server.exe",
      ),
    );
  });
});

function fakeProcess(): HeadlampProcess & { killed: boolean; exit: (code: number) => void } {
  const listeners: ((code: number | null) => void)[] = [];
  return {
    killed: false,
    kill() {
      this.killed = true;
    },
    onExit(listener) {
      listeners.push(listener);
    },
    exit(code) {
      for (const listener of listeners) listener(code);
    },
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
    expect(result).toEqual({ ok: true, url: "http://127.0.0.1:5000/#/c/ctx-a" });
  });

  it("rewrites a slash in the context to a double hyphen", async () => {
    const { manager } = harness({
      listContexts: () => Promise.resolve(["arn:x:cluster/app_dev"]),
      clusters: { opf: [{ name: "dev", context: "arn:x:cluster/app_dev" }] },
    });
    const result = await manager.open("opf", "arn:x:cluster/app_dev");
    expect(result).toEqual({ ok: true, url: "http://127.0.0.1:5000/#/c/arn:x:cluster--app_dev" });
  });

  it("spawns once per project, not once per cluster", async () => {
    const { manager, spawned } = harness({
      clusters: {
        opf: [
          { name: "dev", context: "ctx-a" },
          { name: "b", context: "ctx-b" },
        ],
      },
    });
    const first = await manager.open("opf", "ctx-a");
    const second = await manager.open("opf", "ctx-b");
    expect(spawned).toHaveLength(1);
    expect(first).toEqual({ ok: true, url: "http://127.0.0.1:5000/#/c/ctx-a" });
    expect(second).toEqual({ ok: true, url: "http://127.0.0.1:5000/#/c/ctx-b" });
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
        Promise.resolve([
          "arn:aws:eks:eu-west-1:1:cluster/Cast_AI",
          "arn:aws:eks:eu-west-1:2:cluster/app_dev",
        ]),
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
      frontendDir: join("/bundle/Resources", "frontend"),
      kubeconfigPath: "/home/u/.kube/config",
      port: 5000,
    });
  });

  it("shares an in-flight start rather than spawning twice", async () => {
    let release: (ready: boolean) => void = () => {};
    const { manager, spawned } = harness({
      waitUntilReady: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
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
      spawn: () => {
        throw new Error("ENOENT");
      },
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

describe("createHeadlampManager stopping one instance", () => {
  it("kills that project's server, forgets it, and leaves the others alone", async () => {
    const { manager, processes } = harness();

    await manager.open("opf", "ctx-a");
    await manager.open("other", "ctx-b");
    expect(manager.runningKeys().sort()).toEqual(["opf", "other"]);

    manager.stop("opf");

    expect(processes[0]?.killed).toBe(true);
    expect(processes[1]?.killed).toBe(false);
    expect(manager.runningKeys()).toEqual(["other"]);
  });

  it("ignores a project it is not running", () => {
    const { manager, processes } = harness();
    manager.stop("opf");
    expect(processes).toHaveLength(0);
  });

  // A restarted server binds a new free port, so the URL changes — which is
  // the whole reason BrowserHost asks main where a resumed tab should go.
  it("starts a fresh server, on a new port, for a project it stopped", async () => {
    const { manager, processes } = harness();

    await manager.open("opf", "ctx-a");
    manager.stop("opf");
    const result = await manager.open("opf", "ctx-a");

    expect(result).toEqual({ ok: true, url: "http://127.0.0.1:5001/#/c/ctx-a" });
    expect(processes).toHaveLength(2);
  });
});

describe("parseKubeContexts", () => {
  it("reads every context name in order", () => {
    expect(
      parseKubeContexts(`
apiVersion: v1
contexts:
  - name: kind-kind
    context: { cluster: kind-kind, user: kind-kind }
  - name: "arn:aws:eks:eu-west-1:123456789012:cluster/app_dev"
    context: { cluster: x, user: y }
current-context: kind-kind
`),
    ).toEqual(["kind-kind", "arn:aws:eks:eu-west-1:123456789012:cluster/app_dev"]);
  });

  it("is empty for a kubeconfig with no contexts", () => {
    expect(parseKubeContexts("apiVersion: v1\n")).toEqual([]);
  });

  it("ignores an entry with no name rather than throwing", () => {
    expect(parseKubeContexts("contexts:\n  - context: {}\n  - name: ok\n")).toEqual(["ok"]);
  });
});

describe("loginShellPath", () => {
  const MARKED = (path: string): string => `__JARVIS_PATH__${path}__JARVIS_PATH_END__`;

  function mockShell(result: { code: number; stdout: string; stderr: string }) {
    return vi.spyOn(spawnModule, "runCommand").mockResolvedValue(result);
  }

  it("asks an interactive login shell, which is where version managers live", async () => {
    // `bash -lc` is not interactive, and Debian and Ubuntu's stock ~/.bashrc
    // opens with `case $- in *i*) ;; *) return;; esac` — so it returns
    // immediately, taking nvm, rbenv, pyenv and mise with it. A tool
    // installed under one of those is then invisible: on the machine this was
    // found on, `claude` and `code-server` resolved from ~/.local/bin while
    // `dbgate-serve` did not, because npm had put it in nvm's bin. Only the
    // Database tab failed, and it failed with no clue why.
    const spy = mockShell({ code: 0, stdout: MARKED("/home/u/.nvm/bin:/usr/bin"), stderr: "" });
    try {
      expect(await loginShellPath({ SHELL: "/bin/bash" }, "linux")).toBe(
        "/home/u/.nvm/bin:/usr/bin",
      );
      expect(spy.mock.calls[0]?.[1]?.[0]).toBe("-lic");
    } finally {
      spy.mockRestore();
    }
  });

  it("reads only what it asked for, not a startup file's banner", async () => {
    // An interactive shell prints MOTDs, version notices and whatever else a
    // startup file feels like saying, all onto the same stdout.
    const spy = mockShell({
      code: 0,
      stdout: `Welcome to Ubuntu!\nnvm: v0.39.7\n${MARKED("/usr/bin:/bin")}\nbye\n`,
      stderr: "",
    });
    try {
      expect(await loginShellPath({ SHELL: "/bin/bash" }, "linux")).toBe("/usr/bin:/bin");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to a non-interactive login shell when -i will not start", async () => {
    const spy = vi
      .spyOn(spawnModule, "runCommand")
      .mockRejectedValueOnce(new Error("cannot set terminal process group"))
      .mockResolvedValueOnce({ code: 0, stdout: MARKED("/usr/bin"), stderr: "" });
    try {
      expect(await loginShellPath({ SHELL: "/bin/bash" }, "linux")).toBe("/usr/bin");
      expect(spy.mock.calls[1]?.[1]?.[0]).toBe("-lc");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to the passwd shell when SHELL is unset", async () => {
    // $SHELL is exported by a shell, and nothing that starts an app from a
    // desktop launcher, a .desktop entry or Finder is one — so the launcher
    // case, the exact case this function exists to fix, was the one it used
    // to refuse. Every binary was then resolved against a GUI PATH, and the
    // startup report said "No agents are working".
    const spy = mockShell({ code: 0, stdout: MARKED("/opt/homebrew/bin:/usr/bin"), stderr: "" });
    try {
      expect(await loginShellPath({}, "linux")).toBe("/opt/homebrew/bin:/usr/bin");
      expect(spy.mock.calls[0]?.[0]).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("treats an empty SHELL as unset rather than spawning it", async () => {
    const spy = mockShell({ code: 0, stdout: MARKED("/usr/bin"), stderr: "" });
    try {
      await loginShellPath({ SHELL: "" }, "linux");
      expect(spy.mock.calls[0]?.[0]).not.toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps an interactive shell's PATH even when it exits non-zero", async () => {
    // A startup file that ends in an error has still finished building PATH,
    // and throwing the answer away over somebody else's bug helps nobody.
    const spy = mockShell({ code: 1, stdout: MARKED("/usr/bin"), stderr: "some rc error" });
    try {
      expect(await loginShellPath({ SHELL: "/bin/bash" }, "linux")).toBe("/usr/bin");
    } finally {
      spy.mockRestore();
    }
  });

  it("returns undefined when nothing usable comes back", async () => {
    const spy = mockShell({ code: 0, stdout: "no markers here\n", stderr: "" });
    try {
      expect(await loginShellPath({ SHELL: "/bin/bash" }, "linux")).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns undefined when the shell prints an empty PATH", async () => {
    const spy = mockShell({ code: 0, stdout: MARKED(""), stderr: "" });
    try {
      expect(await loginShellPath({ SHELL: "/bin/bash" }, "linux")).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("gives up rather than hanging startup on a shell that waits for input", async () => {
    // This runs before the window. An interactive startup file that blocks on
    // a prompt would otherwise hold the whole app.
    const spy = vi
      .spyOn(spawnModule, "runCommand")
      .mockImplementation(() => new Promise(() => undefined));
    try {
      expect(await loginShellPath({ SHELL: "/bin/bash" }, "linux", 20)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createRealHeadlampSpawner", () => {
  it("reports a missing binary as an exit rather than crashing the process", async () => {
    // A binary that is not there arrives as an async "error" event, not a
    // throw. Unhandled, it takes the whole app down — and the default
    // binary path is missing for anyone who has not installed Headlamp,
    // which the hover pre-warm would reach without a single click.
    const process = createRealHeadlampSpawner({})({
      binary: "/definitely/not/here/headlamp-server",
      frontendDir: "/definitely/not/here/frontend",
      kubeconfigPath: "/home/u/.kube/config",
      port: 4466,
      skippedContexts: [],
    });

    const code = await new Promise<number | null>((resolve) => {
      process.onExit(resolve);
    });
    expect(code).toBeNull();
  });

  it("forwards both output streams to the log, a line at a time", async () => {
    // headlamp-server explains a refused cluster on stderr, and that
    // explanation used to go to /dev/null. Both streams, because it uses
    // stdout for the same purpose depending on the failure.
    const dir = await mkdtemp(join(tmpdir(), "headlamp-log-"));
    // A shell script, or on Windows a batch file — which also proves the
    // spawner starts a .cmd through cmd.exe, the way every npm-installed
    // tool has to be started there.
    const binary = join(
      dir,
      process.platform === "win32" ? "fake-headlamp-server.cmd" : "fake-headlamp-server",
    );
    await writeFile(
      binary,
      process.platform === "win32"
        ? // `<nul set /p` prints without a newline, so the line is split
          // across two writes here too.
          "@echo off\r\n<nul set /p =listening on \r\nping -n 1 127.0.0.1 >nul\r\necho 127.0.0.1\r\n1>&2 echo auth failed\r\n"
        : // Split across two writes so a line has to be reassembled from
          // more than one chunk, which is the case the buffering exists for.
          '#!/bin/sh\nprintf "listening on "\nsleep 0.05\nprintf "127.0.0.1\\n"\n' +
            'printf "auth failed\\n" >&2\n',
      { mode: 0o755 },
    );

    const lines: string[] = [];
    // The host's own platform: the fake is a .cmd on Windows, which only
    // reaches CreateProcess through cmd.exe — see executable.ts.
    const child = createRealHeadlampSpawner(
      {},
      (line) => lines.push(line),
      process.platform,
    )({
      binary,
      frontendDir: join(dir, "frontend"),
      kubeconfigPath: join(dir, "config"),
      port: 4466,
      skippedContexts: [],
    });

    await new Promise<number | null>((resolve) => {
      child.onExit(resolve);
    });
    // "exit" can beat the last stream flush, so settle the event loop.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lines).toContain("[headlamp] listening on 127.0.0.1");
    expect(lines).toContain("[headlamp] auth failed");
    await rm(dir, { recursive: true, force: true });
  });
});
