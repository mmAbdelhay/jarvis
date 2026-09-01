import { describe, expect, it } from "vitest";
import { connectionEnv } from "./dbgate.js";

describe("connectionEnv", () => {
  it("produces nothing at all for an empty list", () => {
    expect(connectionEnv([], {})).toEqual({});
  });

  it("maps one connection onto DbGate's per-connection variables", () => {
    const env = connectionEnv(
      [
        {
          id: "main",
          label: "Sail (local)",
          engine: "mysql",
          host: "127.0.0.1",
          port: 3306,
          user: "sail",
          database: "store_saas",
          passwordEnv: "STORE_SAAS_DB_PASSWORD",
        },
      ],
      { STORE_SAAS_DB_PASSWORD: "secret" },
    );

    expect(env).toEqual({
      CONNECTIONS: "main",
      LABEL_main: "Sail (local)",
      ENGINE_main: "mysql@dbgate-plugin-mysql",
      SERVER_main: "127.0.0.1",
      PORT_main: "3306",
      USER_main: "sail",
      DATABASE_main: "store_saas",
      PASSWORD_main: "secret",
    });
  });

  it("lists every connection in CONNECTIONS", () => {
    const env = connectionEnv(
      [
        { id: "main", engine: "mysql" },
        { id: "readonly", engine: "mysql", readonly: true },
      ],
      {},
    );

    expect(env["CONNECTIONS"]).toBe("main,readonly");
    expect(env["READONLY_readonly"]).toBe("1");
    expect(env["READONLY_main"]).toBeUndefined();
  });

  it("asks DbGate to prompt when no password can be resolved", () => {
    const askedFor = connectionEnv([{ id: "main", engine: "mysql", passwordEnv: "NOT_SET" }], {});
    const neverNamed = connectionEnv([{ id: "main", engine: "mysql" }], {});

    expect(askedFor["PASSWORD_MODE_main"]).toBe("askPassword");
    expect(askedFor["PASSWORD_main"]).toBeUndefined();
    expect(neverNamed["PASSWORD_MODE_main"]).toBe("askPassword");
  });

  it("never sets both a password and a prompt for the same connection", () => {
    const env = connectionEnv([{ id: "main", engine: "mysql", passwordEnv: "PW" }], { PW: "s3cret" });

    expect(env["PASSWORD_main"]).toBe("s3cret");
    expect(env["PASSWORD_MODE_main"]).toBeUndefined();
  });

  it("falls back to the connection's own id when it has no label", () => {
    expect(connectionEnv([{ id: "main", engine: "mysql" }], {})["LABEL_main"]).toBe("main");
  });

  it.each([
    ["mysql", "mysql@dbgate-plugin-mysql"],
    ["mariadb", "mariadb@dbgate-plugin-mysql"],
    ["postgres", "postgres@dbgate-plugin-postgres"],
    ["sqlite", "sqlite@dbgate-plugin-sqlite"],
  ] as const)("maps engine %s to %s", (engine, expected) => {
    expect(connectionEnv([{ id: "c", engine }], {})["ENGINE_c"]).toBe(expected);
  });

  it("passes a SQLite file path through as FILE_<id>", () => {
    const env = connectionEnv([{ id: "local", engine: "sqlite", file: "/p/app.sqlite" }], {});

    expect(env["FILE_local"]).toBe("/p/app.sqlite");
    expect(env["SERVER_local"]).toBeUndefined();
  });
});
