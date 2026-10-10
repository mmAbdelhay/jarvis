import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemorySecretStore,
  createSecretToolStore,
  type KeyringExec,
  KeyringTimeoutError,
  KeyringUnavailableError,
  MEMORY_KEY_LABEL,
  nodeSecretToolExec,
  PROVIDER_KEY_ATTRIBUTE,
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

describe("attribute-keyed stores (M2.5 contracts §1: provider=<id>)", () => {
  function recorder(stdout = "k-1") {
    const calls: { args: readonly string[]; stdin?: string }[] = [];
    const exec: KeyringExec = async (args, stdin) => {
      calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
      return { code: 0, stdout: args[0] === "lookup" ? stdout : "", stderr: "" };
    };
    return { calls, exec };
  }

  it("looks up, stores and clears by provider=<id>, key on stdin only", async () => {
    const { calls, exec } = recorder();
    const store = createSecretToolStore(exec, { attribute: PROVIDER_KEY_ATTRIBUTE });
    await expect(store.get("work")).resolves.toBe("k-1");
    await store.set("work", "sk-secret");
    await store.remove("work");
    expect(calls).toEqual([
      { args: ["lookup", "service", "jarvis", "provider", "work"] },
      {
        args: [
          "store",
          "--label=Jarvis model provider key",
          "service",
          "jarvis",
          "provider",
          "work",
        ],
        stdin: "sk-secret",
      },
      { args: ["clear", "service", "jarvis", "provider", "work"] },
    ]);
  });

  it("keeps the M1 account attribute by default and takes a label", async () => {
    const { calls, exec } = recorder();
    await createSecretToolStore(exec).get("anthropic https://api.anthropic.com");
    await createSecretToolStore(exec, { label: MEMORY_KEY_LABEL }).set("memory-key", "ab");
    expect(calls[0]?.args).toEqual([
      "lookup",
      "service",
      "jarvis",
      "account",
      "anthropic https://api.anthropic.com",
    ]);
    expect(calls[1]?.args[1]).toBe("--label=Jarvis memory key");
  });
});

describe("nodeSecretToolExec", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A secret-tool on PATH that runs `body` (sh). */
  function fakeSecretTool(body: string): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-secret-tool-"));
    dirs.push(dir);
    const tool = join(dir, "secret-tool");
    writeFileSync(tool, `#!/bin/sh\n${body}\n`);
    chmodSync(tool, 0o755);
    return { PATH: `${dir}:/usr/bin:/bin` };
  }

  it("passes the answer through", async () => {
    const exec = nodeSecretToolExec(fakeSecretTool('cat >/dev/null; printf "sk-1"'));
    await expect(exec(["lookup", "service", "jarvis"])).resolves.toEqual({
      code: 0,
      stdout: "sk-1",
      stderr: "",
    });
  });

  it("gives up on a keyring that waits for a password prompt, then fails fast", async () => {
    let clock = 1_000;
    const exec = nodeSecretToolExec(fakeSecretTool("exec sleep 30"), {
      timeoutMs: 200,
      backoffMs: 60_000,
      now: () => clock,
    });
    const started = Date.now();
    await expect(exec(["lookup", "service", "jarvis"])).rejects.toBeInstanceOf(KeyringTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Within the back-off: no new secret-tool (and no new prompt).
    const again = Date.now();
    await expect(exec(["lookup", "service", "jarvis"])).rejects.toBeInstanceOf(KeyringTimeoutError);
    expect(Date.now() - again).toBeLessThan(150);
    clock += 60_001;
    await expect(exec(["lookup", "service", "jarvis"])).rejects.toBeInstanceOf(KeyringTimeoutError);
  });

  it("keeps the timeout distinct through the store", async () => {
    const exec = nodeSecretToolExec(fakeSecretTool("exec sleep 30"), { timeoutMs: 100 });
    await expect(createSecretToolStore(exec).get("x")).rejects.toBeInstanceOf(KeyringTimeoutError);
  });
});
