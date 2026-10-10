import { describe, expect, it } from "vitest";
import type { OsAgent } from "./agent-service.js";
import type { AccountService } from "./accounts/service.js";
import { createOsRouter, PHONE_REQUESTS } from "./os-binding.js";

const agent = { language: () => "en" } as unknown as OsAgent;
const phone = { kind: "phone" as const, device: { id: "d1", name: "Pixel" } };
const local = { kind: "local" as const, connection: { id: 1, onClose: () => {} } };

function fakeAccounts(calls: string[]): AccountService {
  const record = (name: string) => async (account?: string) => {
    calls.push(`${name}:${account ?? ""}`);
    return null;
  };
  return {
    status: async () => ({ accounts: [] }),
    install: record("install"),
    login: record("login"),
    logout: record("logout"),
    uninstall: record("uninstall"),
    provider: () => {
      throw new Error("unused");
    },
    shutdown: async () => {},
  } as AccountService;
}

describe("account channels", () => {
  it("lets a phone read account:status and nothing else", async () => {
    expect(PHONE_REQUESTS.has("account:status")).toBe(true);
    for (const ch of ["account:install", "account:login", "account:logout", "account:uninstall"])
      expect(PHONE_REQUESTS.has(ch)).toBe(false);
    const calls: string[] = [];
    const router = createOsRouter({ agent, accounts: fakeAccounts(calls) });
    await expect(router.invoke("account:status", [], phone)).resolves.toEqual({ accounts: [] });
    await expect(
      router.invoke("account:login", [{ account: "claude" }], phone),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
  });

  it("routes local requests with parsed accounts", async () => {
    const calls: string[] = [];
    const router = createOsRouter({ agent, accounts: fakeAccounts(calls) });
    await router.invoke("account:install", [{ account: "gemini" }], local);
    await router.invoke("account:login", [{ account: "gemini" }], local);
    await router.invoke("account:logout", [{ account: "gemini" }], local);
    await router.invoke("account:uninstall", [{ account: "gemini" }], local);
    expect(calls).toEqual(["install:gemini", "login:gemini", "logout:gemini", "uninstall:gemini"]);
    await expect(
      router.invoke("account:login", [{ account: "bard" }], local),
    ).rejects.toMatchObject({ code: "bad-request" });
  });

  it("says unsupported without the service", async () => {
    await expect(
      createOsRouter({ agent }).invoke("account:status", [], local),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});
