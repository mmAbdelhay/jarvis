import { spawn } from "node:child_process";
import { spawnTarget } from "./executable.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { shellCommand } from "./shell.js";
import { runCommand } from "./spawn.js";
import { resolveEnv, type EnvSource } from "./pty.js";

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
  /** Kills one instance and forgets it, so the next open() starts a fresh
   *  one. The key is the project name: one
   *  headlamp-server serves every context that project declares. An unknown key is a no-op.
   *
   *  Stopping is safe precisely because open() restarts: nothing about a
   *  running instance is state the user owns. createSidecarReaper is what
   *  decides an instance has gone unneeded for long enough. */
  stop(key: string): void;
  /** Every key `stop` would act on — what the reaper sweeps. */
  runningKeys(): string[];
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

    stop(key) {
      const instance = running.get(key);
      if (instance === undefined) return;
      running.delete(key);
      instance.process.kill();
    },

    runningKeys() {
      return [...running.keys()];
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
  env: EnvSource = process.env,
  log: (line: string) => void = (line) => console.error(line),
  platform?: NodeJS.Platform,
): HeadlampSpawner {
  return ({ binary, ...rest }) => {
    const resolved = resolveEnv(env);
    // headlamp-server is a real executable inside the desktop app on every
    // platform; the resolution only matters for the `.exe` suffix Windows
    // needs when the configured path omits it.
    const target = spawnTarget(binary, headlampArgs(rest), resolved, platform ?? "linux");
    const child = spawn(target.file, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: resolved,
      ...("windowsVerbatimArguments" in target ? { windowsVerbatimArguments: true } : {}),
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
        // A CRLF-terminated line — a Windows build, or a batch file in the
        // test — would otherwise be logged with a stray carriage return on
        // the end of every line.
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line !== "") log(`[headlamp] ${line}`);
        }
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

/** Markers around the PATH the probe prints.
 *
 *  An interactive shell's startup files print things — a MOTD, a version
 *  notice, a fortune — and all of it lands on the same stdout. Delimiting the
 *  one value we asked for is the difference between reading a PATH and
 *  reading a PATH with somebody's welcome banner glued to the front. */
const PATH_START = "__JARVIS_PATH__";
const PATH_END = "__JARVIS_PATH_END__";

/** `printf` rather than `echo`: no trailing newline to trim, and no shell
 *  where `echo` decides to interpret a backslash in a directory name. */
const PATH_PROBE = `printf '${PATH_START}%s${PATH_END}' "$PATH"`;

function extractPath(stdout: string): string | undefined {
  const from = stdout.indexOf(PATH_START);
  const to = stdout.indexOf(PATH_END);
  if (from === -1 || to === -1 || to < from) return undefined;
  const path = stdout.slice(from + PATH_START.length, to).trim();
  return path === "" ? undefined : path;
}

/**
 * The PATH a login shell would give, or undefined if asking failed.
 *
 * Asked once at startup and reused, because it costs a shell start: the point
 * is the user's own PATH, which is where `claude`, `dbgate-serve`,
 * `code-server`, `aws` or whatever else a kubeconfig's exec plugin names
 * actually lives. A GUI-launched app inherits none of it — Finder and a
 * desktop launcher both give `/usr/bin:/bin:/usr/sbin:/sbin`.
 *
 * It asks an **interactive** login shell, and that is the whole subtlety.
 * `bash -lc` is not interactive, and Debian and Ubuntu's stock ~/.bashrc
 * opens with
 *
 *     case $- in *i*) ;; *) return;; esac
 *
 * so it returns immediately — taking nvm, rbenv, pyenv, mise and every other
 * version manager that installs itself there with it. A tool installed under
 * one of those is then invisible: on the machine this was found on, `claude`
 * and `code-server` resolved (they live in ~/.local/bin, which ~/.profile
 * adds) while `dbgate-serve` did not, because npm had put it in nvm's bin.
 * The Database tab failed with "Could not open the database browser." and
 * nothing else did.
 *
 * The non-interactive form is kept as a fallback for a shell where `-i`
 * fails outright, and both are bounded: an interactive startup file that
 * waits for input would otherwise hang startup, and this runs before the
 * window.
 */
export async function loginShellPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  timeoutMs = DEFAULT_SHELL_PATH_TIMEOUT_MS,
): Promise<string | undefined> {
  const shell = shellCommand(env, platform);

  for (const flags of ["-lic", "-lc"]) {
    try {
      const { code, stdout } = await withTimeout(
        runCommand(shell, [flags, PATH_PROBE]),
        timeoutMs,
      );
      const path = extractPath(stdout);
      // A non-zero exit with a usable PATH still counts: an interactive
      // startup file that ends in an error has still finished building PATH,
      // and refusing it would throw away the answer over someone else's bug.
      if (path !== undefined && (code === 0 || flags === "-lic")) return path;
    } catch {
      // Timed out, or the shell would not start with these flags. Try the
      // next form.
    }
  }
  return undefined;
}

/**
 * `env` with `~/.local/bin` on its PATH.
 *
 * That directory is where Jarvis links everything it installs — piper's
 * binary, and any npm-installed tool whose own bin a login shell cannot see.
 * Linux distributions put it on PATH from ~/.profile; **macOS does not**, and
 * its default is the six entries in /etc/paths. So on a stock Mac the
 * prerequisites screen installed a tool, linked it, and then reported it
 * missing on the next check — while every tab that resolves a sidecar on this
 * same PATH could not find it either.
 *
 * Appended rather than prepended: a tool the user installed themselves, by
 * whatever means they chose, keeps winning.
 */
export function withLocalBin(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): NodeJS.ProcessEnv {
  // Windows has no such convention, and nothing links there on it.
  if (platform === "win32") return env;
  const dir = `${home}/.local/bin`;
  const path = env["PATH"] ?? "";
  if (path.split(":").includes(dir)) return env;
  return { ...env, PATH: path === "" ? dir : `${path}:${dir}` };
}

/** Long enough for a heavy .bashrc on a cold cache, short enough that a
 *  startup file blocking on input does not hold the window hostage. */
const DEFAULT_SHELL_PATH_TIMEOUT_MS = 5_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref?.();
    }),
  ]);
}
