import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { runCommand } from "./spawn.js";

/** One entry of a project's `clusters:` list in jarvis.yaml: a kubeconfig
 *  context the Cluster button may open, and the name shown for it. */
export type ClusterEntry = { name: string; context: string };

/** Project name to that project's clusters. A project absent from this
 *  record has its Cluster button disabled — there is nothing to open. */
export type ClustersConfig = Record<string, ClusterEntry[]>;

/**
 * A context name as Headlamp spells it in a URL: `/` becomes `--`, and
 * colons survive untouched, because a colon is legal in a path segment and
 * a slash is not. Observed against 0.45.0 — the EKS context
 * `…:cluster/app_dev` is served at `…:cluster--app_dev`.
 *
 * This is Headlamp's rule, not ours, and nothing promises it is stable.
 * It lives in one function with its own test so an upgrade that changes it
 * fails here loudly, rather than as a tab that quietly loads a 404.
 */
export function clusterUrlSegment(context: string): string {
  return context.replaceAll("/", "--");
}

/**
 * The value for `-skipped-kube-contexts`: every context in the kubeconfig
 * that this project does not declare, spelled the way the flag matches.
 *
 * The difference is computed on raw names — both inputs come from the
 * kubeconfig and from `clusters:`, so raw is the only form in which they
 * compare — and the result is then rewritten, because the flag silently
 * ignores any name containing `/`. Verified against 0.45.0: a raw EKS ARN
 * is not an error, it simply never filters, which would have left every
 * project's sidebar listing every cluster on the machine.
 *
 * Headlamp has no "only these" flag, so the filter has to be a complement.
 * A name in `keep` the kubeconfig does not have is absent from the result —
 * a stale `clusters:` entry should skip nothing, and it will fail visibly
 * when its own tab is opened.
 */
export function skippedContexts(all: readonly string[], keep: readonly string[]): string[] {
  const kept = new Set(keep);
  return all.filter((context) => !kept.has(context)).map(clusterUrlSegment);
}

/** Headlamp's front end ships beside its server inside the app bundle, so
 *  it is derived rather than configured: a bundle where the two had drifted
 *  apart would be broken anyway. */
export function frontendDirFor(binary: string): string {
  return join(dirname(binary), "frontend");
}

/**
 * Where the Headlamp bundle puts its server on each platform. The binary is
 * never distributed alone — every release is a desktop app — but they are
 * all Electron, so the path inside the bundle is the same shape everywhere
 * and only the install root differs. `headlamp.binary` overrides this.
 */
export function defaultHeadlampBinary(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "darwin") {
    return "/Applications/Headlamp.app/Contents/Resources/headlamp-server";
  }
  if (platform === "win32") {
    return join(env["LOCALAPPDATA"] ?? "", "Programs", "Headlamp", "resources", "headlamp-server.exe");
  }
  return "/opt/Headlamp/resources/headlamp-server";
}

export type HeadlampProcess = {
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
};

export type HeadlampSpawner = (args: {
  binary: string;
  frontendDir: string;
  kubeconfigPath: string;
  port: number;
  /** Every context in the kubeconfig that this project does not declare. */
  skippedContexts: string[];
}) => HeadlampProcess;

export type HeadlampResult = { ok: true; url: string } | { ok: false; detail: string };

export type HeadlampManager = {
  /** Starts (or reuses) the instance for `project` and returns the URL of
   *  `context` within it. A context the project does not declare in
   *  `clusters:` is refused rather than opened. */
  open(project: string, context: string): Promise<HeadlampResult>;
  /** Kills every running instance — called on app quit. */
  stopAll(): void;
};

export type HeadlampManagerDeps = {
  spawn: HeadlampSpawner;
  findFreePort: () => Promise<number>;
  waitUntilReady: (url: string) => Promise<boolean>;
  /** Every context name in the user's kubeconfig. Injected because it is a
   *  file read, and because the complement it feeds is the whole of the
   *  per-project filter. */
  listContexts: () => Promise<string[]>;
  clusters: Readonly<ClustersConfig>;
  binary: string;
  kubeconfigPath: string;
};

/**
 * One headlamp-server process per project, started lazily and reused.
 *
 * The divergence from createCodeServerManager is that the key is the
 * project *alone*. A code-server process is rooted at one folder, so two
 * roots need two processes; Headlamp reads one kubeconfig and proxies every
 * context in it, so a project's second cluster is a second tab against the
 * same server, differing only in the URL path.
 *
 * That makes the sidebar the problem instead: an unfiltered instance lists
 * every cluster on the machine, and the project binding would be cosmetic.
 * `-skipped-kube-contexts` carries the filter, computed at spawn time as
 * the complement of what this project declares.
 */
export function createHeadlampManager(deps: HeadlampManagerDeps): HeadlampManager {
  const running = new Map<string, { base: string; process: HeadlampProcess }>();
  // Cold start was measured at roughly twelve seconds — longer than
  // code-server's, so the window in which a second open() could spawn a
  // duplicate is longer too, and pre-warming on hover matters more. Sharing
  // the in-flight promise is what makes the hover free and the second click
  // harmless. Same mechanism as code-server.ts, for the same reason.
  const starting = new Map<string, Promise<HeadlampResult>>();

  async function start(project: string): Promise<HeadlampResult> {
    let base: string;
    let process: HeadlampProcess;
    try {
      const all = await deps.listContexts();
      const keep = (deps.clusters[project] ?? []).map((entry) => entry.context);
      const port = await deps.findFreePort();
      base = `http://127.0.0.1:${port}`;
      process = deps.spawn({
        binary: deps.binary,
        frontendDir: frontendDirFor(deps.binary),
        kubeconfigPath: deps.kubeconfigPath,
        port,
        skippedContexts: skippedContexts(all, keep),
      });
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }

    const ready = await deps.waitUntilReady(base);
    if (!ready) {
      process.kill();
      return { ok: false, detail: "headlamp-server did not become ready in time" };
    }

    running.set(project, { base, process });
    process.onExit(() => running.delete(project));
    return { ok: true, url: base };
  }

  // The `#` is not decoration: Headlamp's front end is a hash-router SPA, so
  // `/c/<cluster>` is served the same index.html as every other path and the
  // router then reads an empty `#/` and lands on the cluster chooser. The
  // cluster is a route, not a path — verified against 0.45.0, where
  // `/c/<cluster>` renders "Choose a cluster" and `/#/c/<cluster>` renders
  // the cluster.
  function urlFor(base: string, context: string): string {
    return `${base}/#/c/${clusterUrlSegment(context)}`;
  }

  return {
    async open(project, context) {
      // A context this project does not declare is refused here rather
      // than handed to a server that would happily proxy it: the whole
      // point of `clusters:` is that the renderer names what the config
      // already allowed.
      const declared = (deps.clusters[project] ?? []).some((entry) => entry.context === context);
      if (!declared) {
        return { ok: false, detail: "cluster is not declared for this project" };
      }

      const existing = running.get(project);
      if (existing !== undefined) return { ok: true, url: urlFor(existing.base, context) };

      const inFlight = starting.get(project);
      if (inFlight !== undefined) {
        const result = await inFlight;
        return result.ok ? { ok: true, url: urlFor(result.url, context) } : result;
      }

      const attempt = start(project);
      starting.set(project, attempt);
      // Cleared on failure as well as success, or a project whose server
      // failed to start once could never be retried without restarting
      // Jarvis — the same trap code-server.ts documents.
      void attempt.then(
        () => starting.delete(project),
        () => starting.delete(project),
      );

      const result = await attempt;
      return result.ok ? { ok: true, url: urlFor(result.url, context) } : result;
    },

    stopAll() {
      for (const { process } of running.values()) process.kill();
      running.clear();
    },
  };
}

/**
 * Every context name in a kubeconfig, in file order.
 *
 * Tolerant on purpose: a malformed or nameless entry is skipped rather than
 * thrown over. This list only decides what an instance *hides*, so a
 * kubeconfig Jarvis cannot fully understand should cost the user a cluster
 * they did not ask about, not the ability to open the one they did.
 */
export function parseKubeContexts(yamlText: string): string[] {
  const document: unknown = parse(yamlText);
  if (typeof document !== "object" || document === null) return [];
  const contexts = (document as Record<string, unknown>)["contexts"];
  if (!Array.isArray(contexts)) return [];
  return contexts.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const name = (entry as Record<string, unknown>)["name"];
    return typeof name === "string" && name !== "" ? [name] : [];
  });
}

/** Reads the kubeconfig on every call rather than caching it: a context
 *  added while Jarvis is running should be openable without a restart, and
 *  this runs once per instance start, not per request. An unreadable
 *  kubeconfig yields no contexts, which skips nothing — the instance then
 *  shows everything, which is wrong but harmless, rather than failing. */
export function createKubeContextLister(path: string): () => Promise<string[]> {
  return async () => {
    try {
      return parseKubeContexts(await readFile(path, "utf8"));
    } catch {
      return [];
    }
  };
}

/**
 * The real spawner: headlamp-server on loopback, serving the front end from
 * beside its own binary.
 *
 * `-listen-addr 127.0.0.1` is why this needs no generated login the way
 * DbGate does — the spike confirmed the flag is honoured, so nothing off
 * this machine can reach the port. Anything already running as this user
 * could, which is the same trade-off code-server.ts documents.
 *
 * `env` is passed explicitly rather than inherited. Authentication runs the
 * kubeconfig's `exec` credential plugin — for EKS, `aws eks get-token` —
 * which client-go resolves on PATH, and a GUI app's PATH is not the user's
 * (see the note in shell.ts). Handing it a login shell's PATH is what makes
 * cluster auth work when Jarvis was not launched from a terminal.
 *
 * Both output streams are piped and forwarded to `log` rather than
 * discarded. headlamp-server is the one hosted app whose failures are
 * invisible from outside: a cluster that will not connect looks identical
 * whether the exec credential plugin is missing, the token was refused, or
 * the API server is unreachable, and the server says which on stderr. An
 * "Unreachable" banner cost hours of bisection precisely because that
 * output was going to /dev/null. Piped streams must be consumed or the
 * child blocks once the pipe buffer fills, which is what the line reader
 * below is for.
 */
export function createRealHeadlampSpawner(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => console.error(line),
): HeadlampSpawner {
  return ({ binary, ...rest }) => {
    const child = spawn(binary, headlampArgs(rest), {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue;
      stream.setEncoding("utf8");
      let pending = "";
      stream.on("data", (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        // The last element is whatever came after the final newline — an
        // incomplete line, held back until the rest of it arrives.
        pending = lines.pop() ?? "";
        for (const line of lines) if (line !== "") log(`[headlamp] ${line}`);
      });
      stream.on("end", () => {
        if (pending !== "") log(`[headlamp] ${pending}`);
        pending = "";
      });
    }

    const exitListeners: ((code: number | null) => void)[] = [];
    // A missing binary arrives as an async "error" event, not a throw. Left
    // unhandled it takes the process down — and the default binary path is
    // missing for anyone who has not installed Headlamp, which the hover
    // pre-warm reaches without a click. Treated as an exit it becomes an
    // ordinary "never became ready" failure the caller already handles.
    // Same shape, and the same reasoning, as dbgate.ts.
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

/**
 * headlamp-server's command line, without the binary itself.
 *
 * Its own function so the flags are pinned by a test rather than only by
 * whatever the spawner happens to pass: `-listen-addr 127.0.0.1` is the
 * entire argument for shipping without a generated login, and dropping it
 * would bind every interface with nothing to notice.
 */
export function headlampArgs({
  frontendDir,
  kubeconfigPath,
  port,
  skippedContexts: skipped,
}: Omit<Parameters<HeadlampSpawner>[0], "binary">): string[] {
  const args = [
    "-html-static-dir", frontendDir,
    "-kubeconfig", kubeconfigPath,
    "-listen-addr", "127.0.0.1",
    "-port", String(port),
  ];
  // Omitted entirely when nothing is skipped: an empty string argument
  // is not obviously the same thing as "skip nothing" to a Go flag
  // parser, and there is no reason to find out.
  if (skipped.length > 0) args.push("-skipped-kube-contexts", skipped.join(","));
  return args;
}

/**
 * The PATH a login shell would give, or undefined if asking failed.
 *
 * Asked once at startup and reused, because it costs a shell start: the
 * point is the user's own .zprofile/.zshrc PATH, which is where `aws`,
 * `gcloud` or whatever else a kubeconfig's exec plugin names actually
 * lives. Failure is not fatal — the caller falls back to the inherited
 * environment, which is right for a Jarvis launched from a terminal.
 */
export async function loginShellPath(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const shell = env["SHELL"];
  if (shell === undefined || shell === "") return undefined;
  try {
    const { code, stdout } = await runCommand(shell, ["-lc", "printf %s \"$PATH\""]);
    const path = stdout.trim();
    return code === 0 && path !== "" ? path : undefined;
  } catch {
    return undefined;
  }
}
