# Headless labwc verification

Run with `os/go/ci/cu-headless.sh` (build with `--build-only` on a dev Mac,
run with `--run-only` on a Linux box or in CI): debian:trixie, labwc 0.8.3
under `WLR_BACKENDS=headless`, the real jarvis-cu binary and this test.

Last run (v1.1 final review, owner's Linux box, docker `--context default`,
artifacts under `~/rafiq-build/v11/final/cu-e2e`):
`--- PASS: TestComputerUseAgainstLabwc`, all 12 subtests, three runs in a
row, including the 200 ms physical-input pause, terminal-focus blanking
and pause, the GTK4 password field, the dialog contract, typing into a GTK4
app (zenity --entry), the lock end and the disconnect restore.

## Notes
- wev matchers `button: 272`, `utf8: 'م'`, `sym: s ` are correct for trixie's
  wev. wev block-buffers stdout on a pipe, so the test starts it through
  `stdbuf -oL`; without that its output stays empty.
- The terminal-focus subtest found a deadlock: FocusChanged ran a Wayland
  round trip on the read goroutine, and jarvis-cu exited on the first
  window change of a session. FocusChanged now reads `wlcu.Client.Current()`.
- The dialog subtest opens a second zenity window of the allowed app: keys
  are refused (`outside`) until a capture has raised it and made it the
  fullscreen base, then they go to it.
- The password subtest failed about one run in three: GTK4 sent its focus
  event late and the watch answered "no password" for an unknown focus. It
  now walks the accessibility tree again whenever the focus it knows is
  missing or stale (and refuses keys if the walk fails).

## Real GIMP 3.0.4 (`CU_E2E_GIMP=1`, gimp_test.go)

- A fixed-size window made fullscreen (GIMP's Welcome dialog, 695x613) does
  not cover the output: labwc 0.8.3 shows whatever is behind it. Captures
  now keep only the base's own area, measured through AT-SPI (frame
  extents); a base that focus moved to and that cannot be measured is
  blanked and refuses input. Verified with the Welcome dialog: only the
  dialog shows, the rest is black.
- The smoke assets' `gimprc` had `(single-window-mode yes)`, which GIMP 3
  rejects as a fatal parse error, so the whole file was ignored and the
  Welcome dialog opened (it then took focus and became the base).
- Fullscreen hides a GTK dialog's client-side header bar, and GIMP 3's
  Export Image dialog keeps its Name field and its Cancel/Export buttons
  there (seen in CU_DUMP_DIR frames). jarvis-cu now raises a dialog over the
  fullscreen image window instead of making it fullscreen. "Export Image as
  PNG" belongs to the file-png plug-in program (Wayland app id `file-png`),
  which jarvis-cu counts as GIMP. With both, the container tier
  (os/iso/cu) exports Pictures/beach.png mouse only.
- OPEN: under headless labwc no GTK3 app receives virtual-keyboard input.
  GIMP gets `wl_keyboard.enter`, the keymap and the keys (WAYLAND_DEBUG) but
  shortcuts, Escape on an open menu and typing do nothing; `yad --entry`
  (GTK3) stays empty both with jarvis-cu and with `wtype`, while GTK4
  zenity works. jarvis-cu now creates its virtual devices at start and
  gives letters a capital level (neither fixed it). Whether a session with a
  real keyboard (KVM, hardware) behaves the same is not yet known; until it
  is, keyboard steps in GIMP are unproven (the scripted export uses the
  mouse only). Reproduce with
  `CU_E2E_GTK3=1` (yad subtest) or `CU_E2E_GIMP=1`.

## GTK4 password fields (was proposed contract gap 13)

Trixie's GTK4 `zenity --password` (zenity 4.1.90) exposes its entry as
`ATSPI_ROLE_TEXT` (61), not `ATSPI_ROLE_PASSWORD_TEXT` (40), with no name,
no distinguishing state or attribute, and a sibling label `Password:`
(probed with pyatspi in the same container). `guard.PasswordWatch` now also
treats a focused text or entry as a password field when its name, its
labelled-by labels or one of the two labels just before it contains a
password word (password, passphrase, passcode, PIN; كلمة المرور, كلمة السر,
رمز المرور, الرقم السري). A GTK4 hidden-text entry with no such label is
still not detected; `docs/os/threat-model.md` records it as an accepted risk.
