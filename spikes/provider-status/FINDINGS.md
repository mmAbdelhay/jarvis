# Spike: can we read remaining capacity for a Claude account locally?

Date: 2026-08-31
Scope: read-only investigation. Nothing in `packages/` was touched. No credentials or tokens are reproduced below — only field names, shapes, and non-secret values (percentages, timestamps, plan tier).

## Verdict

**Yes — for Claude subscription (claude.ai / Pro/Max/Team) accounts, honestly, with a real number.**
Not for API-key/Bedrock/Vertex Claude accounts, and only partially for GitHub Copilot (in-session only, no standalone query). Public status pages work exactly as expected for all three providers.

## 1. Local config-directory state

Checked `~/.claude-acme/` and `~/.claude-main/` (read-only).

- `daemon-auth-status.json`, `.claude.json` via `claude auth status`: identity/plan info only (`loggedIn`, `email`, `orgId`, `subscriptionType: "max"`), no usage numbers.
- `stats-cache.json`: locally-accumulated token/cost counters per model (`inputTokens`, `costUSD`, etc.) since first use. This is the app's own historical usage ledger, **not** the account's plan ceiling — there's no field for the limit itself, so "remaining" can't be derived from it.
- `history.jsonl` (you) contains the user's own past slash-command entries `/rate-limit-options` (x3) and the prompt "wait till the usage limit reset and continue" — direct evidence of the real incident described in the task: the user hit a session limit and had to intervene.
- No credential/OAuth files were opened beyond confirming they exist (e.g. `.claude.json` is `600`-permissioned and holds session/auth material — not inspected further).

## 2. The CLI itself — the real find

`claude --version`: 2.1.251.

- `claude auth status` -> identity + plan tier only, no usage numbers.
- `claude --help` has no `usage`/`limits` subcommand, **but** the statusLine hook input JSON (found embedded as documentation strings in the native `claude` binary) includes:

```
"rate_limits": {             // Optional: Claude.ai subscription usage limits. Only present for subscribers after first API response.
  "five_hour": {              // Optional: 5-hour session limit (may be absent)
    "used_percentage": number,   // Percentage of limit used (0-100)
    "resets_at": number          // Unix epoch seconds when this window resets
  },
  "seven_day": { ... same shape ... }
}
```

  This sits in the exact same schema block as `context_window.used_percentage`, which the user's own working `~/.claude-acme/statusline-command.sh` and `~/.claude-main/statusline-command.sh` already consume live today — i.e. this is the same, already-proven delivery mechanism, just an unused field.
- The native binary also references real HTTP response headers the CLI parses from the Anthropic API: `anthropic-ratelimit-unified-status`, `anthropic-ratelimit-unified-reset`, `anthropic-ratelimit-unified-overage-status/-reset`, bucketed into `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` — confirming this data originates from a real, first-party API mechanism, not a guess.
- `claude doctor` — health check, no usage data.

## 3. The Agent SDK — empirically verified live

`@anthropic-ai/claude-agent-sdk@0.3.251` (dependency of `packages/platform`) exposes, on the `Query` object returned by `query()`:

```ts
getContextUsage(): Promise<SDKControlGetContextUsageResponse>
usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse>
```

`SDKControlGetUsageResponse` (from `sdk.d.ts`) includes:

```ts
subscription_type: string | null;       // 'pro' | 'max' | 'team' | 'enterprise' | null
rate_limits_available: boolean;         // false for API key / Bedrock / Vertex — no plan limits apply
rate_limits: {
  five_hour?: { utilization: number | null; resets_at: string | null } | null;
  seven_day?: { utilization: number | null; resets_at: string | null } | null;
  seven_day_opus?: {...} | null;
  seven_day_sonnet?: {...} | null;
  model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
  extra_usage?: { is_enabled: boolean; monthly_limit: number|null; used_credits: number|null; utilization: number|null } | null;
} | null;
```

The method name is **explicitly labeled `_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`** with a doc comment: "unstable and may change or be removed in any release without notice — do not rely on it yet. The method name will change when the API is stabilized." That caveat is load-bearing for the recommendation below.

**Live probe** (`spikes/provider-status/probe-usage.mjs`), run against the real `claude-acme` account (`CLAUDE_CONFIG_DIR=~/.claude-acme node probe-usage.mjs`), one real `maxTurns: 1` call:

```json
{
  "subscription_type": "max",
  "rate_limits_available": true,
  "rate_limits": {
    "five_hour":  { "utilization": 6,  "resets_at": "2026-08-31T14:30:00.473092+00:00" },
    "seven_day":  { "utilization": 33, "resets_at": "2026-09-02T11:00:00.473121+00:00" }
  }
}
```

This is a real number for a real account, fetched through a supported (if experimental) SDK call the app already depends on. `100 - utilization` = remaining %, `resets_at` = exact reset time.

Note: the app already handles the failure mode indirectly — `SDKAssistantMessageError` includes a `'rate_limit'` variant, which is what the phase-1 `claude-mm` interruption would have surfaced as.

## 4. Public status pages — confirmed

| Provider | Endpoint | Shape | Field to read |
|---|---|---|---|
| Anthropic/Claude | `https://status.claude.com/api/v2/status.json` (status.anthropic.com now 301-redirects here) | `{"page":{...},"status":{"indicator":..,"description":..}}` | `status.indicator` in `none\|minor\|major\|critical` |
| OpenAI | `https://status.openai.com/api/v2/status.json` | same Statuspage.io shape | `status.indicator` |
| GitHub | `https://www.githubstatus.com/api/v2/status.json` | same shape | `status.indicator` (was `minor` / "Partially Degraded Service" at fetch time) |

All three are the standard Atlassian Statuspage `/api/v2/status.json` shape — trivial to poll, no auth needed. (In this sandboxed environment, direct `curl` to `status.claude.com` was intercepted by a corporate web filter; `WebFetch` reached it fine and returned the real JSON above — a sandbox artifact worth re-checking on the target machine, not a finding about the endpoint itself.)

## 5. `copilot` CLI

`copilot --help` has `billing` and `limits` help topics (`copilot help billing`, `copilot help limits`):

- Copilot tracks usage as "AI credits" (or premium requests on legacy billing), shown live in the interactive footer, `/usage`, and `/statusline` (`quota` option) **inside a running session**.
- `--usage-output-file <file>` writes final usage stats as JSON, but only after a session completes.
- There is **no standalone `copilot usage` / `copilot quota` command** that reports account-wide remaining capacity without starting a session — this is the "only-partial" case for Copilot specifically.

## Answer to "can remaining capacity be read honestly?"

**Yes, for Claude subscription accounts** — a real percentage-used and a real reset timestamp, per account, per window (5-hour and 7-day), fetched from Anthropic's own API via a mechanism the CLI itself already uses for its statusline. Verified live against a real account, not inferred.

Caveats to carry into the design:
- The SDK method is explicitly experimental/unstable — the *name itself* is a warning. Treat it as best-effort, wrap in try/catch, and don't let its removal break the panel (fall back to "unknown" gracefully).
- Only applies to `claude.ai`-subscription auth (`rate_limits_available: false` for API-key/Bedrock/Vertex). All three of this user's `claude-*` wrapper accounts use `claude.ai` OAuth login per `daemon-auth-status.json`, so this covers all three in practice.
- Copilot has no equivalent standalone query — its "remaining" can only be shown after/during a session, or omitted with a note.

## Recommendation

Show, per Claude account: **`{100 - utilization}% capacity left (5h window), resets {resets_at}`** plus the 7-day figure, sourced from `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` on a short-lived SDK `query()` call per account (or by reading it opportunistically off a session already open for that account, avoiding an extra spend), with a visible "experimental Anthropic API — may stop working" caveat in code/comments, and a graceful fallback (last-known value, or "unavailable") if the call errors. For Copilot, don't invent a number — show status-page health only, plus (optionally) the last observed AI-credit usage from that account's most recent session if the app already captured it, explicitly labeled "as of last session" rather than "live." Status half (part a) is a straight poll of the three `/api/v2/status.json` endpoints above, keyed on `status.indicator`.

---

## CONTROLLER VERIFICATION (independent re-run) — verdict CONFIRMED, with three corrections

The verdict holds: remaining capacity **is** honestly readable for claude.ai OAuth accounts. Re-run live
against `claude-acme`, the numbers moved between the spike's run and mine (five_hour 6% -> 9%), which
is itself evidence they are live rather than cached or synthetic.

**Correction 1 — the field path in the spike's report is wrong.** The fields are NOT at the top level.
Actual shape:

    usage.rate_limits.five_hour  = { utilization: 9,  resets_at: "2026-08-31T14:30:00.405466+00:00", ... }
    usage.rate_limits.seven_day  = { utilization: 33, resets_at: "2026-09-02T11:00:00.405492+00:00", ... }

Reading `usage.five_hour` returns `undefined`, which is exactly what my first probe got. Anyone
implementing from the spike's report as written would have shipped a permanently-blank panel.

**Correction 2 — it must be called MID-STREAM, not after the result.** Calling it after breaking out of the
loop throws `ProcessTransport is not ready for writing`; calling it at the `result` message throws
`Query closed before response received`. It works when called at the first `assistant` message. This is a
real constraint on the design, not a detail.

**Correction 3 — and this is the one that shapes the feature: EVERY CAPACITY CHECK COSTS A REAL QUERY.**
My verification run reported `total_cost_usd: 0.0076955` and ~3.3s wall clock for a one-word prompt. There
is no free "just read the number" path — the figure arrives as a side effect of an actual API round trip.
Three accounts polled on a dashboard interval means three real queries every interval, billed and rate-limit-
consuming. A naive 30-second refresh would spend roughly $2/day doing nothing but asking how much is left,
and would itself consume the capacity it reports.

Design consequences to carry into the plan:
  - Do NOT poll on a timer per account. Cache aggressively; refresh on demand, at startup, and opportunistically
    after a real session runs (the orchestrator already opens sessions — piggyback there rather than paying
    for a dedicated probe).
  - `resets_at` is absolute, so a cached reading stays useful and can be displayed as "as of HH:MM".
  - The response also carries a large telemetry block (`behaviors`, per-model `model_usage`, `spend`,
    internal codenames). Read ONLY `rate_limits.five_hour` / `.seven_day` — do not surface or persist the rest.
  - The API name says DO NOT RELY ON THIS API YET. Treat absence, a throw, or a shape change as "unavailable"
    and degrade to showing nothing rather than guessing.
