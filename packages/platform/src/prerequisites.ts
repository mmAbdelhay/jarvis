// Everything Jarvis needs that Jarvis does not ship, as data.
//
// The same knowledge — what the app needs, how to tell whether it is there,
// how to get it — is wanted in three places: the first-run screen, the
// `pnpm setup` command, and the guides. Three copies of a list drift, and the
// failure when they drift is a user installing the wrong thing. So it lives
// here once, and the front ends are thin.
//
// Every command below was checked against its upstream index while this was
// written — the Homebrew formula and cask API, the winget-pkgs manifest tree,
// and the piper release's own asset list — rather than recalled. `piper` has
// no Homebrew formula, which is why macOS gets a tarball like everyone else.
// Nothing in the suite can keep them true; see docs/develop/testing.md.

import { defaultHeadlampBinary } from "./headlamp.js";

/** A tool, a model, or a system package. */
export type PrerequisiteId =
  | "agent"
  | "ffmpeg"
  | "player"
  | "whisper"
  | "piper"
  | "voice-en"
  | "voice-ar"
  | "code-server"
  | "dbgate"
  | "headlamp"
  | "docker"
  | "kubectl";

/** How to tell whether it is already there.
 *
 *  `binary` and `anyBinary` are resolved against the *login shell's* PATH,
 *  not this process's — see prerequisite-check.ts for why that distinction is
 *  the whole point. `file` exists for the voice models, which are paths in
 *  config rather than binaries anywhere. */
export type Detection =
  | { kind: "binary"; command: string }
  | { kind: "anyBinary"; commands: readonly string[] }
  | { kind: "file"; path: string }
  /** Satisfied by any one of several detections of different kinds. Headlamp
   *  is the case: it is a PATH binary on Linux and a path inside an
   *  application bundle on macOS and Windows, and a tool that is installed
   *  still has to read as installed. */
  | { kind: "anyOf"; of: readonly Detection[] };

/** A detection that depends on the machine — the same shape as InstallFor,
 *  and for the same reason: the answer differs per platform, and every input
 *  stays a parameter so one `pnpm test` proves all three. */
type DetectFor = Detection | ((platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => Detection);

/**
 * How to get it.
 *
 * `run`, `download` and `extract` are things Jarvis does. `manual` is a line
 * of text with a copy button beside it, and it has no field that could be
 * executed — which is the structural half of "Jarvis never asks for your
 * password". No later edit can quietly promote one, because there is nothing
 * there to promote.
 */
export type InstallStep =
  | {
      kind: "run";
      command: string;
      args: readonly string[];
      /** Where to symlink the resulting binary, when the command is npm.
       *  npm under nvm installs into a bin that a non-interactive login shell
       *  cannot see, which is precisely how the Database tab came to fail
       *  with dbgate-serve installed. */
      linkInto?: string;
      /** The binary the link should point at, if it is not the command. */
      linkBinary?: string;
    }
  | { kind: "download"; files: readonly { url: string; dest: string }[] }
  | { kind: "extract"; url: string; dest: string; binary: string; linkInto: string }
  | { kind: "manual"; display: string };

/** An install that depends on the machine's architecture. */
type InstallFor = InstallStep | ((arch: string) => InstallStep);

export type Prerequisite = {
  id: PrerequisiteId;
  /** Required means Jarvis has no purpose without it — there are no sessions
   *  and sessions are the app. Everything else reduces it. Exactly one is
   *  required, because a screen calling five things "required" teaches the
   *  reader to ignore the word. */
  required: boolean;
  detect: DetectFor;
  /** An absent platform means "not available here", which the screen shows as
   *  its own state rather than as a missing tool. */
  install: Partial<Record<NodeJS.Platform, InstallFor>>;
};

const PIPER_RELEASE = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2";
const VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

/** Where Jarvis's config already expects these to be — see config.ts's
 *  DEFAULT_PIPER_BINARY and DEFAULT_PIPER_MODEL. Installing them anywhere
 *  else would mean the user still had to edit jarvis.yaml, which is most of
 *  the work this is removing. */
const PIPER_BIN = "~/.local/bin";
const VOICE_DIR = "~/.config/jarvis/voices";

/** piper's release assets, by platform and architecture. Named exactly as the
 *  release lists them. */
function piperArchive(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === "linux") {
    if (arch === "x64") return "piper_linux_x86_64.tar.gz";
    if (arch === "arm64") return "piper_linux_aarch64.tar.gz";
    return undefined;
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "piper_macos_aarch64.tar.gz" : "piper_macos_x64.tar.gz";
  }
  if (platform === "win32" && arch === "x64") return "piper_windows_amd64.zip";
  return undefined;
}

function voiceFiles(dir: string, name: string): { url: string; dest: string }[] {
  // Two files, always. piper reads the .json beside the model for its sample
  // rate and phoneme map and refuses to start without it, so downloading the
  // .onnx alone produces a voice that looks installed and cannot speak.
  return [
    { url: `${VOICES}/${dir}/${name}.onnx`, dest: `${VOICE_DIR}/${name}.onnx` },
    { url: `${VOICES}/${dir}/${name}.onnx.json`, dest: `${VOICE_DIR}/${name}.onnx.json` },
  ];
}

/** The English model is stored under the name config already looks for, which
 *  differs from the name upstream publishes it as. */
const EN_LOCAL = "en-gb-alan-low";

const npm = (pkg: string, binary: string): InstallStep => ({
  kind: "run",
  command: "npm",
  args: ["i", "-g", pkg],
  linkInto: PIPER_BIN,
  linkBinary: binary,
});

export const PREREQUISITES: readonly Prerequisite[] = [
  {
    // Without an agent there are no sessions, and sessions are what the app
    // is for. The only required entry.
    id: "agent",
    required: true,
    detect: { kind: "binary", command: "claude" },
    install: {
      darwin: npm("@anthropic-ai/claude-code", "claude"),
      linux: npm("@anthropic-ai/claude-code", "claude"),
      win32: npm("@anthropic-ai/claude-code", "claude"),
    },
  },
  {
    id: "ffmpeg",
    required: false,
    detect: { kind: "binary", command: "ffmpeg" },
    install: {
      darwin: { kind: "run", command: "brew", args: ["install", "ffmpeg"] },
      // Root. The line to copy is built per package manager in manualLine().
      linux: { kind: "manual", display: "ffmpeg" },
      win32: { kind: "run", command: "winget", args: ["install", "--id", "Gyan.FFmpeg", "-e"] },
    },
  },
  {
    // Any one of the three will do; which exist depends on the sound server.
    id: "player",
    required: false,
    detect: { kind: "anyBinary", commands: ["pw-play", "paplay", "aplay", "afplay"] },
    install: {
      // macOS ships afplay, so there is nothing to install and nothing
      // missing. Windows has no playback path in the app yet.
      linux: { kind: "manual", display: "player" },
    },
  },
  {
    id: "whisper",
    required: false,
    detect: { kind: "binary", command: "whisper-cli" },
    install: {
      darwin: { kind: "run", command: "brew", args: ["install", "whisper-cpp"] },
      linux: { kind: "manual", display: "whisper" },
      win32: { kind: "manual", display: "whisper" },
    },
  },
  {
    id: "piper",
    required: false,
    // Also the path config defaults to, because ~/.local/bin is where the
    // tarball route links it and a login shell need not carry that directory
    // — a piper that works would otherwise be reported missing for ever.
    detect: {
      kind: "anyOf",
      of: [
        { kind: "binary", command: "piper" },
        { kind: "file", path: `${PIPER_BIN}/piper` },
      ],
    },
    install: {
      // Not the tarball on macOS. The macOS assets of piper's last release
      // (2023.11.14-2, and there will be no other) contain no
      // libespeak-ng dylib at all, so the binary cannot start wherever it is
      // put — the Linux and Windows archives do ship theirs. Offering the
      // download anyway would tick a row for a tool that cannot speak.
      // macOS has `say` in the meantime, which is what config falls back to.
      darwin: { kind: "manual", display: "piper" },
      linux: (arch) => piperStep("linux", arch),
      win32: (arch) => piperStep("win32", arch),
    },
  },
  {
    id: "voice-en",
    required: false,
    detect: { kind: "file", path: `${VOICE_DIR}/${EN_LOCAL}.onnx` },
    install: sameEverywhere({
      kind: "download",
      files: [
        {
          url: `${VOICES}/en/en_GB/alan/low/en_GB-alan-low.onnx`,
          dest: `${VOICE_DIR}/${EN_LOCAL}.onnx`,
        },
        {
          url: `${VOICES}/en/en_GB/alan/low/en_GB-alan-low.onnx.json`,
          dest: `${VOICE_DIR}/${EN_LOCAL}.onnx.json`,
        },
      ],
    }),
  },
  {
    id: "voice-ar",
    required: false,
    detect: { kind: "file", path: `${VOICE_DIR}/ar_JO-kareem-low.onnx` },
    install: sameEverywhere({
      kind: "download",
      files: voiceFiles("ar/ar_JO/kareem/low", "ar_JO-kareem-low"),
    }),
  },
  {
    id: "code-server",
    required: false,
    detect: { kind: "binary", command: "code-server" },
    install: {
      darwin: { kind: "run", command: "brew", args: ["install", "code-server"] },
      // Not `npm i -g`: it pulls kerberos, a native module, and the build
      // fails on Node 22+. The install script ships a standalone build with
      // its own Node, and --prefix keeps it in $HOME where no root is needed.
      linux: {
        kind: "run",
        command: "sh",
        args: [
          "-c",
          'curl -fsSL https://code-server.dev/install.sh | sh -s -- --method standalone --prefix "$HOME/.local"',
        ],
      },
      win32: { kind: "manual", display: "code-server" },
    },
  },
  {
    id: "dbgate",
    required: false,
    detect: { kind: "binary", command: "dbgate-serve" },
    install: {
      darwin: npm("dbgate-serve", "dbgate-serve"),
      linux: npm("dbgate-serve", "dbgate-serve"),
      win32: npm("dbgate-serve", "dbgate-serve"),
    },
  },
  {
    id: "headlamp",
    required: false,
    // headlamp-server is not distributed on its own: every release is a
    // desktop app, and `brew install --cask headlamp` puts one in
    // /Applications with the server inside the bundle and nothing on PATH.
    // Detecting only the PATH binary reported it missing on the machine that
    // had just installed it — and the app itself resolves it by that bundle
    // path, so the screen was disagreeing with the tab.
    detect: (platform, env) => ({
      kind: "anyOf",
      of: [
        { kind: "binary", command: "headlamp-server" },
        { kind: "file", path: defaultHeadlampBinary(platform, env) },
      ],
    }),
    install: {
      darwin: { kind: "run", command: "brew", args: ["install", "--cask", "headlamp"] },
      linux: { kind: "manual", display: "headlamp" },
      win32: {
        kind: "run",
        command: "winget",
        args: ["install", "--id", "Headlamp.Headlamp", "-e"],
      },
    },
  },
  {
    id: "docker",
    required: false,
    detect: { kind: "binary", command: "docker" },
    install: {
      darwin: { kind: "manual", display: "docker" },
      linux: { kind: "manual", display: "docker" },
      win32: {
        kind: "run",
        command: "winget",
        args: ["install", "--id", "Docker.DockerDesktop", "-e"],
      },
    },
  },
  {
    // Detected and never installed. Headlamp bundles what the Cluster tab
    // needs and nothing in Jarvis shells out to kubectl; it is here so the
    // screen can report it, not so the screen can install it.
    id: "kubectl",
    required: false,
    detect: { kind: "binary", command: "kubectl" },
    install: {},
  },
];

function piperStep(platform: NodeJS.Platform, arch: string): InstallStep {
  const archive = piperArchive(platform, arch);
  if (archive === undefined) {
    return { kind: "manual", display: "piper" };
  }
  return {
    kind: "extract",
    url: `${PIPER_RELEASE}/${archive}`,
    dest: "~/.local/lib/piper",
    binary: platform === "win32" ? "piper.exe" : "piper",
    linkInto: PIPER_BIN,
  };
}

function sameEverywhere(step: InstallStep): Partial<Record<NodeJS.Platform, InstallFor>> {
  return { darwin: step, linux: step, win32: step };
}

/** How to tell whether `prerequisite` is present on this machine. */
export function detectionFor(
  prerequisite: Prerequisite,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Detection {
  return typeof prerequisite.detect === "function"
    ? prerequisite.detect(platform, env)
    : prerequisite.detect;
}

/**
 * What a `run` step needs before it can run at all, and where to get it.
 *
 * A fresh Mac has no Homebrew, and a packaged Jarvis may be the first Node
 * application on the machine. Offering "install" for a step whose very
 * command is missing produces `brew: command not found` inside the install
 * log and a row that never turns green — so the check asks first, and says
 * the thing that would actually fix it instead.
 *
 * Only the managers are listed. `sh` is on every machine this runs on, and a
 * command absent from this map is attempted as before rather than blocked by
 * a guess.
 */
const RUNNERS: Record<string, { name: string; page: string }> = {
  brew: { name: "Homebrew", page: "https://brew.sh" },
  npm: { name: "Node.js", page: "https://nodejs.org/en/download" },
  winget: { name: "App Installer", page: "https://aka.ms/getwinget" },
};

/** The line to show for `step` when the tool that would run it is missing,
 *  or undefined when nothing is in the way. */
export function missingRunnerLine(
  step: InstallStep,
  present: (command: string) => boolean,
): string | undefined {
  if (step.kind !== "run") return undefined;
  const runner = RUNNERS[step.command];
  if (runner === undefined || present(step.command)) return undefined;
  const command = [step.command, ...step.args].join(" ");
  return `${command} — needs ${runner.name} first: ${runner.page}`;
}

/** The install for `id` on this machine, or undefined where there is none —
 *  macOS needs no audio player, and kubectl is never installed. */
export function installFor(
  id: PrerequisiteId,
  platform: NodeJS.Platform,
  arch: string,
): InstallStep | undefined {
  const entry = PREREQUISITES.find((candidate) => candidate.id === id);
  const step = entry?.install[platform];
  if (step === undefined) return undefined;
  return typeof step === "function" ? step(arch) : step;
}

/** The package manager a `manual` line should be written for. */
export type PackageManager = "apt" | "dnf" | "pacman" | "brew" | "winget";

/**
 * Which package manager this machine has.
 *
 * Linux is the only platform where this is a question, and the order is the
 * order of prevalence rather than preference — a box with both apt and dnf is
 * a box where apt is the one that owns the packages below.
 *
 * `apt-get` rather than `apt` is probed because `apt` is a newer front end
 * that some minimal images leave out while still having the package manager.
 */
export function packageManager(
  platform: NodeJS.Platform,
  exists: (command: string) => boolean,
): PackageManager | undefined {
  if (platform === "darwin") return exists("brew") ? "brew" : undefined;
  if (platform === "win32") return exists("winget") ? "winget" : undefined;
  if (exists("apt-get")) return "apt";
  if (exists("dnf")) return "dnf";
  if (exists("pacman")) return "pacman";
  return undefined;
}

/** What each manual tool is called to each package manager. An audio player
 *  is three alternatives because any one of them satisfies the detection. */
const PACKAGES: Record<string, Partial<Record<PackageManager, string>>> = {
  ffmpeg: { apt: "ffmpeg", dnf: "ffmpeg", pacman: "ffmpeg", brew: "ffmpeg" },
  player: {
    apt: "pipewire-audio-client-libraries | pulseaudio-utils | alsa-utils",
    dnf: "pipewire-utils | pulseaudio-utils | alsa-utils",
    pacman: "pipewire | libpulse | alsa-utils",
  },
  docker: { apt: "docker.io", dnf: "docker", pacman: "docker" },
};

/** Where the whole line is not "<verb> <package>" — a tool whose only working
 *  route on that platform is some other tool's command. piper on macOS is the
 *  one: the release has no usable macOS build, and the Python package does. */
const COMMANDS: Record<string, Partial<Record<PackageManager, string>>> = {
  piper: { brew: "uv tool install piper-tts" },
};

const INSTALL_VERB: Record<PackageManager, string> = {
  apt: "sudo apt install",
  dnf: "sudo dnf install",
  pacman: "sudo pacman -S",
  brew: "brew install",
  winget: "winget install --id",
};

/** Where a tool has no package and only a page. */
const PAGES: Record<string, string> = {
  whisper: "https://github.com/ggerganov/whisper.cpp",
  headlamp: "https://headlamp.dev/docs/latest/installation/desktop/linux/",
  docker: "https://docs.docker.com/engine/install/",
  piper: "https://github.com/rhasspy/piper/releases",
  "code-server": "https://coder.com/docs/code-server/install",
};

/**
 * The line to show beside a tool Jarvis will not install itself.
 *
 * It names the package the *detected* manager actually uses, because a
 * generic "install ffmpeg" is not the thing a reader can paste. With no
 * manager detected — or no package for it — the fallback is the project's own
 * page, which is more use than a command for a tool the machine cannot get
 * that way.
 */
export function manualLine(display: string, manager: PackageManager | undefined): string {
  const whole = manager === undefined ? undefined : COMMANDS[display]?.[manager];
  if (whole !== undefined) return whole;
  const pkg = manager === undefined ? undefined : PACKAGES[display]?.[manager];
  if (pkg === undefined || manager === undefined) return PAGES[display] ?? display;
  return `${INSTALL_VERB[manager]} ${pkg}`;
}
