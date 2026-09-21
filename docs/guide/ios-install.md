# iPhone and iPad

Jarvis's companion app runs on iOS and iPadOS, but it is not on the App
Store and there is no TestFlight build. Both require Apple's paid
developer programme ($99/year), which an open-source side project does
not carry. What ships instead is an **unsigned IPA** on every
[release](https://github.com/mmAbdelhay/jarvis/releases), and each user
signs it onto their own devices with their own **free Apple ID**. That
is Apple's sanctioned free path, and it comes with fixed limits:

- **The app expires 7 days after signing** and must be refreshed. The
  tools below automate this so it normally happens without you.
- **At most 3 sideloaded apps per device**, and the sideloading tool
  itself counts as one.
- **No push notifications** — free signing strips that entitlement, so
  the laptop cannot ping the phone when an agent finishes. The app
  detects this and says so in Settings; everything else (pairing,
  terminals, sessions, voice, the Workspace tabs) works unchanged, and
  the in-app expiry warning still fires because it uses local
  notifications, which survive free signing.
- **A missed refresh is not data loss.** The app refuses to open until
  the next refresh; the pairing and settings survive as long as the app
  is not deleted.

A signature made with a free Apple ID only works on devices tied to that
Apple ID — nobody can sign once and hand out a working app. Pick one of
the three routes below.

## Route A: AltStore Classic + AltServer (Mac or Windows nearby)

Best when the desktop that runs Jarvis is a Mac or Windows machine on
your home network — refreshes happen over plain Wi-Fi in the background,
and **Tailscale can stay on**, since no VPN is involved.

> **AltStore Classic, not AltStore PAL.** The AltStore site leads with
> PAL, its app-marketplace edition that only exists where the law forces
> Apple to allow marketplaces (the EU, Japan, Brazil). Ignore it —
> **AltStore Classic** is the sideloading tool, it works worldwide, and
> it is what this page means everywhere it says AltStore.

1. Install [AltServer](https://altstore.io) on the computer (pick
   **AltStore Classic** on the site) and keep it running (it lives in
   the menu bar / tray).
2. Install AltStore onto the iPhone/iPad through AltServer (connect the
   device over USB once; enable Wi-Fi sync when it offers).
3. In AltStore on the device, add the Jarvis source —
   `https://mmabdelhay.github.io/jarvis/altstore/source.json` — and
   install Jarvis from it. Updates arrive there too. (Or download the
   IPA from the releases page and open it with AltStore directly.)
4. Done. Devices refresh whenever they share a Wi-Fi network with the
   computer while AltServer is running and signed in.

The one gap: more than 7 days away from that network and the app expires
until you are back. If that is your life, use SideStore instead.

## Route B: SideStore (no computer after setup)

Best for Linux desktops and for people often away from home. SideStore
refreshes **on the device itself** — no computer needed after the
one-time setup ([sidestore.io](https://sidestore.io); it needs a pairing
file and installs a local VPN profile).

Add the same source URL as above, install Jarvis, done.

**The Tailscale catch:** iOS allows one active VPN at a time, and
SideStore refreshes through its local VPN. If you pair with the laptop
over Tailscale, the refresh needs Tailscale toggled off for about a
minute. The app cannot do that switch itself — iOS only lets an app
control its own VPN configuration — but a Shortcuts automation can:

1. Open Shortcuts → Automation → new personal automation, time of day
   (say 4 am, daily), **Run Immediately**.
2. Actions, in order: *Disconnect Tailscale* (Tailscale exposes this
   action) → *Enable SideStore VPN* → SideStore's **Refresh All Apps**
   → *Disable SideStore VPN* → *Connect Tailscale*.

Daily rather than weekly, so one missed run (phone locked, off Wi-Fi)
costs nothing. Pairing over the local network is unaffected by all of
this — the VPN dance only matters for Tailscale users.

## Route C: build from source in Xcode (developers)

A Mac with Xcode can build straight onto a cable-connected device with a
free Apple ID — no AltStore involved, same 7-day limit, refreshed by
hitting Run again:

1. Xcode → Settings → Accounts → add your Apple ID; it creates a free
   "Personal Team".
2. `cd apps/mobile && npx expo prebuild --platform ios`, then open
   `ios/Jarvis.xcworkspace`.
3. Target → Signing & Capabilities: tick "Automatically manage
   signing", pick the Personal Team, and change the bundle identifier
   to something unique (e.g. `com.yourname.jarvis`).
4. **Remove the Push Notifications capability** — free signing refuses
   it and the build fails otherwise. The app copes (see above).
5. Set the scheme to **Release** (Product → Scheme → Edit Scheme), so
   the JS bundle is embedded and the app works away from the Mac.
6. On the device: enable Developer Mode (Settings → Privacy & Security),
   plug in, select it in Xcode, Run. Then trust your certificate under
   Settings → General → VPN & Device Management.

## After installing

Pair the device exactly like the Android app: desktop → Settings →
Remote access → show the QR, scan it from the app — see
[Remote access](remote-access.md). On an iPad the app runs as a real
tablet app; the sidecar tabs (editor, database, cluster) are worth the
screen.

When fewer than 2 days of signature remain, the Dashboard shows a
warning banner and the app schedules a local "expires tomorrow"
notification — if you see either, run a refresh (AltStore/SideStore) or
rebuild (Xcode).
