"""Markdown summary for the GitHub job summary and the results artifact."""

from __future__ import annotations


def render_summary(results: list[dict], ram: dict | None, accel: str, title: str = "Smoke tests") -> str:
    lines = [
        f"## {title} ({accel})",
        "",
        "| Check | Result | Time |",
        "|---|---|---|",
    ]
    for r in results:
        lines.append(f"| {r['name']} | {'PASS' if r['ok'] else 'FAIL'} | {r['seconds']:.1f} s |")
    lines.append("")
    if ram is None:
        lines.append("Idle RAM: not measured")
    else:
        lines.append(
            f"Idle RAM: **{ram['used_mb']} MB** (target ≤ {ram['warn_mb']} MB, "
            f"ceiling {ram['fail_mb']} MB): {ram['verdict']}"
        )
    failed = [r for r in results if not r["ok"]]
    for r in failed:
        lines += ["", f"### {r['name']}", "", "```", r["detail"], "```"]
    return "\n".join(lines) + "\n"
