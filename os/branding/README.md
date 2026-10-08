# Rafiq branding

Everything visual and every public name of the distro lives here and is
packaged as `jarvis-branding`. "Rafiq" names the system, "Jarvis" names the
assistant; package, theme and path names (`jarvis-*`, Plymouth theme `jarvis`,
`/usr/share/grub/themes/jarvis/`) do not change with the distro name.

## brand.env is the only place the name lives

`brand.env` holds exactly `DISTRO_NAME`, `DISTRO_ID`, `DISTRO_VERSION`,
`ISO_VOLUME` and `HOME_URL` (contracts section 9). `PRETTY_NAME` is derived as
`"$DISTRO_NAME $DISTRO_VERSION (trixie)"`. `lib/brand.sh` refuses any other
line.

**To rename:** edit `brand.env`, then run `os/branding/tests/run.sh` and
`python3 os/branding/tools/name-lint.py`. Nothing else. The lint fails if any
H-owned file other than comments, Markdown, tests and `docs/superpowers/`
mentions the current or the retired name. The tests pin the section 9 values on
purpose, so update them together with a deliberate rename.

## What `render.sh` produces

`render.sh OUT_ROOT` renders every asset at its install path (needs
`rsvg-convert`, `grub-mkfont` and a font):

| Output | Installed by `jarvis-branding` at |
|---|---|
| ring logo SVG | `/usr/share/pixmaps/jarvis.svg`, hicolor icons (SVG + 16..512 px PNG) |
| wordmark | `/usr/share/pixmaps/jarvis-wordmark.svg` |
| wallpapers (SVG, 3840x2160, 1920x1080) | `/usr/share/backgrounds/jarvis/` |
| Plymouth theme `jarvis` | `/usr/share/plymouth/themes/jarvis/` |
| GRUB theme + fonts | `/usr/share/grub/themes/jarvis/` |
| GRUB defaults, `42_jarvis_timeout` | `/etc/default/grub.d/jarvis.cfg`, `/etc/grub.d/` |
| os-release | `/usr/lib/os-release` (`NAME="Rafiq"`, `ID=rafiq`, `ID_LIKE=debian`) |

GRUB shows a 3 s menu when another OS is found and is hidden otherwise.

## Plymouth pixel contract

The LUKS passphrase prompt is the Plymouth theme `jarvis`. The install tests
(`os/iso/smoke/jarvis_smoke/screen.py`) find the prompt on a screen dump by the
exact border colour of `entry.png` (`#4FD8C4`, 480x48, 2 px border, from
`plymouth/entry.svg`) and count `bullet.png` pixels (`#E7EAEE`, 12x12, from
`plymouth/bullet.svg`) inside it. Both images must be drawn unscaled, as
`jarvis.script.in` does. If you change the colours or sizes, change
`screen.py` and its tests in the same commit.
