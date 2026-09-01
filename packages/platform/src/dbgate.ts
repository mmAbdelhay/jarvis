import type { DbGateConnection, DbGateEngine } from "./dbgate-types.js";

/** DbGate names an engine as `<engine>@<plugin package>`; the plugin half
 *  is not derivable from the engine name (mariadb is served by the mysql
 *  plugin), so this is a table, not a template. */
const ENGINE_STRINGS: Record<DbGateEngine, string> = {
  mysql: "mysql@dbgate-plugin-mysql",
  mariadb: "mariadb@dbgate-plugin-mysql",
  postgres: "postgres@dbgate-plugin-postgres",
  sqlite: "sqlite@dbgate-plugin-sqlite",
};

/**
 * Translates a project's connections into the environment DbGate reads at
 * startup — CONNECTIONS plus SERVER_<id>, PORT_<id>, ENGINE_<id> and the
 * rest of its per-connection variables.
 *
 * An empty list returns an empty environment *on purpose*: per DbGate's own
 * documentation, setting CONNECTIONS at all disables its "Add connection"
 * and "Edit connection" commands. Seeding and hand-adding cannot coexist in
 * one instance, so a project that declares nothing must get an instance
 * with no CONNECTIONS key whatsoever — that is the only way its own
 * add-connection UI keeps working.
 *
 * A password is never taken from config. `passwordEnv` names a variable,
 * looked up in `env` (Jarvis's own environment, passed in rather than read
 * from process.env so this stays a pure function). If it names nothing, or
 * names a variable that is unset, DbGate is told to ask instead — the
 * password then lives in that project's own DbGate workspace and never in
 * jarvis.yaml.
 */
export function connectionEnv(
  connections: readonly DbGateConnection[],
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (connections.length === 0) return {};

  const result: Record<string, string> = {
    CONNECTIONS: connections.map((connection) => connection.id).join(","),
  };

  for (const connection of connections) {
    const { id } = connection;
    result[`LABEL_${id}`] = connection.label ?? id;
    result[`ENGINE_${id}`] = ENGINE_STRINGS[connection.engine];
    if (connection.host !== undefined) result[`SERVER_${id}`] = connection.host;
    if (connection.port !== undefined) result[`PORT_${id}`] = String(connection.port);
    if (connection.user !== undefined) result[`USER_${id}`] = connection.user;
    if (connection.database !== undefined) result[`DATABASE_${id}`] = connection.database;
    if (connection.file !== undefined) result[`FILE_${id}`] = connection.file;
    if (connection.readonly === true) result[`READONLY_${id}`] = "1";

    const password = connection.passwordEnv === undefined ? undefined : env[connection.passwordEnv];
    if (password === undefined) result[`PASSWORD_MODE_${id}`] = "askPassword";
    else result[`PASSWORD_${id}`] = password;
  }

  return result;
}
