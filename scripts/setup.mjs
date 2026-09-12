// `pnpm prereqs` — what Jarvis needs, what this machine has, and how to get the
// rest.
//
// The same catalogue and the same runner the first-run screen uses, so the two
// can never disagree about what the app needs. This adds argument parsing and
// output and nothing else.
//
// The name avoids `pnpm setup`, which is a pnpm builtin that configures
// pnpm's own home directory and would shadow this entirely.
//
// It reports by default and installs only when asked. A setup script that
// installed on sight would be the silent-install the design rejected, just
// with a terminal in front of it.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

// The specific modules rather than the package index: the index pulls the
// session store, which pulls node:sqlite, which prints an experimental
// warning that has nothing to do with installing anything.
const { checkPrerequisites } = await import("../packages/platform/dist/prerequisite-check.js");
const { installFor } = await import("../packages/platform/dist/prerequisites.js");
const { runInstall } = await import("../packages/platform/dist/prerequisite-install.js");
const { loginShellPath } = await import("../packages/platform/dist/headlamp.js");

const run = promisify(execFile);

const args = process.argv.slice(2);
const wantsAll = args.includes("--all");
const only = args.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");
const help = args.includes("--help") || args.includes("-h");

if (help) {
  console.log(`Usage: pnpm prereqs [--all] [--only=id,id]

  (no flags)     report what is installed and what is missing
  --all          install everything Jarvis can install without root
  --only=a,b     install just these

Anything needing root is never run — its command is printed for you to copy.`);
  process.exit(0);
}

// The login shell's PATH, exactly as the app resolves it — so "installed"
// means here what it means to Jarvis. A check against this process's PATH
// would report a tool under nvm as present and leave the app unable to find
// it, which is the bug this whole feature exists to prevent.
const path = await loginShellPath(process.env, process.platform);
const env = path === undefined ? process.env : { ...process.env, PATH: path };

const check = () =>
  checkPrerequisites({
    platform: process.platform,
    arch: process.arch,
    env,
    home: homedir(),
    fileExists: (p) => existsSync(p),
  });

const TICK = "✓";
const CROSS = "·";

function report(statuses) {
  for (const status of statuses) {
    const mark = status.installed ? TICK : CROSS;
    const note = status.installed
      ? "installed"
      : status.installable
        ? "can be installed"
        : (status.manual ?? "not available on this platform");
    console.log(`  ${mark} ${status.id.padEnd(13)} ${note}`);
  }
}

const installDeps = {
  home: homedir(),
  onOutput: (chunk) => process.stdout.write(chunk),
  run: (command, commandArgs, onOutput) =>
    new Promise((resolve) => {
      const child = spawn(command, [...commandArgs], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk) => onOutput(chunk));
      }
      child.on("error", (error) => {
        onOutput(`${error.message}\n`);
        resolve(1);
      });
      child.on("close", (code) => resolve(code ?? 1));
    }),
  download: async (url, dest) => {
    await mkdir(dirname(dest), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    await writeFile(dest, Buffer.from(await response.arrayBuffer()));
  },
  extract: async (url, dest) => {
    await mkdir(dest, { recursive: true });
    const archive = join(dest, basename(new URL(url).pathname));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await run("tar", ["-xf", archive, "-C", dest]);
    await rm(archive, { force: true });
    return dest;
  },
  link: async (from, to) => {
    await mkdir(dirname(to), { recursive: true });
    await rm(to, { force: true });
    await symlink(from, to);
  },
  locate: async (command) => {
    try {
      const { stdout } = await run("sh", ["-lc", `command -v ${command}`], { env });
      return stdout.trim() === "" ? undefined : stdout.trim();
    } catch {
      return undefined;
    }
  },
};

let statuses = check();
console.log("\nJarvis prerequisites\n");
report(statuses);

const wanted = statuses.filter(
  (s) => s.installable && (wantsAll || only?.includes(s.id) === true),
);

if (wanted.length === 0) {
  // Two different reasons Jarvis will not do it: a command that needs root,
  // and a tool with no package at all. Calling a documentation link "needs
  // root" would be wrong and would teach the reader to stop reading.
  const manual = statuses.filter((s) => !s.installed && s.manual !== undefined);
  const commands = manual.filter((s) => !s.manual.startsWith("http"));
  const pages = manual.filter((s) => s.manual.startsWith("http"));

  if (commands.length > 0) {
    console.log("\nThese need root, so run them yourself:\n");
    for (const status of commands) console.log(`  ${status.manual}`);
  }
  if (pages.length > 0) {
    console.log("\nThese have no package — see:\n");
    for (const status of pages) console.log(`  ${status.id.padEnd(13)} ${status.manual}`);
  }
  const installable = statuses.filter((s) => s.installable);
  if (installable.length > 0 && !wantsAll && only === undefined) {
    console.log(`\n${installable.length} can be installed: pnpm prereqs --all\n`);
  }
  process.exit(0);
}

for (const status of wanted) {
  console.log(`\n→ ${status.id}`);
  const step = installFor(status.id, process.platform, process.arch);
  const result = await runInstall(step, installDeps);
  console.log(result.ok ? `  ${TICK} done` : `  failed: ${result.detail}`);
}

console.log("\nAfter:\n");
statuses = check();
report(statuses);
console.log("");
