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

## Contract gap (open) — proposed gap 13 for the plan's "Contract gaps" list

The plan file is gitignored and is not edited by task agents, so the
coordinator should copy this entry into that list as item 13:

> 13. **GTK4 password fields are not detected (§4 safety hole).** On trixie,
> GTK4 password entries expose `ATSPI_ROLE_TEXT` (61), not
> `ATSPI_ROLE_PASSWORD_TEXT` (40), with no distinguishing state or attribute.
> `guard.PasswordWatch` never sees a password field, so `type`, `key`,
> `click`, `scroll` and `drag` are all allowed there. Password refusal is
> proven by unit tests only until a different detection signal exists, and
> `--- PASS: TestComputerUseAgainstLabwc` is blocked on it.

Details:
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
