# Headless labwc verification

Run with `os/go/ci/cu-headless.sh` (build with `--build-only` on a dev Mac,
run with `--run-only` on a Linux box or in CI): debian:trixie, labwc 0.8.3
under `WLR_BACKENDS=headless`, the real jarvis-cu binary and this test.

Last run (v1.1 final review, owner's Linux box, docker `--context default`,
artifacts under `~/rafiq-build/v11/final/cu-e2e`):
`--- PASS: TestComputerUseAgainstLabwc`, all 11 subtests, including the
200 ms physical-input pause, terminal-focus blanking and pause, the GTK4
password field, the dialog contract, the lock end and the disconnect
restore.

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
