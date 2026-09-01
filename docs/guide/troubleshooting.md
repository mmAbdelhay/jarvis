# Troubleshooting

## The Editor or Database tab shows an error

Both spawn an external binary. `code-server` and `dbgate-serve` are separate
installs (see [installation](installation.md)); when one is missing, the tab
reports it in the status line rather than hanging.

DbGate can also fail because it never began listening. Its port is discovered
by reading its own startup line, so a version that changes that line fails
loudly here rather than silently.

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
