# jarvis-mobile

The Jarvis phone app: Expo Router + React Native. It pairs with the Jarvis
desktop app over a pinned-TLS local connection and, once paired, shows the
laptop's projects, live system metrics and sessions, with a live terminal and native input controls.

## Prerequisites

- **Xcode** (for iOS) and/or **Android Studio** (for Android), each with a
  simulator/emulator already set up, if you want to run without a physical
  device.
- Node and pnpm as the rest of the workspace uses them — see the repository
  root's `SETUP.md`.
- A physical phone needs a cable (or the same LAN as the Mac running Metro)
  to install a development build the first time.

## Why a development build, not Expo Go

This app pins the laptop's TLS certificate from native code
(`modules/pinned-socket`, Task 3): Swift on iOS (`URLSessionWebSocketTask` +
its trust-challenge delegate), Kotlin on Android (OkHttp with a single-leaf
`X509TrustManager`/`HostnameVerifier`). React Native's built-in `WebSocket`
exposes no certificate hook on either platform, so a self-signed laptop
certificate cannot be trusted from JS alone — and Expo Go ships a fixed set
of native modules that does not include this one. Every run here is a
**development build**: `expo prebuild` generates the native `ios/`/`android/`
projects (gitignored; only `modules/pinned-socket/**`, `app.json`/
`app.config.ts` and the JS sources are committed), and `expo run:ios`/
`expo run:android` compile and install it.

## Commands

From the repo root:

```sh
pnpm install
npx tsc -b                               # builds packages/wire's dist/ — Metro resolves
                                          # @jarvis/wire through its package.json "main",
                                          # which points at dist/ (gitignored); a fresh
                                          # clone won't bundle until this has run once
pnpm --filter jarvis-mobile prebuild     # generates ios/ and android/ (once, or after a native change)
```

From `apps/mobile`:

```sh
npx tsc --noEmit -p .                    # typecheck
npx vitest run                           # unit tests
npx expo run:ios --device                # build and install on a connected iPhone
npx expo run:ios                         # build and run on the iOS Simulator
npx expo run:android                     # build and run on a device or emulator
```

`expo start` (Metro only, no native build) only works once a development
build from one of the `run:` commands above is already installed — it does
not build the native module itself.

**A note on this package's own `typescript`/`vitest` pins.** This
workspace's repo-wide gates (`npx tsc -b`, `npx tsc --noEmit -p
apps/mobile`, `npx vitest run --config apps/mobile/vitest.config.mts`) run
from the repo root and resolve pnpm's single hoisted `typescript`/`vitest`
install — the root's versions, not the ones declared in this package's own
`devDependencies`. Those declared pins exist for Expo's own tooling
(`expo start`/`prebuild`/doctor checks), which expects to find
`typescript`/`vitest` inside `apps/mobile/node_modules` and is pickier
about which major versions it accepts than the gates are. Keep the two in
sync with `pnpm-lock.yaml` (a plain `pnpm install` after bumping either one
here) rather than pinning ahead of what has actually been installed.

## Test on your phone

> EAS builds from a clean checkout, so `apps/mobile/package.json` carries an
> `eas-build-post-install` hook that runs `tsc -b packages/wire` — `@jarvis/wire`'s
> `main` points at its gitignored `dist/`, which a standalone (`preview`)
> bundle needs at build time. A `development` build never noticed (Metro serves
> the sources at runtime).


Expo Go cannot load this app's native pinned-socket module. An EAS development
build installs a custom app that connects to Metro for quick JS iteration.
An Expo Free account supports EAS builds. Install and sign in to the EAS CLI:

```sh
npm i -g eas-cli
eas login
```

For an iPhone, register its UDID first with `eas device:create`. Then run
`cd apps/mobile && eas build --profile development --platform ios`. For
Android, run `cd apps/mobile && eas build --profile development --platform
android`; this profile produces an APK to sideload. Allow roughly 20 minutes
for a cloud build. iOS internal distribution needs both the registered UDID
and a paid Apple Developer Program account for ad hoc signing; TestFlight also
requires that paid Apple account. The free Expo account alone suffices for an
Android APK build. **Running on an iPhone or iPad without paying** is a
different path entirely — an unsigned IPA sideloaded with AltStore/SideStore,
or a personal-team Xcode build over USB — documented in
[iPhone and iPad](../../docs/guide/ios-install.md).

Install the resulting build on the phone. From `apps/mobile`, run
`npx expo start --dev-client` and scan its QR with the installed app. Keep the
phone and Mac on the same Wi-Fi network so JS edits reload through Metro.
Changes to `modules/pinned-socket` or the native plugins in `app.config.ts`
need a new build.

For checklist steps that kill, relaunch, or background the app, or test push,
make an EAS `preview` build instead (`eas build --profile preview --platform
ios` or `android`). It runs without Metro. Push needs the EAS `projectId`
configured in `app.config.ts` and platform push credentials.

On the laptop, run this branch from the repo root with
`PATH=/opt/homebrew/bin:$PATH pnpm start` (or use the installed app after
this branch is merged). In Settings → Remote access, choose the Mac's LAN IP,
turn remote access on, and select Pair. Scan the QR on the phone and approve
the pairing request on the laptop. Then work through items 1–114 below;
items 76–86 cover M12.

## Pairing on a LAN

Desktop: **Settings → Remote access → On**, bind an address, **Save**, then
**New code** — a QR appears beside the link text, with the certificate's
fingerprint tail (last 4 hex characters) printed beside it.

Phone: scanning the QR, pasting the link text, or opening a `jarvis://pair…`
deep link all land on the same **confirm** step first — host:port and the
same fingerprint tail the laptop showed, so you can check the two match
before anything connects. Approving from there opens the pinned socket and
sends the pairing exchange; the laptop's own confirmation dialog (naming the
device) is what the user approves on that side. A phone that already has a
pairing refuses any new link outright — unpair in Settings first.

**The loopback caveat.** `127.0.0.1` only ever means "this device" — the
laptop's `remote.bindAddress` is the address the pairing link's `host`
literally carries, and the phone dials that host verbatim (there is no
rewriting). **Only the iOS Simulator can use it**: it shares the Mac's own
network stack, so `127.0.0.1` inside the Simulator *is* the Mac's
`127.0.0.1`. **The Android emulator is a different story** — inside the
emulator's guest OS, `127.0.0.1` means the emulator itself, not the host.
Android's own networking maps the emulator's `10.0.2.2` to the host
machine's loopback interface, but this app has no way to substitute that
for a link that already encodes `127.0.0.1` (the confirm step shows the
address the link carried, unedited); there is no manual host-entry step
unless the laptop bound to `0.0.0.0`/`::` in the first place (ruling 12). So
in practice, **both the Android emulator and a physical phone need the
laptop bound to its LAN address** (or a Tailscale address) — `127.0.0.1`
only ever works for the iOS Simulator.

## Manual-pass checklist

Run after the automated tests and the final review, on a real device where
noted — this exercises the native pinning, backgrounding and RTL behaviour
that no unit test can see (see `docs/develop/testing.md`).

1. Desktop: Settings → Remote access → On, bind `127.0.0.1` (iOS Simulator
   only) or the LAN/Tailscale address (Android emulator or a real phone) →
   Save → New code. The QR appears beside the link text, with the
   fingerprint tail beside it.
2. Phone (development build): scan → the confirm step shows the same
   host:port and fingerprint tail as the laptop → Approve → the laptop shows
   its own confirmation naming the device → Approve there too → the phone
   lands on the Dashboard with live metrics within 2s.
3. Lock the phone 30s, unlock: banner shows reconnecting then clears;
   metrics resume.
4. Desktop: Revoke the device → the phone shows "unpaired" and returns to
   the pairing screen.
5. Re-pair; then delete `~/.config/jarvis/remote/cert.pem` and `key.pem`,
   restart the bridge (Off/On) → the phone shows the fingerprint-mismatch
   banner line and never connects (pinning bites) — it keeps retrying rather
   than unpairing itself (an attacker on the LAN must not be able to force a
   re-pair by presenting a different certificate).
6. Switch language on the phone → restart prompt → restart → the whole UI is
   RTL Arabic. **Known limitation:** the very first launch on a phone whose
   *device locale* is Arabic may still render LTR until the second launch —
   `I18nManager.forceRTL` takes effect natively on the next launch, not the
   current one (only the deliberate in-app language switch above is
   guaranteed to prompt a restart itself).
7. **Scan, paste and a `jarvis://` deep link all stop at the confirm step**
   (host:port + fingerprint tail) before anything connects — none of the
   three skips straight to pairing.
8. **A phone that is already paired refuses a new link** (scan, paste, or
   deep link alike) rather than silently overwriting the existing pairing —
   Settings must unpair first.
9. **The fingerprint tail is identical on phone and laptop** for the same
   pairing — the confirm step's last-4 hex and the desktop's "Certificate
   ends in …" beside the QR must read the same four characters.
10. **iOS: a revoke on the laptop reaches the phone as close code 4410**,
    not 1006 — the phone shows "unpaired" from the real revocation reason,
    not from a plain dropped connection.

    The reverse — the *phone* sending a 4410 close outward — is not a case
    this app exercises: `rpc-client.ts` and `pairing.ts` only ever call the
    native module's `close()` with `CLOSE.normal` (1000); a 4xxx code is
    something the client only ever *receives*, never sends. The native
    `close()` on both platforms is written to accept 4000-4999 (iOS via
    `unsafeBitCast`, since `URLSessionWebSocketTask.CloseCode`'s public
    initializer only covers 1000-1015 — see `PinnedSocketModule.swift`'s
    `close(code:reason:)` comment) for a future caller that might need it,
    but no item on this list can exercise that path today because nothing
    in the app calls it with a non-1000 code.
11. **iOS and Android: the phone's own disconnect (leaving the app,
    unpairing) leaves a clean close code 1000 in the laptop's log**, with no
    reconnect attempt from either side — run this on both platforms; the
    two native modules close outward differently (iOS reports its own close
    immediately on the caller's thread; Android/OkHttp waits for the peer's
    acknowledgement — see `PinnedSocketModule.swift`'s "Close-timing
    difference from Android" comment), so a clean `bye` on one platform
    does not guarantee the other behaves the same.
12. **iOS: kill the network mid-connection → the phone's log shows exactly
    one `rpc: closed code=1006` for the drop** (not a duplicated close event
    from the native layer), followed by the normal reconnect backoff
    (1s, 2s, 4s, … with jitter) once the connection comes back — several
    backoff attempts while the network is still down is correct behaviour,
    not a failure.
13. **The `clearFailed` retry state.** Force a keychain error while the app
    is clearing a revoked pairing (device-specific — e.g. toggling the
    phone's passcode/biometric lock off mid-clear on iOS denies keychain
    access) and confirm the pairing screen shows "Couldn't remove the old
    pairing from this phone" with a Retry button, not a "already paired"
    loop back to a dead Dashboard; Retry succeeding moves on to the scan
    step. This state is exhaustively unit-tested
    (`unpaired-handler.test.ts`, `pair-flow.test.ts`) — this item is a spot
    check that the screen actually renders it, not the primary coverage.
14. **The `expo-system-ui` `userInterfaceStyle` warning no longer appears.**
    `app.config.ts` sets `userInterfaceStyle: "dark"` (theme.ts's tokens are
    dark-only, so `"automatic"` had nothing to switch to) — `expo prebuild`
    should print no warning about it. If one still appears for the SDK
    version in use, note it and check it isn't a new, different warning.
15. **The local-network permission prompt.** On the first LAN dial after a
    fresh install, iOS shows its local-network permission prompt with the
    app-specific text from `NSLocalNetworkUsageDescription`
    (`app.config.ts`) — confirm the bilingual text appears, not a generic
    system prompt. Deny it and confirm the phone shows a connection error
    (reconnecting/offline) rather than hanging indefinitely.
16. **A forged `jarvis://pair?…&clearFailed=1` link on a paired phone shows
    "already paired", not the `clearFailed` state** — the signal only ever
    comes from the automatic unpaired handler (clear-failed-signal.ts), so
    a link carrying that query parameter must be refused the same as any
    other link a paired phone receives.
17. **A warm deep link while on the Dashboard of a paired phone shows
    "already paired".** After unpairing, the scan screen must **not** pop a
    stale confirm step for that old link — the pairing-link holder is
    drained (and the link discarded) whenever the entry check doesn't lead
    to scan, so a link that arrived while paired never resurfaces later.
18. **A warm deep link while an unpaired phone sits on the scan step
    reaches the confirm step** — the same link, arriving while already on
    scan, is not dropped the way a link arriving while busy elsewhere is. If
    a link is tapped during the brief check, tap it again.
## Session terminal — rebuild required

`react-native-webview` is native: rebuild the Android/iOS development build
after pulling the session screen. Expo Go cannot run the pinned socket module.
The terminal uses the desktop's vendored xterm, fit and Unicode 11 bundles and
palette, with a phone font size. After changing those inputs or
`src/terminal/terminal-page.ts`, run
`pnpm --dir apps/mobile run build:terminal-html` and commit the generated
file. The mobile drift test compares it byte for byte.

M8 (voice) adds two more native modules, `expo-audio` and `expo-speech`:
rebuild both the development build and the EAS `preview` APK after pulling
voice. Launching an old build is not part of the pass — the JS guards in the
native adapters do not attempt a fallback, so an old build crashes on
`requireNativeModule` instead.

M10 (push notifications) adds one more native module, `expo-notifications`:
rebuild both the development build and the EAS `preview` APK after pulling
push. Launching an old build is not part of the pass, same reason as M8 above.

**Push credentials.** Notifications need credentials this repository never
holds: an APNs key for iOS and an FCM V1 service account plus
`google-services.json` for Android, both configured once through `eas
credentials` — see [Push notifications setup](https://docs.expo.dev/push-notifications/push-notifications-setup/)
and [FCM credentials](https://docs.expo.dev/push-notifications/fcm-credentials/).
`google-services.json` is gitignored: it is a per-project Firebase secret,
never committed, and every developer or CI machine that builds Android needs
its own copy.

Continue the manual pass on a device; these checks have not been run here:

19. Rebuild the development build (`react-native-webview` is new). Open a
    running Claude Code session from the Dashboard. Its screen matches the
    laptop's Session view: colours, box drawing, wide characters.
20. Answer a permission prompt from the phone with the arrows and ⏎. Type
    `1` with the compose bar: it types only `1`, and nothing is submitted
    until ⏎.
21. ⇧Tab cycles Claude Code's modes (plan mode appears). ^C interrupts. Ctrl
    then `d` sends EOF in a shell-like session.
22. Lock the phone for 30 s while the agent is printing, then unlock. After
    reconnecting, the phone's text matches the laptop's with no duplicated or
    missing lines (a `⋯` marker only if the laptop dropped output).
23. Flood: make the agent print a very large output (for example, ask it to
    cat a multi-megabyte file). The phone stays connected, shows the trimmed
    badge and a `⋯ N KiB ⋯` line, and recovers. Record the observed data rate
    for M5 ruling 18.
24. iOS: open a session with more than 1 MiB of ESC-heavy output retained
    (the flood above). The socket is **not** closed on attach (the 16 MiB
    message size).
25. Cold tester sequence: turn on airplane mode; verify input is disabled
    and draft text is retained; reconnect; confirm nothing is sent until an
    explicit new Send; then make an in-flight send lose its reply and confirm
    the uncertain notice.
26. Open the same session on the laptop and the phone. Rotate or resize on the
    phone and the agent reflows. Click back into the laptop window and the
    laptop's Session view reflows to its own width.
27. In Arabic: the app is RTL, the terminal and key bar are LTR, ← moves the
    cursor left, and key accessibility labels (VoiceOver/TalkBack) are Arabic.
28. A link printed by the agent (plain URL or OSC 8) does nothing when tapped.
    The WebView never navigates.
29. `jarvis://session/<id>` opened from Notes or the browser lands on the
    Dashboard, not the session.
30. A finished session opens read-only with its tail visible, and the key bar
    and compose bar are disabled.
31. Android: kill the WebView renderer (Developer options, or `adb shell am
    crash` on the WebView process where available). The terminal remounts and
    shows the session again.

    M7 final-review carry:

    31a. With an agent printing continuously, run item 31 on Android; on iOS
        background the app for several minutes then return (or trigger a
        content-process kill via memory pressure). The terminal shows the tail
        exactly once — no repeated block at the top.
    31b. Open a session and kill the WebView renderer within the first second.
        The terminal still fills with the session's tail (not blank until the
        next output).
    31c. On both platforms, verify content within ~1 s of opening, after every
        return from background, and after airplane mode on/off. A permanently
        blank terminal means the ready gate was never armed.
    31d. During item 23's flood, tap a printed URL and an OSC 8 link repeatedly
        on Android. Nothing navigates; the app stays in the session.
    31e. Launch the app and tap a Dashboard row immediately; note whether
        "Session not found" flashes before the terminal appears.
    31f. Open `jarvis://session/<id>` from Notes while a session screen is up.
        The app lands on the Dashboard; re-open the session; laptop Settings →
        Remote access shows one device and the session keeps streaming.
    31g. Rotate the phone once. The laptop log shows exactly one
        `session:resize` per rotation after the 300 ms debounce, plus one on
        each reconnect and on returning to the foreground.
    31h. Tap Ctrl (armed), background the app, and return. The cap is not armed
        and a compose send goes through unmodified.

32. **Laptop on Tailscale with `tailscale cert` configured, `sidecarProxy`
    on:** Settings shows "✓ Real certificate for `<name>`" under the
    toggle; the pairing QR's link text contains `&name=`; the phone's
    confirm step shows the name and "trusts the certificate through the
    phone's own trust store" rather than a pin.
33. **Pair; Dashboard → tap a project → the three rows enabled.** Editor
    opens code-server in the WebView (typing in a file works; a terminal in
    code-server echoing back what you type is the WebSocket path working);
    Database opens DbGate **without a login form**; Cluster opens Headlamp
    on an already-connected cluster. Headlamp under the proxy's path prefix
    is unverified in this codebase (`headlamp-server` was never installed
    on the machine this milestone was built on) — if the page is blank or
    its assets 404, record it as the M12 open item; do not patch it here.
34. **On the laptop, revoke the phone while a sidecar page is open:** a
    code-server terminal or an in-flight query dies at once (its socket is
    destroyed), and any idle page fails on its next navigation (the handle
    is gone); either way the app returns to the pairing screen.
35. **While paired: the laptop's Database tab on the desktop logs in by
    itself** (no credential in the status line — it answers Electron's
    `login` event with the instance's own credential instead).
36. **Same laptop, bare LAN (self-signed):** the QR has no `name`; the
    confirm step says "pins …"; the project screen shows the three rows
    disabled with the Tailscale hint; nothing else changed from the M6
    pass.
37. **Pinned pairing, then switch the laptop to `tailscale cert` and toggle
    the bridge:** the phone shows the pin-mismatch banner with a "Pair
    again" button; tapping it, confirming ("This removes the pairing from
    this phone. You'll need to scan a new QR code to pair again. The
    computer keeps this device listed until you also remove it in its
    Settings."), lands on `/pair`; scanning the new QR pairs in
    system-trust mode.
38. **System-trust pairing: run `tailscale cert` again (renewal) and toggle
    the bridge:** the phone reconnects with no banner and no re-pair — it
    was trusting the certificate's name all along, not its fingerprint.
39. **Turn `sidecarProxy` off on the laptop:** the phone's row tap shows the
    laptop's "The sidecar proxy is off in Settings → Remote access on the
    laptop." text; turn it back on with only a self-signed certificate
    served: the row tap shows "…need a real certificate on the laptop
    (`tailscale cert`)…" text and, in this self-signed case, Settings shows
    the matching warning under the toggle (with the proxy off it shows only
    the certificate line, not a warning).
40. **Deep-link/paste a link with `name=192.168.1.2`** → refused as
    malformed, not a crash — an IP literal never matches the hostname
    pattern a `name` has to satisfy.
41. **DbGate on the phone: run a query whose results stream for more than
    10 seconds** — results keep arriving rather than stalling or cutting
    off (SSE through the proxy, which has a connect timeout but no
    response timeout of its own).

Voice, in M8:

42. Rebuild the development build and the EAS preview APK (`expo-audio` and
    `expo-speech` are new). Launching an old build is not part of the pass.
43. Tap the mic on the Voice screen for the first time: the OS microphone
    prompt appears with the bilingual reason. Deny it: the inline line appears
    and nothing records. Deny permanently (iOS Settings / Android "don't ask
    again"): "Open Settings" appears and opens the app's settings.
44. Say "what are my sessions" in English, then an Arabic sentence. Each
    reply appears as text and is spoken by the phone in the right language.
    **The laptop says nothing**, and its Dashboard never shows "speaking".
    Ask two quick questions, tapping the second while the first reply is being
    spoken: the first reply is cut, and the second is spoken once.
45. Record 110 s of speech: it auto-stops at 120 s at the latest, uploads, and
    is transcribed. The laptop console shows `voice-upload: heard … bytes=`
    under 4 MiB. The upload succeeds on iOS and Android, which exercises
    native `sendBinary` on both. On a physical iOS device, repeat with the
    native recorder rather than a simulator microphone.
46. iOS: after recording, the reply plays from the loudspeaker, not the
    earpiece, with the silent switch both on and off.
47. On a session screen, tap the mic and say "yes": the laptop's session
    receives `yes` followed by Enter, and the phone shows the transcript. A
    finished session's mic is disabled.
48. Android physical phone: recording works (AAC 16 kHz, or the 44.1 kHz
    fallback). Note which one appeared in the log.
49. Airplane mode, record, stop: "Not sent" with Retry and Discard. Turn
    airplane mode off and wait for the reconnect: **nothing is sent** until
    Retry. Retry → answered.
50. Start an upload of a long recording and kill Wi-Fi mid-upload: "May not
    have arrived". Reconnect, Retry: the laptop answers once (its console
    shows `replayed`, or a single `heard`), and the brain does not answer
    twice.
51. Leave the Voice screen while Jarvis is thinking: the reply is still
    spoken. Lock the phone while waiting: it is not spoken, and it appears in
    the list on return. Fast Refresh while `/voice` is open must rebuild the
    screen without losing the controller; pull down the notification shade
    mid-recording; the recording stops into "Not sent" with the "stopped in
    background" line. Retry sends it.
52. Speak replies off in Settings: replies are shown, not spoken. The setting
    survives an app restart and a language switch.
53. Laptop security check (the controller or the user, laptop only; a one-off
    Node script using `probe-client.ts`'s `connectDevice(…).upload` against a
    paired test device): a WAV renamed `.m4a`, an HLS playlist with an
    `ftypM4A ` prefix, and 5 MiB of random bytes are each refused or answered
    `failed`/`invalid`. No file remains under `$TMPDIR/jarvis-voice-*`, and
    `lsof`/Activity Monitor shows no lingering `ffmpeg`.
54. On an Android phone without an Arabic TTS voice, an Arabic reply shows the
    "no Arabic voice" notice once and the text.
55. `jarvis://voice` opened from Notes or the browser lands on the Dashboard,
    and the mic does not start.

Workspace, Changes, Docker, history and the API client, in M9 — not run on a
device by any task in this milestone, carried forward from M9's own hand-off:

56. Terminal resizing on a real device (debounce feel, keyboard-avoidance, orientation change).
57. The 25 MiB in-memory upload/base64 ceiling's real memory behavior on
    device hardware (simulated only by byte-count assertions here).
58. The native document-picker's real permission prompts (Files/Photos
    access), including a first-run "not determined" state.
59. Arabic/RTL layout on a real device across every M9 screen (Workspace,
    Changes, Docker, History, API client) — this task only asserts LTR wire
    content, never renders any UI.
60. Large-diff usability in the Changes tab on a real screen size (scrolling,
    truncation, readability) — this task only asserts the diff payload shape.
61. Destructive-action confirmation dialogs (Docker stop/restart/compose down,
    commit, revoke) on real native alert UI.
62. Real reconnect/uncertainty banners and copy under an actual flaky
    connection (Wi-Fi drop, backgrounding, airplane mode) — this task simulates
    drops with a fake transport/clock, never real network timing.

Push notifications, in M10:

63. Configure push credentials once (`eas credentials`: an APNs key for iOS;
    an FCM V1 service account and `google-services.json` for Android). Rebuild
    the development build and the EAS preview APK (`expo-notifications` is
    new). Launching an old build is not part of the pass.
64. Fresh install, pair. **No OS notification prompt appears** at launch, on
    the Dashboard, or on any screen until Settings → Notifications is tapped.
65. Tap the switch: the OS prompt appears. Deny → the switch returns to off
    with the denied line. Deny permanently → "Open Settings" appears and opens
    the app's settings. Allow → the switch stays on and the line reads "On, but
    turned off on the laptop" until the laptop's push checkbox is saved on,
    then "On".
66. Laptop: `devices.json` now has a `push` entry for the phone with
    `platform` and `language` and no other new keys. Settings on the laptop
    still lists the device.
67. Lock the phone. On the laptop, start a Claude Code session in a project
    and let it reach a permission prompt (or run `sleep 8` in its task and let
    it print `Do you want to proceed?` by asking for a file write). Click away
    from Jarvis. Within ~10 s the phone shows "Your session is waiting for you."
    (Arabic if the phone is Arabic) with no output text. Tap it: the app opens
    on that session.
68. Same, but keep the Jarvis window focused → no notification. Same, but keep
    the phone on that session's screen → no notification. Pocket the phone,
    wait 60 s, let the agent finish → a notification.
69. Set `remote.push.includeProjectNames: true` in `jarvis.yaml`, save Settings
    → the next notification names the project. Set it back → it does not.
70. A Terminal tab: run `sleep 40` with `notifyAfterSeconds: 30`, switch to
    another app → "A command finished (about N min) — succeeded." arrives; the
    notification never shows `sleep 40`. `sleep 5` → nothing.
71. From the Voice screen ask a question, lock the phone immediately →
    "Jarvis replied to your message." arrives; tapping opens the Voice screen
    with the reply.
72. Kill a session from the laptop's Session view → **no** notification. Let a
    session crash (an agent command that exits non-zero) → "Your session
    failed.".
73. Ten sessions finishing within a minute → at most six notifications reach
    the phone, and the laptop console shows `rate-limited`.
74. Uninstall the app (or clear its data on Android), let the laptop send one
    more event: the console shows `push: sent batch=… errors=1`, `audit.log`
    shows `push-cleared … reason="not-registered"`, `devices.json` loses the
    `push` entry, and no further attempts appear; the `DeviceNotRegistered`
    message is never shown.
75. Turn the switch off: the laptop's `devices.json` loses the `push` entry at
    once. Turn it on again, unpair from the phone while connected: the entry is
    cleared before the pairing goes. Revoke from the laptop while the switch is
    on: the entry is gone with the device.

M12 idle auto-disable, audit, settings and lifecycle checks:

76. Laptop: set the idle field to `1`, save, disconnect the phone (force-quit
    the app). Settings shows "Will turn off automatically at <time>". After a
    minute the switch is Off, the line reads "Turned off automatically at
    <time> after 1 min idle", the Dashboard indicator is gone,
    `jarvis.yaml` reads `enabled: false`, and `audit.log` ends with `stopped`
    then `idle-disabled afterMinutes=1`. Turn it back on: the phone
    reconnects.
77. Same with the phone connected for 3 minutes → nothing turns off. Open a
    pairing code with no phone connected → nothing turns off while the code is
    valid; cancel it → the countdown line reappears.
78. Open `~/.config/jarvis/remote/audit.log`: after committing from the
    phone's Changes screen there is a `remote-call channel="git:commit"
    deviceId=… outcome="ok"` line; after typing into a session there is
    exactly one `remote-call channel="session:input" key="<id>"` line for
    that session in that connection; after a push there is `push-queued`. No
    line anywhere contains a token, a path, a command or output (search for
    your project path and the word `Token`).
79. Laptop Settings → the "include project names" checkbox on, save → the next
    notification names the project; off → it does not. No YAML editing.
80. Laptop Settings → the paired phone's row says "Notifications on
    (iPhone/Android)" after the phone's switch is on, and the note disappears
    when the switch is turned off.
81. Phone on a session screen, agent printing; press the home button
    (background). Within ~10 s the laptop console shows the device
    unsubscribing (`sub drop`) and a "waiting for you" notification arrives
    in well under 45 s. Return to the app: the terminal catches up once with
    no duplicated block; the laptop console shows one snapshot request.
82. Pull down the notification shade over the app (iOS `inactive`) → no
    unsubscribe; the stream keeps flowing.
83. M5 flood (`remote-probe.mjs --terminal` at 300 MB with the probe paused):
    the laptop frees the hub slot within ~2 s of the congestion line (a second
    client can connect), and the probe ends with 4413 or 1006. The probe
    process itself stays under ~200 MB.
84. Throttle the phone's uplink (Network Link Conditioner "Edge" / Android
    "Slow 2G" emulation) and upload a 60 s recording: the connection survives
    the upload (no `missed pongs` close on the laptop) and the reply arrives.
85. Phone: from the Workspace, a web tab whose URL is `http://0x7f.1/` or
    `http://app.localhost/` shows the "cannot open" notice;
    `https://example.com` opens the browser.
86. Phone: revoke from the laptop while the phone's Settings → Unpair is
    mid-flight (tap Unpair, then revoke within a second). The phone lands on
    `/pair`, Settings is not stuck, and pairing again works without restarting
    the app.

M9 final-review additions:

87. Laptop: open a Terminal tab and split it once. Phone → Workspace: tabs
    listed by project; tap the Terminal tab → both pane keys shown; a second
    split on the laptop → phone Refresh shows three; no laptop tab created,
    activated or closed by any phone action.
88. Phone: open a pane; type `echo مرحبا` + ⏎ → laptop pane shows it; rotate
    the phone → laptop pane cols/rows change; bring the laptop Workspace to
    front → laptop reasserts its own size; `exit` the shell on the laptop →
    phone shows "exited" with input/resize disabled; deep-link
    `/terminal/nope?tabId=nope` → "not found", no subscribe.
89. Phone → Changes: pick a live session, stage/unstage a file, commit with an
    Arabic message; Wi-Fi off + Commit → draft kept + notice; ended session →
    "current working tree" notice; diff block stays LTR under Arabic UI.
90. Phone → History: a transcript containing `<script>` renders as literal
    text; no input bar/resume button.
91. Phone → API: drill collection → folder → request; Send a request with
    pre/post scripts → response shown, "hooks skipped" warning, laptop console
    shows no script run; edit + Save → reopen on laptop: script block gone,
    seq/docs intact; a request with a laptop-local multipart file → Send/Save
    refused until cleared.
92. Phone → API attach: ~20 MB file → progress bar; cancel mid-upload → next
    Attach and the Voice mic show "busy" ≤31 s then recover; >25 MiB file →
    refused before reading; laptop `ls -la
    ~/.config/jarvis/remote/uploads/<deviceId>` → 0700 dir / 0600 files;
    revoke mid-upload → directory removed, phone socket closed.
93. Phone → API import: Postman JSON → name + request count → Import →
    collection on both; non-JSON → localized rejection, nothing written.
94. Phone → API: a secret environment variable masked until Reveal; an oauth2
    request shows the laptop-only notice and Send is refused by the laptop.
95. Phone → Docker: Follow logs; switch containers quickly; background 30 s
    and return → fresh segment with reconnect marker; Stop/Restart/Compose
    Down confirm; two compose projects → no compose buttons; Shell row
    laptop-only.
96. Laptop: `tail ~/.config/jarvis/remote/audit.log` + app console after 89–95
    → remote-call lines carry channel/deviceId/outcome only; no bodies,
    tokens, file names, host paths or terminal bytes.
97. Phone in Arabic: chrome mirrors RTL; terminal, diff hunks, cURL text and
    response bodies stay LTR and selectable.

M10 final-review additions:

98. Android fresh install with `google-services.json`: never open Settings;
    watch adb logcat for `expo-notifications/getExpoPushToken` and the
    laptop's `devices.json` for 2 min after first launch and after
    force-stop/relaunch — no Expo token request, no push entry. Tap the
    switch: the request appears once.
99. Notifications on + registered; phone internet off but laptop reachable;
    force-quit, relaunch, connect: the switch stays on ("pending/on"), never
    flips off by itself. Restore internet, reconnect: registered again, no OS
    prompt.
100. Laptop asleep, unpair from the phone (unregister fails silently), wake
     laptop, re-pair the same phone, Notifications on: exactly one push per
     event; `devices.json` holds the token under one device only.
101. Answer a Claude Code permission prompt from the phone, pocket it, let a
     >5 s tool call run: note any false "waiting for you" push; when real
     output resumes it must not repeat inside 60 s.
102. `remote.push.enabled` true, then let the bridge idle-disable (or
     `remote.enabled false`): pushes still arrive; the tap opens the Dashboard
     offline and nothing else — decide whether wanted.
103. Two voice questions inside one minute with the phone locked: one "Jarvis
     replied" push.
104. Android 13+: deny POST_NOTIFICATIONS once, relaunch, tap the switch again:
     the prompt appears again; deny again → "Open Settings" and
     `devices.json` never gains a push entry.
105. Laptop: hand-edit `devices.json` to an invalid `push.token` and restart:
     the bridge refuses the file (Settings shows the error, audit has `error`),
     no device silently dropped; restore recovers.
106. Cold start: force-quit, receive a session-done push, tap before connect
     completes: the app waits (≤15 s) then opens the session; a notification
     for a since-deleted session → Dashboard only.
107. Send a session-done, then within 15 min toggle the switch off/on: after
     the receipt fetch the registration is still present; `audit.log` shows
     one push-cleared unregistered and one push-registered.
108. Rebuild both native targets: Android compiles `offsetByCodePoints` in
     `clampReason` and the `didEmitClose` guard in `onFailure`; iOS compiles
     `URLSessionConfiguration.ephemeral`. On Android, force a pinned-cert
     mismatch and confirm exactly one error banner appears.
109. Set `remote.idleDisableMinutes: 1`, disconnect the phone, and close
     pairing. Within about a minute, Settings shows the automatic-off time,
     the switch and `jarvis.yaml` say off, audit has one `idle-disabled`
     after `stopped`, and the port is closed. Pair cannot open. Turn it on:
     connecting clears the armed deadline; disconnecting sets a new one.
110. While idle is armed, try an unpaired phone's wrong pairing and confirm
     the deadline does not move. From another machine, hold a bare `/pair`
     WebSocket open every 30 seconds for two minutes; the bridge still turns
     off at its original deadline.
111. On a fresh install, leave Notifications off: no `push-registered` audit
     line or token in Settings. Turn it on, grant permission, and check
     `push-registered`; turn it off and check `push-cleared`. Relaunch with
     it on: no second permission prompt and the switch stays on.
112. On a slow link, toggle Notifications on and immediately off. The switch
     stays off and the final audit event is `push-cleared`.
113. Stream a Terminal tab, then background the phone. Settings still shows
     the device connected; a session-done push arrives while backgrounded.
     Foregrounding resumes the stream without duplicate output. After a
     background interval longer than the heartbeat, check reconnect again.
114. Misconfigure `whisper` on the laptop and trigger a desktop voice turn:
     the phone says only "Transcription failed." while the laptop log keeps
     the error detail.
115. From the Dashboard tap a project's Terminal tile: the laptop opens a
     Terminal tab in that project and the phone lands on it; the audit log
     has a `remote-call channel="terminal:open" outcome="ok"` line (no
     `key=` — that field is first-per-key-only, never set for a `mutate`
     channel like this one). Repeat from the Workspace screen's own "New
     terminal" button. Tapping either while disconnected shows it disabled;
     naming a project the laptop has not configured (e.g. a stale deep
     link) answers "Unknown project" inline instead of opening anything.
116. On the laptop, run an agent CLI (`claude` or `codex`) directly in an
     ordinary terminal, outside Jarvis. Pull to refresh the phone's Sessions
     screen: the row appears with an "outside Jarvis" chip, its summary and
     project derived from the transcript once one exists, and tapping it
     does nothing (no navigation into a terminal). End the process and pull
     again: the row moves to Ended once its transcript's own state catches
     up, or disappears from Active if the scan simply no longer finds the
     pid. Desktop parity: the same row and chip appear in the Sessions view
     table and the Dashboard SESSIONS card after clicking either Refresh
     icon.
117. **Laptop Settings → Remote access, no certificate configured yet:**
     click **Get certificate from Tailscale** (busy state, then the
     certificate row names it and the sidecar proxy switch turns on by
     itself). Pair the phone: the QR's link carries `&name=`. Dashboard →
     tap a project → the three sidecar rows are enabled and open. Click the
     button again — now labelled **Renew** — and confirm the phone's own
     connection is unaffected (no re-pair, no dropped session).
