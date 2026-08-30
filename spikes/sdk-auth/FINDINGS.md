# Task 1 spike: Agent SDK auth against a subscription

## Environment
- node v25.2.1, pnpm 10.28.2, npx 11.6.2
- `@anthropic-ai/claude-agent-sdk` 0.3.251 (installed fresh, no cached version)
- `~/.npmrc` has `ignore-scripts=true` (left untouched, as instructed)
- Ran with `CLAUDE_CONFIG_DIR=$HOME/.claude-main` (the "you" account's config dir, matching wrapper script `~/.local/bin/claude-mm`)
- `/opt/homebrew/bin/claude --version` returned `2.1.251 (Claude Code)` cleanly before the probe ran — the native-binary-stub bug (see brief context #3) did **not** occur during this spike, so no repair via `install.cjs` was needed.

## Step 1: scaffold + install

```
$ mkdir -p ~/projects/jarvis/spikes/sdk-auth
$ cd ~/projects/jarvis/spikes/sdk-auth
$ pnpm init
Wrote to /Users/you/projects/jarvis/spikes/sdk-auth/package.json
$ pnpm add @anthropic-ai/claude-agent-sdk
...
dependencies:
+ @anthropic-ai/claude-agent-sdk 0.3.251
Done in 34.4s using pnpm v10.28.2
```

Install succeeded despite the global `ignore-scripts=true` in `~/.npmrc`. `@anthropic-ai/claude-agent-sdk`'s `package.json` has no `scripts` block at all (no postinstall), so `ignore-scripts` never came into play for this package — nothing was skipped, nothing broke. This differs from the plain `@anthropic-ai/claude-code` CLI package, which *does* ship a postinstall step (that's the mechanism behind the recurring "native binary not installed" bug described in the task context) — the SDK package is not affected the same way.

`pnpm add -D tsx` (4.23.13) also installed cleanly with no script-related issues, so the brief's suggested `npx tsx` path worked as-is; no fallback to `tsc`/`.mjs` was required.

## Step 2: probe.ts

Written verbatim from the brief at `spikes/sdk-auth/probe.ts`.

## Step 3: run against the you subscription, no API key

Exact command:

```
$ cd ~/projects/jarvis/spikes/sdk-auth
$ env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR="$HOME/.claude-main" npx tsx probe.ts
```

Verbatim output (trimmed — full message JSON was truncated by the probe's own `.slice(0, 400)`, reproduced here as printed):

```
ANTHROPIC_API_KEY set: false
CLAUDE_CONFIG_DIR: /Users/you/.claude-main
MESSAGE: {"type":"system","subtype":"hook_started","hook_id":"bfabc764-c438-4e59-a20f-7d725fb53840","hook_name":"SessionStart:startup","hook_event":"SessionStart", ...}
MESSAGE: {"type":"system","subtype":"hook_started","hook_id":"b4f6e37d-aca7-44ca-aa9f-b2d2b1548cd2","hook_name":"SessionStart:startup","hook_event":"SessionStart", ...}
MESSAGE: {"type":"system","subtype":"hook_response", ... "output":"CAVEMAN MODE ACTIVE — level: full\n\n...", ...}
MESSAGE: {"type":"system","subtype":"hook_response", ... "output":"{\n  \"hookSpecificOutput\": {\n    \"hookEventName\": \"SessionStart\",\n    \"additionalContext\": \"<EXTREMELY_IMPORTANT>\\nYou have superpowers.\\n...", ...}
MESSAGE: {"type":"system","subtype":"init","cwd":"/Users/you/projects/jarvis/spikes/sdk-auth","session_id":"f530b174-107f-4f02-8b74-1e93b0c1cf44","tools":["Task","Bash","CronCreate", ...], ...}
MESSAGE: {"type":"assistant","message":{"model":"claude-opus-5","id":"msg_011CeZYFbEK41oXqM1m9u5dc",...,"content":[{"type":"text","text":"ok"}], ..., "usage":{"input_tokens":2,"cache_creation_input_tokens":17018,"cache_read_input_tokens":0, ...}
MESSAGE: {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788135000,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.51,"resetsAt":1788135000},"seven_day":{"utilization":0.09,"resetsAt":1788379200}}}, ...}
MESSAGE: {"duration_api_ms":1618,"stop_reason":"end_turn","session_id":"f530b174-107f-4f02-8b74-1e93b0c1cf44","total_cost_usd":0.17029,"usage":{"input_tokens":2,"cache_creation_input_tokens":17018,"cache_read_input_tokens":0,"output_tokens":4, ...}}
RESULT: SDK ran without an API key
```

The assistant's actual reply text was `"ok"` — the model complied with the "Reply with exactly the word: ok" prompt (a leading-hook-driven system prompt intercepted it into a caveman-styled agent session, but the literal answer was still "ok").

## Chosen path

**Path A**: the Agent SDK runs directly against the subscription. With `ANTHROPIC_API_KEY` explicitly unset and `CLAUDE_CONFIG_DIR` pointed at the `you` account's config directory (the same directory the `claude-mm` wrapper script uses), `query()` authenticated successfully, streamed a full session (hook events, init, assistant message, rate-limit event, result) and produced the expected `"ok"` reply — no `ANTHROPIC_API_KEY` was required. `rate_limit_event.rateLimitType: "five_hour"` and `overageDisabledReason: "org_level_disabled"` confirm this ran against the subscription's rate-limit pool, not a pay-per-token API key.

## Reasoning

The SDK reads and reuses the same on-disk OAuth/session credentials under `CLAUDE_CONFIG_DIR` that the `claude` CLI itself uses, so Task 5's orchestrator can call `@anthropic-ai/claude-agent-sdk`'s `query()` in-process per account (setting `CLAUDE_CONFIG_DIR` per call/subprocess env) instead of spawning the `claude-mm` / `claude-acme` / `claude-personal` wrapper CLIs as child processes — Path B (spawning wrapper CLIs) is not required, though it remains a viable fallback if a future SDK version changes this behavior.

## Surprises

1. **No native-binary-stub bug hit.** The task context flagged that `claude` breaks roughly hourly due to the blocked postinstall on `@anthropic-ai/claude-code`. That package was not touched by this spike (only `@anthropic-ai/claude-agent-sdk`, which has no postinstall script at all), and `claude --version` worked cleanly throughout, so `install.cjs` repair was never invoked.
2. **The probe session inherited this machine's local Claude Code project hooks/skills** (`SessionStart` hooks fired "CAVEMAN MODE ACTIVE" and injected the `superpowers:using-superpowers` skill content as `additionalContext`) even though the probe ran from `spikes/sdk-auth` with only `CLAUDE_CONFIG_DIR` overridden. This means `CLAUDE_CONFIG_DIR` controls *account credentials*, not project-level hook/skill configuration — Task 5 should account for this when running per-account sessions non-interactively (hook side effects, e.g. caveman-mode system-prompt injection, can leak into headless orchestrator sessions unless hooks are disabled or the probe/orchestrator's cwd/settings are isolated from this repo's `.claude` config).
3. **`total_cost_usd: 0.17029` was still reported** in the result message even though this ran against a subscription with no API key — the SDK computes/reports a notional cost figure regardless of whether the underlying account is metered per-token or a flat subscription. This is a display/telemetry value in the SDK's result payload, not evidence of an actual charge; the `rate_limit_event` fields (`rateLimitType: "five_hour"`, `overageDisabledReason: "org_level_disabled"`) are the more reliable signal that this consumed subscription-plan quota rather than pay-per-token API credit.
4. **The model that answered was `claude-opus-5`**, not a Sonnet/Haiku default — worth noting for Task 5 if the orchestrator wants to control model selection per query rather than relying on the account's default.
