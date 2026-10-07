#!/usr/bin/env node
// installctl: the install tests' driver for os.jarvis.Installer1 (M2
// contracts §1). Runs as root inside the live guest with the Node from the
// jarvisd package, from the smoke-assets disk; never installed in the ISO.
// Calls go out as the live session user from INSIDE its logind session
// scope, so polkit's allow_active and the backend's UID check apply as for
// the real installer UI.
//
//   installctl probe                                  [--as-user U]
//   installctl plan --choices F --out F               [--as-user U]
//   installctl execute --plan F --secrets F --timeout S [--as-user U]
//
// Exit: 0 ok, 1 failure, 2 timeout, 3 refused, 64 usage.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const BUS = ["os.jarvis.Installer1", "/os/jarvis/Installer1", "os.jarvis.Installer1"];
export const REFUSALS = [
  "no-uefi",
  "live-medium",
  "alongside-no-windows",
  "disk-too-small",
  "ntfs-bitlocker",
  "ntfs-hibernated",
  "ntfs-dirty",
  "alongside-too-small",
  "manual-missing-root",
  "manual-missing-esp",
  "model-does-not-fit",
];

export function parseCallOutput(stdout) {
  return JSON.parse(stdout.trim()).data[0];
}

export function parseRefusal(stderr) {
  const message = stderr.replace(/^Call failed: /, "").trim();
  const reason = REFUSALS.find((key) => message.startsWith(`${key}:`) || message === key);
  return reason ? { reason, message } : null;
}

export function parseSignal(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value.type !== "signal" || !value.payload) return null;
  return { member: value.member, data: value.payload.data };
}

export function sessionCgroup(uid, scope) {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/${scope}/cgroup.procs`;
}

function sh(argv) {
  return execFileSync(argv[0], argv.slice(1), { encoding: "utf8" }).trim();
}

function activeSession(user) {
  const uid = Number(sh(["id", "-u", user]));
  const gid = Number(sh(["id", "-g", user]));
  const ids = sh(["loginctl", "show-user", user, "-p", "Sessions", "--value"]).split(/\s+/);
  for (const id of ids.filter(Boolean)) {
    const properties = Object.fromEntries(sh([
      "loginctl", "show-session", id, "-p", "Active", "-p", "Scope", "-p", "Class", "-p", "Type",
    ]).split("\n").map((line) => line.split("=")));
    if (properties.Active === "yes" && properties.Class === "user" && ["wayland", "x11"].includes(properties.Type)) return { uid, gid, scope: properties.Scope };
  }
  throw new Error(`no active graphical session for ${user}`);
}

export function inSession(session, argv) {
  // sh writes its own pid into the session scope, then becomes the user.
  return [
    "sh", "-c", 'echo $$ > "$1" && shift && uid=$1 gid=$2 && shift 2 && exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"', "sh",
    sessionCgroup(session.uid, session.scope), String(session.uid), String(session.gid), ...argv,
  ];
}

function call(session, method, signature, args) {
  const argv = inSession(session, ["busctl", "--system", "--json=short", "call", ...BUS, method, signature, ...args]);
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1));
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function main(argv) {
  let parsed;
  try { parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      choices: { type: "string" },
      out: { type: "string" },
      plan: { type: "string" },
      secrets: { type: "string" },
      timeout: { type: "string", default: "1800" },
      "as-user": { type: "string", default: "jarvis" },
    },
  });
  } catch { return 64; }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (positionals.length !== 1 || !(command === "probe" || (command === "plan" && values.choices && values.out) || (command === "execute" && values.plan && values.secrets && Number(values.timeout) > 0))) return 64;
  const log = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const fail = (event, code) => {
    log(event);
    return code;
  };
  const session = activeSession(values["as-user"]);
  if (command === "probe") {
    const r = await call(session, "Probe", "", []);
    if (r.code !== 0) return fail({ error: r.err.trim() }, 1);
    process.stdout.write(`${parseCallOutput(r.out)}\n`);
    return 0;
  }
  if (command === "plan" && values.choices && values.out) {
    const r = await call(session, "Plan", "s", [readFileSync(values.choices, "utf8")]);
    if (r.code !== 0) {
      const refusal = parseRefusal(r.err);
      if (refusal) return fail({ refused: refusal.reason, message: refusal.message }, 3);
      return fail({ error: r.err.trim() }, 1);
    }
    const plan = parseCallOutput(r.out);
    writeFileSync(values.out, plan);
    log({ plan: JSON.parse(plan) });
    return 0;
  }
  if (command === "execute" && values.plan && values.secrets) {
    const planId = JSON.parse(readFileSync(values.plan, "utf8")).planId;
    const monitor = spawn("busctl", [
      "--system", "--json=short", "monitor",
      "--match=type='signal',interface='os.jarvis.Installer1'",
    ]);
    const finished = new Promise((resolve) => {
      let buffer = "";
      monitor.stdout.on("data", (chunk) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const signal = parseSignal(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (!signal) continue;
          log(signal);
          if (signal.member === "Finished") resolve(signal.data);
        }
      });
    });
    await new Promise((r) => setTimeout(r, 500)); // monitor subscribed before Execute
    const r = await call(session, "Execute", "ss", [planId, readFileSync(values.secrets, "utf8")]);
    if (r.code !== 0) {
      monitor.kill();
      return fail({ error: r.err.trim() }, 1);
    }
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Number(values.timeout) * 1000); });
    const result = await Promise.race([finished, timeout]);
    clearTimeout(timer);
    monitor.kill();
    if (result === null) return fail({ result: "timeout" }, 2);
    const [ok, errorStep, message] = result;
    log({ result: ok ? "ok" : "failed", errorStep, message });
    return ok ? 0 : 1;
  }
  process.stderr.write("usage: installctl probe | plan --choices F --out F | execute --plan F --secrets F [--timeout S]\n");
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    },
  );
}
