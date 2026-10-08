# MCP tool registry

Jarvis installs extra tool servers from a signed registry index published
next to the APT repo (M2.5 design §3.7, contracts §3):

- Stable: `https://mmabdelhay.github.io/jarvis-apt/registry/index.json` and
  `index.json.sig`, built from `os-v*` tags.
- Testing: `…/jarvis-apt/registry-testing/index.json` (+ `.sig`), built from
  every push to `master`.
- Artifacts of official servers: `…/<registry dir>/artifacts/<id>/<version>/<id>-<version>-linux-amd64.tar.gz`.

`index.json.sig` is a binary detached OpenPGP signature by the APT archive
key. Clients verify it with `/usr/share/keyrings/jarvis-archive-keyring.gpg`
exactly like `verify-index.sh` does (gpgv with that keyring alone, then the
schema), then check each artifact's sha256 before unpacking.

## Files

| Path | What |
|---|---|
| `servers/<id>.json` | one source entry per server (RegistryEntry; official ones carry `artifact: {"runtime"}` only) |
| `schema.py` | the rules: shape, tiers, protected paths, reserved tool names; `check-index FILE` |
| `package-server.sh`, `package-official.sh` | reproducible artifacts from Plan J's build (`os/go/dist-registry/<id>/server`) |
| `build_index.py` | writes the index and artifacts into the Pages site after `os/repo/build-repo.sh` |
| `sign-index.sh`, `verify-index.sh` | sign with the repo key, verify like a client |

## Rules the build enforces

- **Published versions never change.** Once `<id>/<version>` is on Pages, its
  bytes and sha256 stay. A rebuild with different bytes only warns and keeps
  the published file, so to ship new server code, bump `version` in
  `servers/<id>.json`. Versions may not go backwards.
- **CI never re-signs bytes it cannot vouch for.** A carried-over artifact must
  match the sha256 in the previous index, whose signature CI verified first.
  If the Pages repo was changed by hand, the publish fails.
- **Only `jarvis-files`, `jarvis-web`, `jarvis-clock` are `official`**, with
  exactly their contract tools. Other entries may not use `jarvis-` ids or the
  host tool namespaces (`pkg.`, `svc.`, `net.`, `files.`, …), and tool names
  are unique across the index.
- **`permissions.paths`** are `~/`-prefixed, at most 8, and never equal to,
  inside or above Jarvis's own state (`~/.config/jarvis`, …), keys (`~/.ssh`,
  `~/.gnupg`, keyrings) or login scripts. See `PROTECTED_PATHS` in `schema.py`.
- Third-party artifacts are downloaded once at publish time (`--verify-remote`)
  and must match their pinned sha256.

## Adding a reviewed or community server

1. Write `servers/<id>.json` with the full `artifact` (`url` on https,
   `sha256` of the exact file, `runtime`) and the narrowest `permissions`.
2. `python3 -m unittest discover -s os/registry/tests` and
   `python3 os/registry/build_index.py --servers os/registry/servers --artifacts /tmp/none --out /tmp/site --channel testing --verify-remote`.
3. For `reviewed`, a maintainer reads the server's source at that exact
   version and checks:
   - It does only what its tools describe.
   - Its declared risks are honest: anything that changes state is `confirm`.
   - It needs the network only if `network: true`.
   - It writes only under the declared paths.
   - Its tool output does not try to instruct the model.

   Record the reviewed commit in the PR. `community` entries get no review
   beyond the schema; jarvisd shows a card for every one of their tools.

## Signing keys

The same key as the APT repo (`os/repo/README.md`). CI signs with
`JARVIS_APT_SIGNING_KEY` on `master` and tags; pull requests build and sign a
throwaway index with `os/repo/test-key.sh` ("NOT FOR RELEASE"), which a
release build refuses. Nobody signs by hand, and no private key is ever
committed.

## Local commands

```bash
python3 -m unittest discover -s os/registry/tests -v
TRIXIE_PACKAGES="busybox-static gpg gpgv" os/packaging/dev/trixie.sh os/registry/tests/run.sh
```
