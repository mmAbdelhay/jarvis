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
// other way round. We ship macOS only.) afterPack is the last hook that
// runs before signing, so it is the correct seam. The app is then ad-hoc
// code-signed afterwards by `pnpm run package`, which is the order that
// leaves both signatures valid — verified with `codesign --verify` and
// `evs-vmp verify-pkg` together.
//
// Signing uploads the ~190 MB Electron binary to EVS and takes a few
// minutes; there is no local key that could avoid it.
//
// If it fails, the build fails. A silently unsigned build is worse than no
// build: it installs, it launches, it plays everything except the DRM the
// fork exists for, and it looks identical to a working one.
const { execFileSync } = require("node:child_process");

exports.default = async function vmpSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  // The EVS client takes the directory *containing* the .app, not the
  // bundle itself: it globs `<dir>/*.app` to find what to sign.
  const dir = context.appOutDir;
  console.log(`  • VMP signing (castLabs EVS) directory=${dir}`);

  try {
    execFileSync("evs-vmp", ["--no-ask", "sign-pkg", dir], { stdio: "inherit" });
    execFileSync("evs-vmp", ["--no-ask", "verify-pkg", dir], { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      "VMP signing failed, so this build could not play DRM. " +
        "Check that castlabs-evs is installed (`pipx install castlabs-evs`) and that " +
        "the account tokens are current (`evs-account reauth` — they expire monthly). " +
        String(error),
    );
  }
};
