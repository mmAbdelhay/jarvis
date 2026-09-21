// M10 Task 5: node:fs/node:path/node:url are fine here — this file is only
// ever evaluated by the Expo CLI's config loader (Node.js), never bundled
// into the app itself (it lives outside `app/` and `src/`, so
// no-node-imports.test.ts's scan doesn't reach it either).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpoConfig } from "expo/config";

const HERE = dirname(fileURLToPath(import.meta.url));
// Rule: `android.googleServicesFile` only if the file actually exists —
// a checkout without Firebase credentials must still produce a valid
// config instead of failing prebuild on a missing path.
const GOOGLE_SERVICES_FILE = "./google-services.json";
const HAS_GOOGLE_SERVICES = existsSync(join(HERE, "google-services.json"));

const config: ExpoConfig = {
  name: "Jarvis",
  slug: "jarvis-mobile",
  scheme: "jarvis",
  version: "0.0.0",
  // "default" (not "portrait"): the app locks portrait itself at the JS
  // level (`expo-screen-orientation`, app/_layout.tsx on mount) everywhere
  // except the sidecar WebView screen, which unlocks on focus so a
  // landscape-friendlier desktop UI (code-server, DbGate, Headlamp) can
  // rotate. A native `orientation: "portrait"` lock here would override
  // that at the OS level regardless of what the JS side asks for — this is
  // a native config change, so a new EAS build is required for it to take
  // effect on-device.
  orientation: "default",
  // "dark", not "automatic": theme.ts's tokens are dark-only (no light
  // palette exists to switch to), and "automatic" also produces an
  // expo-system-ui warning during `expo prebuild` (deferred minor).
  userInterfaceStyle: "dark",
  // The app icon is the desktop's own J (packages/desktop/assets/icon.svg),
  // rasterised into assets/ so the phone and the dock tile agree.
  icon: "./assets/icon.png",
  // No `newArchEnabled` field: SDK 57's ExpoConfig type dropped it — the New
  // Architecture is the only architecture from SDK 52 on, nothing to opt into.
  ios: {
    bundleIdentifier: "dev.jarvis.mobile",
    // Without this the app installs on iPad as a scaled-up iPhone app.
    // The JS-level portrait lock (app/_layout.tsx) still applies; the
    // sidecar WebView screen still unlocks on focus.
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription:
        "Jarvis uses the camera to scan the pairing QR code shown by the desktop app. / يستخدم Jarvis الكاميرا لمسح رمز الاقتران المعروض في تطبيق سطح المكتب.",
      // iOS 14+: shown once, the first time the app dials the laptop over
      // the LAN. Without this key the OS still prompts, but with no
      // app-specific explanation — and App Review rejects that (final
      // review N4).
      NSLocalNetworkUsageDescription:
        "Jarvis connects to the paired computer over your local network. / يتصل Jarvis بالكمبيوتر المقترن عبر شبكتك المحلية.",
    },
  },
  android: {
    package: "dev.jarvis.mobile",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0B0D12",
    },
    permissions: ["CAMERA", "RECORD_AUDIO"],
    ...(HAS_GOOGLE_SERVICES ? { googleServicesFile: GOOGLE_SERVICES_FILE } : {}),
  },
  // `modules/pinned-socket` (Task 3) needs no entry here: Expo autolinks
  // everything under `modules/*`.
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-camera",
    [
      "expo-audio",
      {
        // Unlike NSCameraUsageDescription above, this string is not set
        // directly in `infoPlist`: the expo-audio config plugin writes it
        // into `NSMicrophoneUsageDescription` itself from this option.
        microphonePermission:
          "Jarvis uses the microphone to record what you say to it. / يستخدم Jarvis الميكروفون لتسجيل ما تقوله له.",
        // Explicit, not left at the plugin's default `true`: the default
        // pushes `UIBackgroundModes: ["audio"]` into Info.plist and adds
        // `FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_MEDIA_PLAYBACK` plus a
        // foreground media-playback service to the Android manifest at
        // prebuild — this app never plays audio in the background
        // (recording stops when backgrounded, ruling 12), so both are
        // off (fix round 1, Important #1).
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ],
    [
      "expo-notifications",
      {
        // The app's own existing accent — theme.ts's `theme.colors.primary`.
        // Kept as a literal, not an import: Expo's config loader
        // (`@expo/config`'s `getConfig`) resolves this file outside Metro
        // and cannot follow an extensionless TS import like
        // `./src/lib/theme` (fix round 1, Important #1 — an `import {
        // theme }` here made every prebuild/start/EAS build fail at config
        // load). `app-config.test.ts` imports `theme.ts` directly and
        // asserts this literal never drifts from it. `icon` is the 96 px
        // white-on-transparent J Android tints for the status bar.
        color: "#5CA3FF",
        icon: "./assets/notification-icon.png",
      },
    ],
  ],
  extra: {
    router: {
      origin: false,
    },
    eas: {
      projectId: "508ab972-df39-4a66-958a-b998cd614d78",
    },
  },
  owner: "mmabdelhay",
};

export default config;
