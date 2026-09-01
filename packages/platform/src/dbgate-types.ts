/** The engines Jarvis offers for a DbGate connection. A deliberate subset
 *  of what DbGate itself supports: these are the four served by plugins
 *  that ship in the community package and whose shape this config can
 *  express. */
export type DbGateEngine = "mysql" | "mariadb" | "postgres" | "sqlite";

export const DB_GATE_ENGINES: readonly DbGateEngine[] = ["mysql", "mariadb", "postgres", "sqlite"];

/**
 * One entry of a project's `databases:` list in jarvis.yaml.
 *
 * `id` becomes the suffix of DbGate's own per-connection environment
 * variables (SERVER_main, PORT_main, …), which is why parseDatabases
 * restricts it to characters legal in a variable name.
 *
 * There is deliberately no `password` field: a password is *named* by
 * `passwordEnv` and read from Jarvis's own environment at spawn, or left
 * out entirely so DbGate asks for it and keeps it in that project's own
 * workspace. jarvis.yaml is rewritten by Settings on every save and holds
 * no secrets today; this type is what keeps that true.
 */
export type DbGateConnection = {
  id: string;
  label?: string;
  engine: DbGateEngine;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  /** SQLite only: the database file's path. */
  file?: string;
  passwordEnv?: string;
  readonly?: boolean;
};

/** Project name to that project's connections. A project absent from this
 *  record spawns a bare DbGate that manages its own connections — see the
 *  note on connectionEnv() for why the two modes cannot be mixed. */
export type DatabasesConfig = Record<string, DbGateConnection[]>;
