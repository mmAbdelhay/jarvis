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

## `-skipped-kube-contexts`, verified (Task 1)

Re-extracted the same 0.45.0 arm64 binary into a fresh temp dir and ran it
against the real 4-context kubeconfig (three EKS ARNs, one `kind-kind`),
skipping different subsets each run, then reading `/config` and the startup
log's `Proxy setup` lines. AWS SAML credentials were expired throughout; that
does not matter here because the filtering happens at startup from the
kubeconfig file, before any cluster is contacted.

**It works, but only against the URL-rewritten context name, not the raw
kubeconfig name.** Passing an EKS context exactly as `kubectl config
get-contexts -o name` prints it —
`arn:aws:eks:eu-west-1:210987654321:cluster/Cast_AI` — has **no effect**: the
context still appears in `/config` and still gets a `Proxy setup` log line.
Passing the same context with its `/` rewritten to `--` (the identical rule
already noted above, that Headlamp applies when building cluster URLs) —
`arn:aws:eks:eu-west-1:210987654321:cluster--Cast_AI` — filters it out of
`/config` correctly. `kind-kind` contains neither character and worked
unmodified either way. Colons needed no escaping in either form; the shell
only needed the value quoted as a whole because of the commas.

Three-part answer:

1. **Comma-separated list of multiple contexts: yes.** A single flag value
   `"arn:aws:eks:eu-west-1:210987654321:cluster--Cast_AI,arn:aws:eks:eu-west-1:123456789012:cluster--app_staging"`
   filtered both out of `/config` in one run, leaving the other two
   (`app_dev`, `kind-kind`) — using the rewritten (`--`) form for each ARN. A
   mixed list of one rewritten ARN plus `kind-kind` also filtered both
   correctly.
2. **Skipped contexts disappear from `/config`: yes** — provided the value
   passed uses the rewritten name for any context whose kubeconfig name
   contains `/`. The raw name is silently ignored (not an error, not a
   partial match — just never removed).
3. **Skipped contexts disappear from the startup log's `Proxy setup` lines:
   no, never, regardless of format.** Every run — 4 skipped 0, 2 skipped,
   1 skipped, in every naming form tried — logged exactly 4 `Proxy setup`
   lines, one per kubeconfig context. The flag filters what `/config` exposes
   to the front end; it does not stop the server from building a proxy for
   every context at startup. A manager that keys "how many clusters did the
   server actually see" off `Proxy setup` line counts will be wrong; `/config`
   is the correct source of truth for what a project's tab shows.

**Consequence for Task 4.** `HeadlampManagerDeps`/the spawn code must rewrite
any context name containing `/` to use `--` in place of `/` before it goes
into `-skipped-kube-contexts` — the same transform already required for
building per-cluster URLs. With that transform applied, `-skipped-kube-contexts`
is sound as the filtering mechanism and the kubeconfig-rewrite fallback
described in the task brief is not needed.

Binary and frontend were extracted to a `mktemp -d` directory and the
directory removed at the end; `~/.kube/config` was read-only throughout and
was not modified; no `headlamp-server` process was left running
(`pgrep -fl headlamp-server` returned nothing).
