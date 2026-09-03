import { spawn } from "node:child_process";
import { runCommand } from "./spawn.js";

/** One container the Docker tab may manage, as `jarvis.yaml` names it.
 *
 *  `container` is a container *name*, never an id. `docker compose down`
 *  followed by `up` gives a container the same name and a brand new id, so
 *  a stored id would break the mapping every time the stack restarted. */
export type DockerEntry = { name: string; container: string };

/** Per-project containers, keyed by project name — the same shape, and the
 *  same reasoning, as ClustersConfig in headlamp.ts. */
export type DockerConfig = Record<string, DockerEntry[]>;

export type ContainerState =
  | "running"
  | "exited"
  | "created"
  | "paused"
  | "restarting"
  | "dead";

export type ContainerFacts = {
  name: string;
  id: string;
  image: string;
  state: ContainerState;
  /** Docker's own human status column — `docker ps`'s `{{.Status}}`, e.g.
   *  "Up 3 hours" or "Exited (0) 2 minutes ago" — shown to the user
   *  unchanged. Deliberately not `inspect`'s `State.Status`, which is the
   *  same terse enum `state` already carries. Empty when `docker ps` did
   *  not name this container (it was created between the two calls). */
  status: string;
  /** Published ports, spelled the way `docker ps` prints them. */
  ports: string[];
  composeProject?: string;
  composeWorkingDir?: string;
  /** The compose service name (`com.docker.compose.service`), for defaulting
   *  a new Settings entry's display name to something more readable than the
   *  container name. Undefined for a container compose did not create. */
  composeService?: string;
};

/**
 * `list()` says *why* it could not answer, because the two reasons need
 * different words in front of the user: no `docker` on PATH is a missing
 * install, a refused socket is a daemon that is not running.
 */
export type DockerListResult =
  | { ok: true; containers: ContainerFacts[] }
  | { ok: false; reason: "not-installed" | "daemon-down"; detail: string };

/** The one side effect this module has, injected so tests never reach a
 *  daemon. `runCommand` from spawn.ts satisfies it once its `env` is bound. */
export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const STATES = new Set<string>([
  "running",
  "exited",
  "created",
  "paused",
  "restarting",
  "dead",
]);

function stateOf(raw: unknown): ContainerState {
  return typeof raw === "string" && STATES.has(raw) ? (raw as ContainerState) : "dead";
}

/** `{"8000/tcp": [{HostIp, HostPort}]}` as `docker ps` would print it. A
 *  null binding is a port the image exposes but nothing published, which is
 *  not something to show in a list of addresses you can open. */
function portsOf(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const ports: string[] = [];
  for (const [containerPort, bindings] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      if (typeof binding !== "object" || binding === null) continue;
      const { HostIp, HostPort } = binding as { HostIp?: unknown; HostPort?: unknown };
      if (typeof HostPort !== "string") continue;
      const host = typeof HostIp === "string" && HostIp !== "" ? HostIp : "0.0.0.0";
      ports.push(`${host}:${HostPort}->${containerPort}`);
    }
  }
  return ports;
}

function labelOf(labels: unknown, key: string): string | undefined {
  if (typeof labels !== "object" || labels === null) return undefined;
  const value = (labels as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `docker ps --no-trunc --format '{{.ID}}\t{{.Status}}'`, one container per
 *  line. A tab is chosen because Docker never prints one inside either
 *  field, so the split is unambiguous — unlike a space, which every status
 *  string is full of. `--no-trunc` makes the id the same full id `inspect`
 *  reports, so the two calls join on an exact match rather than a prefix.
 *  As defensive as factsOf/portsOf: a line without a tab, or an empty one,
 *  is skipped rather than throwing. */
function statusesOf(stdout: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    statuses.set(line.slice(0, tab).trim(), line.slice(tab + 1).trim());
  }
  return statuses;
}

function factsOf(raw: unknown, statuses: Map<string, string>): ContainerFacts | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const entry = raw as Record<string, unknown>;
  const id = entry["Id"];
  const rawName = entry["Name"];
  if (typeof id !== "string" || typeof rawName !== "string") return undefined;

  const config = (entry["Config"] ?? {}) as Record<string, unknown>;
  const state = (entry["State"] ?? {}) as Record<string, unknown>;
  const network = (entry["NetworkSettings"] ?? {}) as Record<string, unknown>;
  const labels = config["Labels"];

  return {
    // Docker returns the name with a leading slash; nobody wants to read it.
    name: rawName.startsWith("/") ? rawName.slice(1) : rawName,
    id,
    image: typeof config["Image"] === "string" ? config["Image"] : "",
    state: stateOf(state["Status"]),
    status: statuses.get(id) ?? "",
    ports: portsOf(network["Ports"]),
    composeProject: labelOf(labels, "com.docker.compose.project"),
    composeWorkingDir: labelOf(labels, "com.docker.compose.project.working_dir"),
    composeService: labelOf(labels, "com.docker.compose.service"),
  };
}

/** Node puts the syscall on `error.code`; anything else is not a missing
 *  binary and must not be reported as one. */
function isMissingBinary(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Success, or the daemon's own words.
 *
 *  Deliberately not the desktop package's GitViewResult: @jarvis/platform
 *  does not depend on @jarvis/desktop, and `detail` is untranslated on
 *  purpose — the same split HeadlampResult uses. The IPC layer turns a
 *  `detail` into the bilingual text the renderer shows. */
export type DockerResult = { ok: true } | { ok: false; detail: string };

/** A running `docker logs -f`. Closing it is what stops the child. */
export type LogFollower = { close(): void };

/** Streaming, so it is not a CommandRunner: `docker logs -f` never exits on
 *  its own and its output has to arrive as it is produced, not at the end. */
export type LogSpawner = (
  command: string,
  args: string[],
  onChunk: (chunk: string) => void,
) => LogFollower;

export type DockerClient = {
  list(): Promise<DockerListResult>;
  start(name: string): Promise<DockerResult>;
  stop(name: string): Promise<DockerResult>;
  restart(name: string): Promise<DockerResult>;
  composeUp(workingDir: string): Promise<DockerResult>;
  composeDown(project: string): Promise<DockerResult>;
  follow(name: string, onChunk: (chunk: string) => void): LogFollower;
};

/**
 * The Docker CLI, behind an injected runner.
 *
 * `list()` is two calls on purpose. `docker ps --format '{{json .}}'`
 * flattens labels into one comma-joined string, which cannot be split back
 * correctly when a label value contains a comma — and a compose working
 * directory is exactly the kind of value that might. `docker inspect`
 * returns a real JSON label map instead: two calls, one parse path, no
 * guessing.
 *
 * The `ps` call asks for the human status column alongside the id because
 * that column is the one thing `inspect` cannot give: `State.Status` is the
 * terse enum `state` already carries, while "Up 3 hours" is composed by the
 * CLI at print time. Asking for it here is Docker's own words for free —
 * still two calls, and no relative-time formatter of ours to keep correct.
 */
export function createDockerClient(run: CommandRunner, spawnLog: LogSpawner): DockerClient {
  /** Every action is the same shape: run it, and on failure hand back what
   *  Docker said rather than a sentence of our own. A refused `stop` is
   *  worth reading — it names the container it could not find. */
  async function act(args: string[]): Promise<DockerResult> {
    let outcome: { code: number; stdout: string; stderr: string };
    try {
      outcome = await run("docker", args);
    } catch (error) {
      return { ok: false, detail: messageOf(error) };
    }
    return outcome.code === 0 ? { ok: true } : { ok: false, detail: outcome.stderr.trim() };
  }

  return {
    async list(): Promise<DockerListResult> {
      let ids: { code: number; stdout: string; stderr: string };
      try {
        ids = await run("docker", ["ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Status}}"]);
      } catch (error) {
        if (isMissingBinary(error)) {
          return { ok: false, reason: "not-installed", detail: messageOf(error) };
        }
        return { ok: false, reason: "daemon-down", detail: messageOf(error) };
      }
      if (ids.code !== 0) {
        return { ok: false, reason: "daemon-down", detail: ids.stderr.trim() };
      }

      const statuses = statusesOf(ids.stdout);
      const list = [...statuses.keys()];
      if (list.length === 0) return { ok: true, containers: [] };

      let inspected: { code: number; stdout: string; stderr: string };
      try {
        inspected = await run("docker", ["inspect", ...list]);
      } catch (error) {
        if (isMissingBinary(error)) {
          return { ok: false, reason: "not-installed", detail: messageOf(error) };
        }
        return { ok: false, reason: "daemon-down", detail: messageOf(error) };
      }
      if (inspected.code !== 0) {
        return { ok: false, reason: "daemon-down", detail: inspected.stderr.trim() };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(inspected.stdout);
      } catch (error) {
        return { ok: false, reason: "daemon-down", detail: messageOf(error) };
      }
      if (!Array.isArray(parsed)) return { ok: true, containers: [] };

      const containers: ContainerFacts[] = [];
      for (const raw of parsed) {
        const facts = factsOf(raw, statuses);
        if (facts !== undefined) containers.push(facts);
      }
      return { ok: true, containers };
    },
    start: (name) => act(["start", name]),
    stop: (name) => act(["stop", name]),
    restart: (name) => act(["restart", name]),
    composeUp: (workingDir) =>
      act(["compose", "--project-directory", workingDir, "up", "-d"]),
    composeDown: (project) => act(["compose", "-p", project, "down"]),
    follow: (name, onChunk) =>
      spawnLog("docker", ["logs", "-f", "--tail", "500", name], onChunk),
  };
}

/** The real client: `docker` resolved on the login shell's PATH.
 *
 *  `env` is passed explicitly for the same reason headlamp.ts passes it — a
 *  GUI-launched app's PATH is not the user's, and `docker` lives in
 *  /opt/homebrew/bin or an OrbStack shim directory that only a login shell
 *  knows about. */
export function createRealDockerClient(env: NodeJS.ProcessEnv = process.env): DockerClient {
  return createDockerClient(
    (command, args) => runCommand(command, args, env),
    (command, args, onChunk) => {
      // stderr is merged into the same callback: a container writes its
      // logs to both streams and the tab shows one interleaved view, which
      // is what `docker logs` itself does.
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => onChunk(chunk));
      }
      // A missing binary arrives as an async "error" event, not a throw.
      // Unhandled it takes the whole app down; reported as a line of log it
      // is something the user can read in the pane they are looking at.
      child.on("error", (error) => onChunk(`${error.message}\n`));
      return { close: () => child.kill() };
    },
  );
}
