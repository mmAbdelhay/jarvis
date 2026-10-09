# Headless labwc verification

Task 16, Step 4 was run on the owner's Linux box (docker `--context default`,
debian:trixie, labwc under `WLR_BACKENDS=headless`, build artifacts under
`~/rafiq-build/v11/cu-e2e`) via `os/go/ci/cu-headless.sh`.

Result: 9 of 10 subtests PASS on a real compositor, including the 200 ms
physical-input pause, terminal-focus blanking, lock end and disconnect
restore. `--- PASS: TestComputerUseAgainstLabwc` is NOT yet reached.

## Verified
- wev matchers `button: 272`, `utf8: 'م'`, `sym: s ` are correct for trixie's
  wev. wev block-buffers stdout on a pipe, so the test starts it through
  `stdbuf -oL`; without that its output stays empty.

## Contract gap (open)
`password_field_refuses_all_input` FAILS: trixie GTK4 `zenity --password`
exposes its entry over AT-SPI as `ATSPI_ROLE_TEXT` (61), not
`ATSPI_ROLE_PASSWORD_TEXT` (40) (states: editable, focusable, showing; no
distinguishing attribute; interfaces Text/EditableText). `guard.PasswordWatch`
therefore never reports a password field, and typing is not refused.
The assertion is intentionally NOT loosened: contracts §4 requires all input
to be refused in a password field. Toolkits that report role 40 (GTK3, Qt)
are covered by unit tests only. The coordinator must decide how to close the
GTK4 gap (for example a different detection signal) before the password
safety claim counts as proven on a real compositor.
