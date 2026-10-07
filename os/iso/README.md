# Jarvis OS ISO

Debian 13 (trixie) amd64 live ISO that boots straight into the Jarvis shell
(design: `docs/superpowers/specs/2026-10-07-jarvis-os-m1-design.md` §9).

| Path | What |
|---|---|
| `bootappend` | The live kernel command line (boot menu and smoke harness read it) |
| `auto/`, `config/` | live-build configuration: package lists, hooks, session files |
| `build.sh` | Debs → ISO. Root, Debian trixie only |
| `scripts/` | Boot timeouts, release guard, chroot and ISO checks |
| `dev/` | Stub debs and the Docker build wrapper |
| `smoke/` | QEMU smoke tests (design §11) |
| `../packaging/` | The five `.deb`s |

## Get an ISO

**From CI (recommended, especially on Apple Silicon).** Every run of the
`OS` workflow uploads `jarvis-os-iso`:

```bash
gh run list --workflow os.yml --limit 5
gh run download <run-id> --name jarvis-os-iso --dir ~/Downloads/jarvis-os
```

**Build locally (amd64 Linux with Docker).**

```bash
# Real packages (needs Plans A, B and C built first):
make -C os/go dist
pnpm --filter @jarvis/desktop build:daemon
cmake -S os/shell -B os/shell/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr && cmake --build os/shell/build
os/packaging/build.sh --out /tmp/jarvis-iso/debs jarvisd jarvis-shell jarvis-pkg jarvis-diag jarvis-helper
os/iso/dev/build-in-docker.sh /tmp/jarvis-iso /tmp/jarvis-iso/debs

# Or stub packages, to work on the ISO itself:
os/iso/dev/build-in-docker.sh /tmp/jarvis-iso
```

The ISO lands in `/tmp/jarvis-iso/dist/`. `/tmp/jarvis-iso/lb-cache` keeps
downloaded packages between builds. On Apple Silicon the same command runs
under amd64 emulation in Docker Desktop and takes hours; use the CI artifact.

## Run it on a Mac (Apple Silicon)

Apple Silicon cannot virtualize amd64, so the ISO runs emulated (QEMU TCG).
Expect a few minutes to reach the shell; it is usable for UI checks, slow for
installs.

**UTM** (`brew install --cask utm`): Create a New Virtual Machine →
**Emulate** → Linux → Boot ISO Image: the downloaded `.iso`. Architecture
x86_64, system "Standard PC (Q35 + ICH9)", memory 4096 MB, 4 cores, no
storage needed (live session). Under Display choose `virtio-vga`. Start it:
the GRUB (UEFI) menu boots by itself after 5 seconds, then the Jarvis shell
appears with no login. Super brings the chat to the front; Ctrl+Alt+T opens a
terminal (in UTM, enable "Capture input" first so the keys reach the guest).

**QEMU directly** (`brew install qemu`):

```bash
qemu-system-x86_64 -machine q35 -accel tcg,thread=multi -cpu max -smp 4 -m 4096 \
  -drive if=pflash,format=raw,readonly=on,file="$(brew --prefix qemu)/share/qemu/edk2-x86_64-code.fd" \
  -cdrom ~/Downloads/jarvis-os/jarvis-os-*.iso \
  -device virtio-vga -display cocoa \
  -nic user,model=virtio-net-pci
```

Drop the `-drive if=pflash...` line to boot through BIOS (isolinux) instead
of UEFI (GRUB); both menus must auto-boot.

## Smoke tests

```bash
# Linux with KVM (CI does this):
sudo apt-get install qemu-system-x86 xorriso
python3 os/iso/smoke/run_smoke.py --iso /tmp/jarvis-iso/dist/*.iso --out /tmp/smoke

# macOS (TCG; every timeout is multiplied by 4, allow 30-45 minutes):
brew install qemu xorriso
python3 os/iso/smoke/run_smoke.py --iso ~/Downloads/jarvis-os/*.iso --out /tmp/smoke --accel tcg
```

The harness boots the ISO's own kernel and boot line plus
`console=ttyS0 systemd.debug_shell=ttyS0`, which gives it a root shell on the
serial port. It switches on the fake provider (`JARVIS_FAKE_PROVIDER`) only
in that boot's user manager, from a separate read-only assets disk; nothing
in the ISO can turn it on (`scripts/release-guard.sh` fails the build if
anything tries). Results: `/tmp/smoke/summary.md`, `results.json`,
`serial.log`, `diagnostics.txt`, `screen.png`.

Idle RAM (criterion 2) is `MemTotal - MemAvailable` after a 60 s settle.
Above 600 MB is a warning; above `--ram-fail-mb` (CI: see `os.yml`) fails.

## Tests that need no VM

```bash
os/packaging/dev/trixie.sh 'os/packaging/tests/run.sh && os/iso/tests/run.sh'   # macOS: via Docker
python3 -m unittest discover -s os/iso/smoke/tests -t os/iso/smoke -v
node --test os/iso/smoke/assets/
```

## CI

`.github/workflows/os.yml` (Linux only, path-filtered): `checks`,
`build-go`, `build-daemon`, `build-shell` (each uploads `debs-*`),
`build-iso` (privileged `debian:trixie`, uploads `jarvis-os-iso`),
`smoke-test` (QEMU with KVM when the runner exposes it, TCG otherwise; the
job summary says which), and `release` on `os-v*` tags (draft release).
