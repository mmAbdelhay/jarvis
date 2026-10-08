"""Install test 5 (design §13, criteria 9-10): a newer jarvis-shell in a local
repo signed with the archive key → "update my computer" → one card → upgrade,
nothing removed; a repo signed by another key is refused by apt."""
from __future__ import annotations

import functools
import http.server
import json
import threading
from pathlib import Path

from jarvis_smoke import scenarios
from jarvis_smoke import install_flow as flow

PORT = 8098
SOURCES = "/etc/apt/sources.list.d/jarvis.sources"


def point_at_good() -> str:
    # The package ships the source "Enabled: no" until the public repo exists.
    return (f"sed -i -e 's#^URIs: .*#URIs: http://10.0.2.2:{PORT}/good#' "
            f"-e 's/^Enabled: .*/Enabled: yes/' {SOURCES}")


def rogue_source() -> str:
    text = (f"Types: deb\\nURIs: http://10.0.2.2:{PORT}/rogue\\nSuites: trixie\\nComponents: main\\n"
            "Signed-By: /usr/share/keyrings/jarvis-archive-keyring.gpg\\n")
    return f"printf '{text}' > /etc/apt/sources.list.d/rogue.sources"


def cards(jsonl: str) -> list[dict]:
    out = []
    for line in jsonl.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") == "card":
            out.append(event["card"])
    return out


def serve(site: Path) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site))
    handler.log_message = lambda *a, **k: None  # type: ignore[attr-defined]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def run_updates(run, m, site: Path) -> None:
    sh = run.sh
    server = serve(site)
    try:
        def signed_ok():
            sh(point_at_good())
            out = sh("apt-get update 2>&1", 300)
            bad = [l for l in out.splitlines() if l.startswith(("W:", "E:")) and "10.0.2.2" in l]
            assert not bad, "\n".join(bad)

        run.check("criterion 10: apt verifies the Jarvis repo with jarvis-archive-keyring", signed_ok)

        def rogue_refused():
            sh(rogue_source())
            status, out = m.serial.run("apt-get update 2>&1", 300 * run.factor)
            sh("rm -f /etc/apt/sources.list.d/rogue.sources")
            assert "10.0.2.2:8098/rogue" in out and any(
                k in out for k in ("NO_PUBKEY", "not signed", "Missing key", "signature")), out[-1500:]

        run.check("criterion 10: a repo signed by another key is refused", rogue_refused)
        sh("apt-get update >/dev/null 2>&1 || true", 300)

        uid = int(sh(f"id -u {flow.USER}").strip())
        old = sh("dpkg-query -W -f='${Version}' jarvis-shell").strip()

        def update_my_computer():
            sh(scenarios.use_fake_provider(uid, "update-computer.json", user=flow.USER), 150)
            out = sh(scenarios.jarvisctl(uid, "prompt --text 'update my computer' --approve-all --timeout 900", user=flow.USER), 960)
            found = cards(out)
            assert len(found) == 1, f"expected one card, got {len(found)}"
            assert "jarvis-shell" in json.dumps(found[0]), found[0]
            new = sh("dpkg-query -W -f='${Version}' jarvis-shell").strip()
            assert new == f"{old}+update1", f"jarvis-shell {old} -> {new}"
            last = sh("awk 'BEGIN{RS=\"\"} END{print}' /var/log/apt/history.log")
            assert "Upgrade: jarvis-shell" in last and "Remove:" not in last, last
            return f"jarvis-shell {old} -> {new}"

        run.check("criterion 9: update my computer → one card → upgrade, nothing removed", update_my_computer)
    finally:
        server.shutdown()
