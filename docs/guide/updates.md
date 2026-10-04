# Updates

Jarvis keeps itself up to date from its
[releases page](https://github.com/mmAbdelhay/jarvis/releases). Settings →
General → **Updates** shows the version you are running, when it last checked,
and a **Check now** button.

## When it checks

Once each time Jarvis starts, and once a day while it stays open. A check is a
single request to GitHub's public releases API asking for the latest release.
It carries no token and nothing about your machine, your projects or your
sessions. A check that fails — offline, GitHub unreachable — changes nothing;
the card just says the last check failed.

When there is a newer version, a dot appears on the Settings icon and the
Updates card shows the version, the start of its release notes with a link to
the full notes, and **Install update**.

## What Install update does

1. Downloads the build for your computer and the release's `SHA256SUMS` file,
   with a progress bar and a **Cancel** button while it downloads.
2. Checks the download's SHA-256 against `SHA256SUMS`. A release without that
   file, or a download that does not match it, is refused and deleted — nothing
   is installed.
3. Asks before restarting, and says how many terminals and agents are running.
   **Restarting Jarvis ends every running terminal**, and the agents in them.
   **Later** keeps the verified download until you quit.
4. Replaces the app and starts the new version. If the background service is
   running, it restarts on the new build.

If anything goes wrong at any step, the installed app is left as it was and the
card says what failed in one line.

## Where it can install

Jarvis checks these before it downloads anything. Where it cannot install,
the card says why and links the release page instead of offering Install
update, and nothing is downloaded.

**macOS** — Jarvis replaces itself in the folder it runs from, so that folder
has to be one you can write to, such as `/Applications`. Running it straight
from the mounted `.dmg`, or from Downloads (where macOS runs it from a
read-only copy), it cannot update itself: drag it to Applications first.

**Linux** — only the AppImage updates itself, in place, at the same path, so a
systemd unit or launcher pointing at it keeps working. The AppImage's folder
has to be one you can write to. A Jarvis run any other way gets the release
page link.

**Windows** — the release ships a `.zip`, which the updater does not install.
The card links to the release page; download the new build from there.

**From source** — a development run (not the packaged app) never installs an
update; the card says so and links the release page.

**Android** — the phone app does not update itself. Install the new
`jarvis-mobile-<version>.apk` from the releases page.
