// Widevine (VMP) signs the packaged app, as an electron-builder afterPack hook.
//
// Why this is not optional: Electron for Content Security ships binaries
// carrying castLabs' *development* VMP signature. Widevine test servers
// accept those; a commercial service does not. Netflix answers a
// development-signed client with error E100 — the CDM is right there and
// working, and the licence request is refused anyway. The production
// signature, issued per-account by castLabs' EVS service, is what makes the
// difference, and it has to be applied to every build.
//
// Why afterPack and not afterSign: on macOS the VMP signature has to go in
// BEFORE the code signature, because it is a file inside the bundle and
// adding it invalidates any signature already covering it. (Windows is the
// other way round; we do not ship it.) afterPack is the last hook that runs
// before signing, so it is the correct seam. The app is then ad-hoc
// code-signed afterwards by `pnpm run package:mac`, which is the order that
// leaves both signatures valid — verified with `codesign --verify` and
// `evs-vmp verify-pkg` together.
//
// On Linux the same hook is simply correct with nothing to order against:
// there is no code signature for a VMP signature to invalidate.
//
// Signing uploads the ~190 MB Electron binary to EVS and takes a few
// minutes; there is no local key that could avoid it.
//
// If it fails, the build fails. A silently unsigned build is worse than no
// build: it installs, it launches, it plays everything except the DRM the
// fork exists for, and it looks identical to a working one.
//
// castlabs-evs being *absent* is a different case, and it is the normal one
// for anybody who is not the maintainer. An EVS account is per-person, and a
// repository that cannot be built from a clone without one is not open
// source. So: no evs-vmp, no signature, a warning loud enough that nobody
// mistakes the result for a release build, and the build continues.
// JARVIS_REQUIRE_VMP=1 restores the hard failure, and the release command
// sets it.
const { execFileSync } = require("node:child_process");

/** Whether the EVS client is on PATH at all. */
function evsAvailable() {
  try {
    execFileSync("evs-vmp", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

exports.default = async function vmpSign(context) {
  const platform = context.electronPlatformName;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return;

  // The EVS client takes the directory *containing* the app, not the bundle
  // itself: it globs that directory to find what to sign.
  const dir = context.appOutDir;

  if (!evsAvailable()) {
    if (process.env.JARVIS_REQUIRE_VMP === "1") {
      throw new Error(
        "JARVIS_REQUIRE_VMP=1, but castlabs-evs is not installed. " +
          "Install it with `pipx install castlabs-evs` and authenticate with `evs-account reauth`.",
      );
    }
    console.warn(
      "  ! castlabs-evs not found: this build is NOT VMP-signed and will play no DRM.\n" +
        "    Everything else works. Install castlabs-evs to produce a release build.",
    );
    return;
  }

  console.log(`  • VMP signing (castLabs EVS) platform=${platform} directory=${dir}`);

  try {
    execFileSync("evs-vmp", ["--no-ask", "sign-pkg", dir], { stdio: "inherit" });
    execFileSync("evs-vmp", ["--no-ask", "verify-pkg", dir], { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      "VMP signing failed, so this build could not play DRM. " +
        "Check that the account tokens are current (`evs-account reauth` — they expire monthly). " +
        String(error),
    );
  }
};
