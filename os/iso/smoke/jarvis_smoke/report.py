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
        lines.append(f"| {r['name']} | {'BLOCKED' if r.get('blocked') else 'PASS' if r['ok'] else 'FAIL'} | {r['seconds']:.1f} s |")
    lines.append("")
    if ram is None:
        lines.append("Idle RAM: not measured")
    else:
        lines.append(
            f"Idle RAM: **{ram['used_mb']} MB** (target ≤ {ram['warn_mb']} MB, "
            f"ceiling {ram['fail_mb']} MB): {ram['verdict']}"
        )
    blocked = [r for r in results if r.get("blocked")]
    if blocked:
        lines += ["", f"**{len(blocked)} BLOCKED criteria are NOT verified (release blocker until the GIMP export is proven end to end):**", ""]
        lines += [f"- {r['name']}: {r['detail']}" for r in blocked]
    failed = [r for r in results if not r["ok"]]
    for r in failed:
        lines += ["", f"### {r['name']}", "", "```", r["detail"], "```"]
    return "\n".join(lines) + "\n"


def blocked(name: str, reason: str) -> dict:
    """A criterion that cannot run yet: recorded as not verified, never as a pass."""
    return {"name": name, "ok": True, "blocked": True, "seconds": 0.0, "detail": reason}


def exit_code(results: list[dict], fail_on_blocked: bool) -> int:
    """0 when everything passed; BLOCKED results fail the run only under CU_FAIL_ON_BLOCKED=1."""
    if not results or not all(r["ok"] for r in results):
        return 1
    return 1 if fail_on_blocked and any(r.get("blocked") for r in results) else 0
