/** One container the Docker tab may manage, as `jarvis.yaml` names it.
 *
 *  `container` is a container *name*, never an id. `docker compose down`
 *  followed by `up` gives a container the same name and a brand new id, so
 *  a stored id would break the mapping every time the stack restarted. */
export type DockerEntry = { name: string; container: string };

/** Per-project containers, keyed by project name — the same shape, and the
 *  same reasoning, as ClustersConfig in headlamp.ts. */
export type DockerConfig = Record<string, DockerEntry[]>;
