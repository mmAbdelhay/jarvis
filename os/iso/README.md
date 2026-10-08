# Rafiq ISO (live + installer)

Debian 13 (trixie) amd64 live ISO that boots into the live session and carries
the Rafiq installer. UEFI only: there is no BIOS entry and no syslinux. Secure
Boot works through Debian's signed `shim-signed`, `grub-efi-amd64-signed` and
signed kernel; we ship no kernel modules. The live root is the future installed
system; behaviour that exists only in the live session comes from
`config/includes.chroot/usr/lib/live/config/2000-jarvis-live-session` and the
live autostart. "Rafiq" is the system, "Jarvis" is the assistant.

| Path | What |
|---|---|
| `bootappend` | The live kernel command line (boot menu and test harnesses read it) |
| `auto/`, `config/` | live-build configuration: package lists, hooks, session files |
| `build.sh` | Debs -> ISO. Root, Debian trixie only |
| `scripts/` | Boot timeouts, release guard, chroot and ISO checks |
| `dev/` | Stub debs and the Docker build wrapper |
| `smoke/` | QEMU smoke tests and the Secure Boot install tests |
| `../packaging/` | The `.deb`s |
| `../branding/`, `../repo/`, `../models/` | Branding, APT repository, model catalog (own READMEs) |

## Get an ISO

**From CI (recommended, especially on Apple Silicon).** Every run of the `OS`
workflow uploads the artifact `os-iso`, containing `rafiq-<version>-amd64.iso`:

```bash
gh run list --workflow os.yml --limit 5
gh run download <run-id> --name os-iso --dir ~/Downloads/rafiq
```

**Build locally (amd64 Linux with Docker).**

```bash
# Stub packages for E/F/G, real H packages built with a throwaway key:
os/iso/dev/build-in-docker.sh /tmp/rafiq-iso
# Or with your own debs:
os/iso/dev/build-in-docker.sh /tmp/rafiq-iso /path/to/debs
```

The ISO lands in `/tmp/rafiq-iso/dist/`. `/tmp/rafiq-iso/lb-cache` keeps
downloaded packages between builds. On Apple Silicon this runs under amd64
emulation in Docker Desktop and takes hours; use the CI artifact.

## Run it on a Mac (Apple Silicon)

Apple Silicon cannot virtualize amd64, so the ISO runs emulated (QEMU TCG):
fine for looking at the UI, slow for installs.

**UTM** (`brew install --cask utm`): New Virtual Machine -> **Emulate** ->
Linux -> Boot ISO Image. Architecture x86_64, system "Standard PC (Q35 +
ICH9)", 4096 MB, 4 cores. The VM must use **UEFI**: the ISO has no BIOS menu
any more, so a BIOS VM shows nothing bootable. Display `virtio-vga`.

**QEMU directly** (`brew install qemu`):

```bash
qemu-system-x86_64 -machine q35 -accel tcg,thread=multi -cpu max -smp 4 -m 4096 \
  -drive if=pflash,format=raw,readonly=on,file="$(brew --prefix qemu)/share/qemu/edk2-x86_64-code.fd" \
  -cdrom ~/Downloads/rafiq/rafiq-*.iso \
  -device virtio-vga -display cocoa -nic user,model=virtio-net-pci
```

For Secure Boot firmware on the Mac use
`$(brew --prefix qemu)/share/qemu/edk2-x86_64-secure-code.fd`. Note that brew's
variable store has no Microsoft keys, so the guest still boots with Secure Boot
**off** on a Mac. Secure Boot is tested in CI with Debian's
`OVMF_VARS_4M.ms.fd`.

## Smoke tests

```bash
# Linux with KVM (CI does this):
sudo apt-get install qemu-system-x86 xorriso
python3 os/iso/smoke/run_smoke.py --iso dist/rafiq-*.iso --out /tmp/smoke

# macOS (TCG; every timeout is multiplied by 4, allow 30-45 minutes):
python3 os/iso/smoke/run_smoke.py --iso ~/Downloads/rafiq/rafiq-*.iso --out /tmp/smoke --accel tcg
```

The harness boots the ISO's own kernel and boot line plus
`console=ttyS0 systemd.debug_shell=ttyS0` for a root shell on the serial port,
and switches on the fake provider only in that boot, from a read-only assets
disk; `scripts/release-guard.sh` fails the build if the image could enable it.
Results: `summary.md`, `results.json`, `serial.log`, `diagnostics.txt`,
`screen.png`.

## Install tests

`os/iso/smoke/run_install.py` boots the ISO through OVMF with Secure Boot and
Microsoft keys, drives the installer backend over D-Bus (`installctl.mjs`) and
types the disk passphrase and greeter password with QMP send-key. Three
scenarios:

| Scenario | What it proves |
|---|---|
| `erase` | Erase + encrypt install: Secure Boot stays enabled, root is on the unlocked LUKS device, os-release is the brand, live-only packages are gone, the greeter (not autologin) runs, ollama listens on 127.0.0.1:11434 only, the APT source and archive keyring are installed, secrets never reach the installer log, and a wrong passphrase does not give a shell. With `--update-repo` it also checks updates from a local signed test repo. |
| `alongside` | Install next to a Windows (NTFS) disk: Windows partitions only shrink (their start never moves), both systems stay bootable, GRUB shows its 3 s menu because another OS is found. |
| `refusals` | The backend refuses unsafe requests (too-small disk, bad layouts) and leaves the disk untouched. |

```bash
sudo apt-get install qemu-system-x86 ovmf xorriso gdisk ntfs-3g dosfstools mtools
for s in refusals erase alongside; do
  python3 os/iso/smoke/run_install.py --iso dist/rafiq-*.iso --out /tmp/inst-$s --scenario $s --work /mnt || echo "FAILED $s"
done
```

They need **KVM** (`--allow-tcg` exists for debugging only); run them in CI
from the Mac. The root shell on ttyS0 comes from a systemd credential that QEMU
hands over via SMBIOS; nothing in the image enables it. CI uploads
`install-<scenario>` artifacts with `*-serial.log`, `*-qemu.log` and `*.ppm`
screen dumps (open the `.ppm` files with Preview):

```bash
gh run download <run-id> --pattern 'install-*'
```

Typical first failures: no shell on ttyS0 (check `serial.log`), prompt never
found (open `target-prompt.ppm`; the Plymouth theme changed, see
`os/branding/README.md`), target drops to a GRUB prompt (installer bootloader
id).

## Tests that need no VM

```bash
os/packaging/dev/trixie.sh 'os/packaging/tests/run.sh && os/iso/tests/run.sh'   # macOS: via Docker
TRIXIE_PACKAGES="cmake gcc libc6-dev gpg gpgv reprepro git zstd librsvg2-bin grub-common fonts-ibm-plex xorriso python3-yaml" \
  os/packaging/dev/trixie.sh 'os/branding/tests/run.sh && os/repo/tests/run.sh'
python3 os/branding/tools/name-lint.py
python3 -m unittest discover -s os/models/tests -v
python3 -m unittest discover -s os/models/tools/tests -v
python3 -m unittest discover -s os/iso/smoke/tests -t os/iso/smoke -v
node --test os/iso/smoke/assets/
```

## CI

`.github/workflows/os.yml` (Linux only, path-filtered) jobs: `checks`
(shellcheck, lints), `build-go`, `build-daemon`, `build-qt`, `build-distro`
(the H packages), `build-iso` (privileged `debian:trixie`, uploads `os-iso`),
`smoke-test` (QEMU, KVM when available), `install-test` (matrix over the three
scenarios, KVM required), `repo` (publishes the APT repository) and `release`
on `os-v*` tags (draft release; the tag `X.Y` must equal `DISTRO_VERSION`).

Without the secrets `JARVIS_APT_SIGNING_KEY` / `JARVIS_APT_DEPLOY_KEY` the
`repo` job is skipped with a `::warning::`, tests use a throwaway key
generated in CI (uid contains `NOT FOR RELEASE`), and `os-v*` release builds
refuse a throwaway keyring. Key setup and rotation: `os/repo/README.md`. The
model catalog has its own workflow, `os-models.yml` (`os/models/README.md`).
