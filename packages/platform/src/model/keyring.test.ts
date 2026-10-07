import { describe, expect, it } from "vitest";
import {
  createMemorySecretStore,
  createSecretToolStore,
  type KeyringExec,
  KeyringUnavailableError,
  providerAccount,
} from "./keyring.js";

function fakeExec(answers: Array<{ code: number; stdout?: string; stderr?: string } | Error>) {
  const calls: { args: readonly string[]; stdin?: string }[] = [];
  const exec: KeyringExec = async (args, stdin) => {
    calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return { code: next.code, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
  return { exec, calls };
}

describe("createSecretToolStore", () => {
  const account = providerAccount("anthropic", "https://api.anthropic.com");

  it("stores with the secret on stdin, never on argv", async () => {
    const { exec, calls } = fakeExec([{ code: 0 }]);
    await createSecretToolStore(exec).set(account, "sk-ant-secret");
    expect(calls[0]).toEqual({
      args: [
        "store",
        "--label=Jarvis model provider key",
        "service",
        "jarvis",
        "account",
        "anthropic https://api.anthropic.com",
      ],
      stdin: "sk-ant-secret",
    });
    expect(calls[0]?.args.join(" ")).not.toContain("sk-ant-secret");
  });

  it("looks up, answering undefined when there is none", async () => {
    const { exec } = fakeExec([{ code: 0, stdout: "sk-ant-secret" }, { code: 1 }]);
    const store = createSecretToolStore(exec);
    await expect(store.get(account)).resolves.toBe("sk-ant-secret");
    await expect(store.get(account)).resolves.toBeUndefined();
  });

  it("removes", async () => {
    const { exec, calls } = fakeExec([{ code: 0 }]);
    await createSecretToolStore(exec).remove(account);
    expect(calls[0]?.args).toEqual(["clear", "service", "jarvis", "account", account]);
  });

  it("reports a missing secret-tool as KeyringUnavailableError", async () => {
    const missing = Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" });
    const { exec } = fakeExec([missing]);
    await expect(createSecretToolStore(exec).get(account)).rejects.toBeInstanceOf(
      KeyringUnavailableError,
    );
  });

  it.each([
    { code: 1, stderr: "Refused sk-ant-secret in locked collection" },
    new Error("Failed to store sk-ant-secret"),
  ])("never echoes the key from a store failure", async (answer) => {
    const { exec } = fakeExec([answer]);
    const failure = await createSecretToolStore(exec)
      .set(account, "sk-ant-secret")
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("sk-ant-secret");
  });

  it("reports a failed store without echoing the secret", async () => {
    const { exec } = fakeExec([
      { code: 1, stderr: "Cannot create an item in a locked collection" },
    ]);
    const failure = await createSecretToolStore(exec)
      .set(account, "sk-ant-secret")
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("locked collection");
    expect((failure as Error).message).not.toContain("sk-ant-secret");
  });
});

describe("createMemorySecretStore", () => {
  it("round-trips", async () => {
    const store = createMemorySecretStore();
    await store.set("a", "1");
    await expect(store.get("a")).resolves.toBe("1");
    await store.remove("a");
    await expect(store.get("a")).resolves.toBeUndefined();
  });
});
