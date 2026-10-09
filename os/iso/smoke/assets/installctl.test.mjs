import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCallOutput,
  parseRefusal,
  parseSignal,
  REFUSALS,
  sessionCgroup,
} from "./installctl.mjs";

test("unwraps busctl --json=short call output", () => {
  assert.equal(
    parseCallOutput('{"type":"s","data":["{\\"planId\\":\\"p1\\"}"]}\n'),
    '{"planId":"p1"}',
  );
});

test("recognises every contract refusal key", () => {
  for (const reason of REFUSALS) {
    assert.deepEqual(parseRefusal(`Call failed: ${reason}: plain words\n`), {
      reason,
      message: `${reason}: plain words`,
    });
  }
  assert.equal(parseRefusal("Call failed: Access denied\n"), null);
});

test("parses Progress and Finished signals from busctl monitor", () => {
  const progress = parseSignal(
    '{"type":"signal","member":"Progress","interface":"os.jarvis.Installer1","payload":{"type":"sis","data":["copy",42,"files"]}}',
  );
  assert.deepEqual(progress, { member: "Progress", data: ["copy", 42, "files"] });
  assert.equal(parseSignal('{"type":"method_call","member":"Plan"}'), null);
  assert.equal(parseSignal("not json"), null);
});

test("session scope cgroup path", () => {
  assert.equal(
    sessionCgroup(1000, "session-2.scope"),
    "/sys/fs/cgroup/user.slice/user-1000.slice/session-2.scope/cgroup.procs",
  );
});

test("contract resolution refusal keys are present", () => {
  assert.ok(REFUSALS.includes("live-medium"));
  assert.ok(REFUSALS.includes("alongside-no-windows"));
});

test("invalid command returns usage without requiring a session", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [
    new URL("./installctl.mjs", import.meta.url).pathname,
    "invalid",
  ]);
  assert.equal(r.status, 64);
});

test("probe accepts an active user session registered as tty", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(new URL("./session-test-", import.meta.url).pathname);
  try {
    const commands = {
      id: '#!/bin/sh\nprintf "1000\\n"\n',
      loginctl:
        '#!/bin/sh\ncase "$1" in\nshow-user) printf "2\\n" ;;\nshow-session) printf "Active=yes\\nScope=session-2.scope\\nClass=user\\nType=tty\\n" ;;\nesac\n',
      sh: '#!/bin/sh\nprintf "%s\\n" \'{"type":"s","data":["{\\"disks\\":[]}"]}\'\n',
    };
    for (const [name, script] of Object.entries(commands)) {
      writeFileSync(`${dir}/${name}`, script, { mode: 0o755 });
    }
    const result = spawnSync(
      process.execPath,
      [new URL("./installctl.mjs", import.meta.url).pathname, "probe"],
      { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { disks: [] });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("session wrapper drops uid and gid before the command", async () => {
  const { inSession } = await import("./installctl.mjs");
  const args = inSession({ uid: 1000, gid: 1000, scope: "session-2.scope" }, ["busctl", "call"]);
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(new URL("./session-test-", import.meta.url).pathname);
  try {
    writeFileSync(`${dir}/setpriv`, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    args[4] = `${dir}/cgroup.procs`;
    const output = execFileSync(args[0], args.slice(1), {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.deepEqual(output.trim().split("\n"), [
      "--reuid=1000",
      "--regid=1000",
      "--init-groups",
      "--",
      "busctl",
      "call",
    ]);
    assert.match(readFileSync(args[4], "utf8"), /^\d+\n$/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
