// `pnpm package` — packages for whichever platform this is.
//
// Each platform is built on itself, and that is not a preference. The
// electronDist in electron-builder.yml points at node_modules/electron/dist,
// which holds the *host's* castLabs build — `--linux` from a Mac would wrap a
// darwin Electron in a Linux bundle without complaining. node-pty forces the
// same constraint independently: it ships no Linux prebuild, so its native
// binding is compiled by `pnpm bootstrap` on the machine that will ship it.
//
// So this dispatches rather than offering a choice, and says so when it is
// asked for something it cannot honestly produce.
import { spawn } from "node:child_process";

const TARGETS = { darwin: "package:mac", linux: "package:linux", win32: "package:win" };

const script = TARGETS[process.platform];
if (script === undefined) {
  console.error(
    `Nothing to package on ${process.platform}: Jarvis targets macOS (dmg), Linux (AppImage) ` +
      "and Windows (a folder), and each is built on its own platform.",
  );
  process.exit(1);
}

const child = spawn("pnpm", ["run", script], { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 0));
