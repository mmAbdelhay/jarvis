# Hosting Headlamp as a Workspace tab

**Question.** Can a Kubernetes UI be added the way the Editor and Database tabs
were — spawn something that already exists, open its URL as a tab — or does a
cluster browser have to be built?

**Answer.** It can. `headlamp-server` binds loopback, serves the whole Headlamp
front end, and authenticates to EKS through the kubeconfig's `exec` credential
plugin without a terminal. Measured against a live EKS cluster, not a fixture.

## What was run

The binary is not distributed on its own. Every Headlamp release is a desktop
app bundle, and the server sits inside it at `resources/headlamp-server` — the
same relative path on all three platforms, because they are all Electron:

| | |
|---|---|
| macOS | `/Applications/Headlamp.app/Contents/Resources/headlamp-server` |
| Linux | `/opt/Headlamp/resources/headlamp-server` (deb; AppImage and tar.gz mirror it) |
| Windows | `%LOCALAPPDATA%\Programs\Headlamp\resources\headlamp-server.exe` |

Extracted from the 0.45.0 arm64 dmg without installing it, and run as:

```
headlamp-server -html-static-dir <bundle>/frontend \
                -kubeconfig ~/.kube/config \
                -listen-addr 127.0.0.1 -port <free>
```

It came up on 127.0.0.1 and picked up all four contexts in the kubeconfig.

## Loopback, not a generated login

`-listen-addr` is honoured. Headlamp is therefore the code-server case, not the
DbGate one: nothing else on the network can reach it, so it needs no per-spawn
credential. That was the open risk and it is closed.

## The exec credential plugin does run

The EKS contexts here authenticate through `aws eks get-token` with
`AWS_PROFILE=saml` and `interactiveMode: IfAvailable`. A spawned server has no
tty, so whether client-go would still invoke the plugin was the second unknown.

Tested by copying the kubeconfig aside and replacing the `exec.command` of one
user with a script that logs its arguments and then execs the real `aws`. Under
that config, a request through the proxy produced:

```
EXEC PLUGIN INVOKED: --region eu-west-1 eks get-token --cluster-name app_dev \
  --output json (AWS_PROFILE=saml PATH_OK=yes)
```

and the request itself returned real data — `v1.36.2-eks-bca9cf6`, 31
namespaces, 38 pods in `kube-system`. The plugin is invoked, its `env:` block is
honoured, and no terminal is needed.

**What this costs the spawn.** The plugin is found on `PATH`, so the server must
be spawned with a `PATH` that contains `aws` — a login shell's `PATH`, not the
one an Electron app inherits from the Finder. `interactiveMode: IfAvailable`
also means a profile whose session has expired cannot re-authenticate from
here; the SAML login happens in a terminal and the server reuses the cached
credentials, exactly as Lens does.

## Two things worth noticing

**Context names are rewritten in URLs.** `/` becomes `--`; the colons survive,
because a colon is legal in a path segment and a slash is not. The context
`arn:aws:eks:eu-west-1:123456789012:cluster/app_dev` is reached at
`/clusters/arn:aws:eks:eu-west-1:123456789012:cluster--app_dev`, and the front
end routes it under `/c/:cluster`. A manager that builds a URL from a context
name has to apply the same rule.

**`-skipped-kube-contexts` exists**, which is how one project's tab can be shown
only that project's clusters without writing a filtered kubeconfig.

## Start-up

About twelve seconds cold, roughly one warm — between code-server and DbGate.
The Editor and Database buttons already solve this: disable, say *Starting…*,
and begin the spawn on hover. The same treatment applies unchanged.

## Not pursued

A `kind` cluster was created to prove the pipeline and then deleted; the EKS
run had already proved it against something real. Nothing from this spike is
kept — no app installed, no cluster left, no file in `~/.kube` touched.
