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
  /** Docker's own `State.Status` string, shown to the user unchanged. */
  status: string;
  /** Published ports, spelled the way `docker ps` prints them. */
  ports: string[];
  composeProject?: string;
  composeWorkingDir?: string;
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

function factsOf(raw: unknown): ContainerFacts | undefined {
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
    status: typeof state["Status"] === "string" ? state["Status"] : "",
    ports: portsOf(network["Ports"]),
    composeProject: labelOf(labels, "com.docker.compose.project"),
    composeWorkingDir: labelOf(labels, "com.docker.compose.project.working_dir"),
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

export type DockerClient = {
  list(): Promise<DockerListResult>;
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
 */
export function createDockerClient(run: CommandRunner): DockerClient {
  return {
    async list(): Promise<DockerListResult> {
      let ids: { code: number; stdout: string; stderr: string };
      try {
        ids = await run("docker", ["ps", "-aq"]);
      } catch (error) {
        if (isMissingBinary(error)) {
          return { ok: false, reason: "not-installed", detail: messageOf(error) };
        }
        return { ok: false, reason: "daemon-down", detail: messageOf(error) };
      }
      if (ids.code !== 0) {
        return { ok: false, reason: "daemon-down", detail: ids.stderr.trim() };
      }

      const list = ids.stdout.split("\n").filter((line) => line.trim() !== "");
      if (list.length === 0) return { ok: true, containers: [] };

      const inspected = await run("docker", ["inspect", ...list]);
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
        const facts = factsOf(raw);
        if (facts !== undefined) containers.push(facts);
      }
      return { ok: true, containers };
    },
  };
}
