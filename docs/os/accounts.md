# Sign in with an account (Plan Y)

Jarvis can think with your own Claude (Pro/Max), ChatGPT (Plus/Pro), Google
(Gemini) or GitHub Copilot plan. It installs the vendor's official command-line
program for you (per user, no root), runs that program's own sign-in, and then
drives it in the background with every switchable built-in tool turned off.
ChatGPT/Codex retains `apply_patch` and its plan tool in the pinned version:
owner ruling G2 allows it only with `-s read-only`, approvals never, all
switchable features disabled, the outer sandbox and the non-message tripwire.
Only Claude accounts are vision-capable in v1.1 (owner ruling G7/G8).

## How it works

- Programs: `~/.local/share/jarvis/clis/<account>` (pinned versions from
  `/usr/share/jarvis/accounts/accounts.json`, integrity- and signature-checked).
- Sign-in: `~/.config/jarvis/accounts/<account>` (0700). Jarvis never sees your
  password and never copies the token.
- Every run is a `systemd-run --user` service that hides home and runtime directories with `ProtectHome=tmpfs`,
  binding back its account and temp folders read-write and its program read-only; see the threat model, M45–M50 and R17–R19.

## Live tests (owner, Linux box, one per account)

Each run installs the pinned CLI, signs in (you finish in the browser), checks
the tools-off canary, the text tool protocol and every pinned model id.

```bash
ssh abdelhay@100.80.112.32
cd ~/src/rafiq-v11-y && git pull && pnpm install --frozen-lockfile && pnpm exec tsc -b
JARVIS_LIVE_ACCOUNT=claude  pnpm exec vitest run packages/desktop/src/daemon/os/accounts/accounts.live.test.ts
JARVIS_LIVE_ACCOUNT=chatgpt pnpm exec vitest run packages/desktop/src/daemon/os/accounts/accounts.live.test.ts
JARVIS_LIVE_ACCOUNT=gemini  pnpm exec vitest run packages/desktop/src/daemon/os/accounts/accounts.live.test.ts
JARVIS_LIVE_ACCOUNT=copilot pnpm exec vitest run packages/desktop/src/daemon/os/accounts/accounts.live.test.ts
```
Add `JARVIS_LIVE_RECORD=1` to save the raw streams under
`packages/platform/src/model/accounts/__fixtures__/live/` and compare them with
the hand-written fixtures; update the fixtures (never the parsers' tripwire)
if a field moved. Add `JARVIS_LIVE_KEEP=1` to stay signed in afterwards.

## Re-pinning a CLI

1. `python3 os/models/tools/accounts_pin.py <account> <version> --write`
   (refuses versions younger than 7 days).
2. For Codex: `codex features list` at the new version — every enabled
   tool-like feature must be in `CODEX_DISABLED_FEATURES`
   (`packages/platform/src/model/accounts/specs.ts`).
3. Run that account's live test; it must pass, including the canary.

## Troubleshooting

- "needs the user sandbox": `systemd-run --user -p ProtectHome=tmpfs -p PrivateTmp=yes --pipe true` must work for the user.
- "tried to use its own tools": a CLI update re-enabled a tool. Keep the old pin and report it.
- Copilot: after signing out, also remove "GitHub Copilot CLI" at
  https://github.com/settings/applications.
- Gemini: after signing out, also revoke the grant at
  https://myaccount.google.com/permissions. Deleting local sign-in files does
  not revoke either vendor grant.
