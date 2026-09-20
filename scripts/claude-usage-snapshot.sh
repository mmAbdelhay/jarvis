#!/bin/sh
# Claude Code status-line hook that saves the account's real usage figures
# where Jarvis reads them — for free.
#
# Claude Code hands its status line a JSON document on stdin on every render,
# and that document carries the account's rate limits (`rate_limits.five_hour`
# and `seven_day`: `used_percentage` + `resets_at`). Nothing else exposes those
# figures without spending a billed query, so this script writes them to
#
#     <config dir>/usage/rate-limits.json
#
# and prints a one-line status. Jarvis's Providers panel reads that file for
# each account's LEFT meter (packages/platform/src/capacity-snapshot.ts).
#
# Install (per account — each `.claude-*` config dir has its own settings.json):
#
#     "statusLine": { "type": "command", "command": "sh /path/to/scripts/claude-usage-snapshot.sh" }
#
# Already have a status line? Keep it, and add near its top:
#
#     input=$(cat); printf '%s' "$input" | sh /path/to/scripts/claude-usage-snapshot.sh >/dev/null
#
# Needs only `node` (Jarvis needs it anyway). Every failure is swallowed: a
# broken snapshot must never break the status line itself. The file is
# written to a temp name and renamed, so a reader never sees half a file.

config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
input=$(cat)

js=$(cat <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const snapDir = path.join(process.env.JARVIS_CONFIG_DIR, "usage");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let doc = {};
  try { doc = JSON.parse(input); } catch { doc = {}; }
  const limits = (doc && doc.rate_limits) || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const win = (w) => (w && typeof w === "object" ? w : {});
  const fh = win(limits.five_hour);
  const sd = win(limits.seven_day);
  const snapshot = {
    five_hour_pct: num(fh.used_percentage),
    five_hour_resets_at: num(fh.resets_at),
    seven_day_pct: num(sd.used_percentage),
    seven_day_resets_at: num(sd.resets_at),
    updated_at: Math.floor(Date.now() / 1000),
  };
  if (snapshot.five_hour_pct !== null || snapshot.seven_day_pct !== null) {
    try {
      fs.mkdirSync(snapDir, { recursive: true });
      const tmp = path.join(snapDir, `rate-limits.json.tmp.${process.pid}`);
      fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
      fs.renameSync(tmp, path.join(snapDir, "rate-limits.json"));
    } catch {}
  }
  const model = (doc && doc.model && doc.model.display_name) || "";
  const pct = (v) => (v === null ? "?" : `${v}%`);
  process.stdout.write(
    `${model ? `${model} · ` : ""}session ${pct(snapshot.five_hour_pct)} · week ${pct(snapshot.seven_day_pct)}\n`,
  );
});
EOF
)

printf '%s' "$input" | JARVIS_CONFIG_DIR="$config_dir" node -e "$js" 2>/dev/null || true
