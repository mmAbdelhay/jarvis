// The post-install steps a package manager with `ignore-scripts` suppresses,
// run explicitly.
//
// pnpm-workspace.yaml explains the pre-gate: `~/.npmrc` sets
// ignore-scripts=true as blanket supply-chain protection, and a
// project-level .npmrc must NOT be added to override it. Even without that
// global setting pnpm's own `onlyBuiltDependencies` allow-list stops
// node-pty, so on every machine two things this app cannot run without are
// left undone:
//
//   1. The Electron binary. `electron`'s own install.js downloads it, and
//      without it there is nothing to run.
//   2. node-pty's native binding. node-pty 1.1.0 ships prebuilds for
//      darwin-arm64, darwin-x64, win32-arm64 and win32-x64 — and nothing
//      for Linux. There it must be compiled, or every pty in the app (every
//      agent session, every Terminal tab) fails at require time.
//
// This is the sanctioned escape hatch: the suppressed steps, in one place,
// run by a command a human typed and can read.
//
// Idempotent. Both steps check before they act, so running it twice is free
// and running it after every `pnpm install` is the habit.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function step(message) {
  console.log(`  • ${message}`);
}

/**
 * The directory of an installed package, resolved from the workspace package
 * that declares it.
 *
 * Resolved rather than joined onto a path: pnpm does not put dependencies in
 * the root node_modules. They are symlinks under the declaring package,
 * pointing into the content-addressed store, and only the resolver knows
 * where a given one landed.
 */
function packageDir(name, fromWorkspacePackage) {
  const require = createRequire(join(root, fromWorkspacePackage, "package.json"));
  return dirname(require.resolve(`${name}/package.json`));
}

// ---------------------------------------------------------------------------
// 1. Electron
// ---------------------------------------------------------------------------
//
// install.js writes `path.txt` beside the downloaded dist, and electron's own
// entry point reads it to find the binary. Its presence is the honest test
// for "already downloaded".
//
// The version here is castLabs' Electron for Content Security, not stock
// Electron — see electron-builder.yml. install.js fetches whichever the
// package.json in node_modules names, so this needs no special handling; it
// is only worth knowing that a `pnpm install` which replaced that package
// would silently change which Electron gets packaged.
const electronDir = packageDir("electron", "packages/desktop");
if (existsSync(join(electronDir, "path.txt"))) {
  step("Electron binary already present");
} else {
  step("Downloading the Electron binary (castLabs build, ~200 MB)");
  execFileSync(process.execPath, [join(electronDir, "install.js")], {
    cwd: electronDir,
    stdio: "inherit",
  });
}

// ---------------------------------------------------------------------------
// 2. node-pty
// ---------------------------------------------------------------------------
//
// node-pty's own loader (lib/utils.js) searches `build/Release`,
// `build/Debug`, then `prebuilds/<platform>-<arch>`. A source build lands in
// the first; a shipped prebuild in the last. Either satisfies it, so this
// only builds when neither is there.
//
// The binding is node-api, so a binary compiled against Node is ABI-valid
// under Electron with no electron-rebuild. That is the same fact
// electron-builder.yml relies on to keep npmRebuild false.
const ptyDir = packageDir("node-pty", "packages/platform");
const prebuild = join(ptyDir, "prebuilds", `${process.platform}-${process.arch}`, "pty.node");
const sourceBuild = join(ptyDir, "build", "Release", "pty.node");

if (existsSync(prebuild) || existsSync(sourceBuild)) {
  step("node-pty binding already present");
} else {
  step(`No node-pty prebuild for ${process.platform}-${process.arch}; building from source`);
  try {
    execFileSync("npx", ["--yes", "node-gyp", "rebuild"], { cwd: ptyDir, stdio: "inherit" });
  } catch (error) {
    // node-gyp's failure output is long and its first line is rarely the
    // cause. Naming the packages that are missing on a fresh Linux box turns
    // a ten-minute search into one apt-get.
    throw new Error(
      "Building node-pty failed. It needs a C++ toolchain and Python:\n" +
        "  Debian/Ubuntu:  sudo apt install -y build-essential python3\n" +
        "  Fedora/RHEL:    sudo dnf install -y gcc-c++ make python3\n" +
        "  Arch:           sudo pacman -S --needed base-devel python\n" +
        String(error),
    );
  }
}

step("Bootstrap complete.");
