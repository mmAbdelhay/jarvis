# Widevine / DRM in the hosted browser — stage 1

## The question

Netflix in the personal browser fails with `M7701-1003`. Stock Electron
ships Chromium *without* the Widevine CDM, and without any way to add one:
`strings` over `electron@44.0.0`'s framework finds no `WidevineCdm`, no
`libwidevinecdm.dylib`, and no `--widevine-cdm-path` switch. That switch was
removed when Chromium moved Widevine to the component updater, so the
copy-it-out-of-Chrome trick that the internet still recommends is dead.

Stage 1 asked one thing: does castLabs' Electron for Content Security (ECS)
actually decrypt and play a real DRM stream here, on this machine?

## Answer: yes

`electron` swapped for `github:castlabs/electron-releases#v44.1.0+wvcus` —
a drop-in fork, and *ahead* of the 44.0.0 we were pinned to, so nothing
regressed. The CDM is not bundled; Chromium's component updater fetches it
on first launch:

    Widevine Content Decryption Module 4.10.3050.0  status: updated

EME in the app renderer, which throws `NotSupportedError` on stock Electron:

    com.widevine.alpha  OK      org.w3.clearkey  OK

And real playback (this spike — Shaka's Angel One Widevine asset against
their public no-auth license proxy):

    keySystem: com.widevine.alpha
    license accepted, 103 frames decoded, currentTime 0.00 -> 3.96

## Two things worth keeping

**R35 wins over castLabs' example.** Their README awaits
`components.whenReady()` before creating the window. That is a network
fetch between app-ready and the window existing, which R35 forbids — on a
first launch it would hold a blank screen for the length of the download.
`main.ts` starts it unawaited and keeps the promise instead; the tabs that
need DRM await it, the window does not. The cost is that the very first DRM
page after a fresh install may load before the CDM does.

**This does not yet get Netflix.** ECS's prebuilt binaries are VMP-signed
*for development* — enough for Widevine test servers like the one above,
and not enough for a commercial service. Netflix needs a production VMP
signature from castLabs' EVS (free, requires signup). That is stage 2, and
on macOS the VMP signing has to happen BEFORE the `codesign` step, which
here is the ad-hoc `codesign --force --deep --sign -` run after packaging.

## Reproduce

    cd packages/desktop && ./node_modules/.bin/electron ../../spikes/widevine/main.cjs
