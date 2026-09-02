# Troubleshooting

## The Editor or Database tab shows an error

Both spawn an external binary. `code-server` and `dbgate-serve` are separate
installs (see [installation](installation.md)); when one is missing, the tab
reports it in the status line rather than hanging.

DbGate can also fail because it never began listening. Its port is discovered
by reading its own startup line, so a version that changes that line fails
loudly here rather than silently.

## The Editor, Database or Cluster tab takes a long time to open

The wait is the binary's own start-up, not Jarvis's. Measured here:
code-server about a second warm and nine cold, `dbgate-serve` about a second
warm and twenty-two cold, `headlamp-server` about twelve seconds cold —
"cold" meaning its files are not in the page cache, which is the first open
after a reboot. The toolbar says which one it is waiting for and the button
is disabled until it answers, so a slow start looks like a slow start rather
than a frozen app.

**Hover the button a moment before clicking it.** That begins the spawn early
and the click joins it; it turns a five-second wait into about a tenth of a
second. Nothing is spawned twice — the manager shares one start per project.

If DbGate genuinely never answers, its instance is killed after sixty seconds
and the status line says so.

## A hosted page does not fill its slot

A browser or editor page leaving a band of empty window down the right, or
sitting up over the bookmarks bar, means the rectangle main was given is in
different units from the ones it placed the view with. The renderer measures
in CSS pixels; a view is placed in device-independent pixels, and those differ
on a display running a scaled resolution.

Jarvis converts for this (`devicePixelRatio / scaleFactor`, per the display the
window is actually on) so dragging the window between monitors of different
scales is handled. If it recurs, it is a bug in that conversion — check
`view-bounds.ts`, and compare the hosted view's width against the *window* in
DIP, never against the slot in CSS pixels, which is the comparison that hides
the fault.

## A request says "fetch failed — connect ECONNREFUSED ::1:8088"

Nothing is listening. Note the `::1`: `localhost` resolves to IPv6 first on
macOS, so a server bound only to `127.0.0.1` is not reachable as `localhost`.
Either bind it to both, or write `127.0.0.1` in the environment.

## A request says "No value for: apiKey"

The selected environment has no such variable. The request was still sent, with
`{{apiKey}}` left as written — see [the API client](api-client.md#variables-and-environments)
for why that is deliberate.

## The Database tab asks for a login every time

By design. DbGate has no way to bind to loopback, so each instance is guarded
by a credential generated when it starts. It changes when Jarvis restarts.

## The Cluster tab says it cannot open, and it worked yesterday

Jarvis does not manage cluster credentials. A kubeconfig context that
authenticates through an `exec` plugin — `gcloud`, `kubelogin` — needs a
session that is already valid, and a spawned server has no terminal to prompt
in. Log in the way you normally would (`aws sso login`, and check with
`kubectl get ns`), then press the button again. Lens behaves the same way for
the same reason.

AWS is the exception. For a context whose plugin is `aws eks get-token`,
the button logs you in itself: it opens a Terminal tab, runs
`saml2aws login && aws eks update-kubeconfig …`, and carries on to the
cluster once that succeeds. Approve the MFA push when it arrives. If it does
not finish, see below.

## The Cluster tab shows clusters from another project

This should not happen; if it does, the context names in `clusters:` do not
match the kubeconfig exactly. The filter Jarvis passes to `headlamp-server`
matches on the exact context name, so a name that is close but not identical
is treated as a different cluster and left visible rather than hidden.

## The button says "Could not open the cluster browser"

Most often `headlamp.binary` — set explicitly or defaulted per OS (see
[installation](installation.md)) — names nothing that exists. Install
Headlamp, or point `headlamp.binary` at the real path.

The same message covers every other way an open can fail: the server started
but never began listening, the context named in `clusters:` is no longer in
the kubeconfig, or the cluster credentials have lapsed and the kubeconfig's
credential plugin cannot refresh them.

**"AWS login did not finish in time."** The Cluster button ran
`saml2aws login && aws eks update-kubeconfig …` in a Workspace Terminal tab
and it did not succeed within three minutes — a declined or missed MFA push,
a wrong password, or `saml2aws` itself erroring. The terminal tab is left
open; check it, finish or retry the login by hand, then click Cluster again.

## Voice does nothing

`whisper.binaryPath` and `whisper.modelPath` must both point at files that
exist. If a hotkey is already taken by another app, Jarvis says so at startup
rather than silently not listening.

## Settings saved, nothing changed

Nothing is applied live. Use **Restart Jarvis** after saving — the button
appears once a save succeeds.

## Comments disappeared from jarvis.yaml

A Settings save rewrites the file. The previous version is beside it as
`jarvis.yaml.bak-<timestamp>`.

## The app looks stale after a code change

`tsc` alone is not the build. The renderer's vendored libraries and the icon
are copied into `dist/` by a script:

```bash
pnpm --filter @jarvis/desktop build
```

## A terminal tab is gone after opening many tabs

Only hosted pages are capped (eight, each a Chromium process). Terminal and API
tabs are exempt from eviction — if one disappeared, it was closed, not evicted.
