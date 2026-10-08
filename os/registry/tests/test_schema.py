"""Registry entries and index (M2.5 contracts §3): shape and trust-tier rules."""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import schema  # noqa: E402


def official(id_="jarvis-clock", channel="stable", version="0.1.0"):
    tools, network = schema.OFFICIAL[id_]
    return {"id": id_, "name": id_.split("-")[1].title(), "description": "Official Jarvis server.",
            "tier": "official", "version": version,
            "artifact": {"url": schema.official_url(channel, id_, version), "sha256": "a" * 64, "runtime": "go-static"},
            "permissions": {"network": network, "paths": []},
            "tools": [{"name": n, "risk": r} for n, r in tools.items()]}


def third(tier="community", id_="acme-notes"):
    return {"id": id_, "name": "Acme notes", "description": "Search and write notes in ~/Notes.",
            "tier": tier, "version": "1.2.3",
            "artifact": {"url": "https://example.org/acme-notes-1.2.3.tar.gz", "sha256": "b" * 64, "runtime": "node"},
            "permissions": {"network": False, "paths": ["~/Notes"]},
            "tools": [{"name": "notes.search", "risk": "safe"}, {"name": "notes.write", "risk": "confirm"}]}


def index(*entries):
    return {"version": 1, "generatedAt": "2026-10-09T12:00:00Z", "validUntil": "2026-10-23T12:00:00Z", "entries": sorted(entries, key=lambda e: e["id"])}


class EntryTest(unittest.TestCase):
    def assert_bad(self, e, needle, **kw):
        problems = schema.validate_entry(e, **kw)
        self.assertTrue(any(needle in p for p in problems), f"{needle!r} not in {problems}")

    def test_good_entries(self):
        for e in (official("jarvis-clock"), official("jarvis-web"), official("jarvis-files", "testing"),
                  third("reviewed"), third("community")):
            self.assertEqual(schema.validate_entry(e), [], e["id"])

    def test_helpers(self):
        self.assertEqual(schema.artifact_name("jarvis-web", "0.1.0"), "jarvis-web-0.1.0-linux-amd64.tar.gz")
        self.assertEqual(schema.official_url("stable", "jarvis-web", "0.1.0"),
                         "https://mmabdelhay.github.io/jarvis-apt/registry/artifacts/jarvis-web/0.1.0/"
                         "jarvis-web-0.1.0-linux-amd64.tar.gz")
        self.assertIn("/registry-testing/artifacts/", schema.official_url("testing", "jarvis-web", "0.1.0"))

    def test_shape(self):
        e = third(); e["extra"] = 1; self.assert_bad(e, "keys")
        e = third(); del e["tools"]; self.assert_bad(e, "keys")
        e = third(); e["artifact"]["url"] = "http://example.org/x.tgz"; self.assert_bad(e, "https")
        e = third(); e["artifact"]["sha256"] = "B" * 64; self.assert_bad(e, "sha256")
        e = third(); e["artifact"]["runtime"] = "ruby"; self.assert_bad(e, "runtime")
        e = third(); e["version"] = "1.0"; self.assert_bad(e, "MAJOR.MINOR.PATCH")
        e = third(); e["tools"][0]["risk"] = "password"; self.assert_bad(e, "safe or confirm")
        e = third(); e["tools"].append(copy.deepcopy(e["tools"][0])); self.assert_bad(e, "duplicate tool")
        e = third(); e["tools"] = []; self.assert_bad(e, "tools")
        e = third(); e["name"] = "bad\nname"; self.assert_bad(e, "name")
        e = third(); e["id"] = "Acme_Notes"; self.assert_bad(e, "id")
        e = third(); e["permissions"]["network"] = "no"; self.assert_bad(e, "network")

    def test_protected_paths_refused(self):
        for path in ("~/.config/jarvis", "~/.config/jarvis/mcp.d", "~/.config", "~/.local/share/jarvis/mcp",
                     "~/.local", "~/.ssh", "~/.gnupg/private-keys-v1.d", "~/.bashrc", "~/.config/systemd/user",
                     "~/.config/autostart", "~/.local/share/keyrings", "~/.local/bin"):
            e = third(); e["permissions"]["paths"] = [path]
            self.assert_bad(e, "protected")
        for path in ("/etc", "~", "~/", "~/../etc", "~/Notes/../.ssh", "~/./x", "~//x", "Notes", "~/a\nb", "~/.cache", "~/Notes/.hidden", "~/.mozilla", "~/.local/share",
                     "~/Documents/Notes Archive", "~/x /etc", "~/a %h", "~/a%h", '~/a "b"', "~/a'b", "~/a\\b", "~/caf\u00e9", "~/-x"):
            e = third(); e["permissions"]["paths"] = [path]
            self.assertNotEqual(schema.validate_entry(e), [], path)
        e = third(); e["permissions"]["paths"] = ["~/Notes", "~/Documents/Notes-Archive_2.d"]
        self.assertEqual(schema.validate_entry(e), [])
        e = third(); e["permissions"]["paths"] = [f"~/d{i}" for i in range(9)]
        self.assert_bad(e, "at most 8")

    def test_only_contract_servers_are_official(self):
        e = third(); e["tier"] = "official"; self.assert_bad(e, "may be official")
        e = official(); e["tools"].append({"name": "clock.alarm", "risk": "safe"}); self.assert_bad(e, "exactly")
        e = official(); e["tools"][0]["risk"] = "confirm"; self.assert_bad(e, "exactly")
        e = official("jarvis-files"); e["permissions"]["network"] = True; self.assert_bad(e, "network=False")
        e = official("jarvis-files"); e["permissions"]["paths"] = ["~/Documents"]; self.assert_bad(e, "paths=[]")
        e = official(); e["artifact"]["runtime"] = "node"; self.assert_bad(e, "go-static")
        e = official(); e["artifact"]["url"] = "https://evil.example/jarvis-clock.tar.gz"; self.assert_bad(e, "Pages")

    def test_third_parties_cannot_look_official(self):
        self.assert_bad(third(id_="jarvis-notes"), "reserved for official")
        for name in ("pkg.install", "svc.restart", "files.search", "web.fetch", "registry.install", "jarvis.describe"):
            e = third(); e["tools"][0]["name"] = name
            self.assert_bad(e, "reserved")

    def test_source_form(self):
        e = official(); e["artifact"] = {"runtime": "go-static"}
        self.assertEqual(schema.validate_entry(e, source=True), [])
        self.assert_bad(e, "artifact")  # not a built entry
        e = official()  # url/sha in a source file: build_index fills them, never the author
        self.assert_bad(e, "build_index.py", source=True)
        self.assertEqual(schema.validate_entry(third(), source=True), [])


class IndexTest(unittest.TestCase):
    def test_good(self):
        self.assertEqual(schema.validate_index(index(official("jarvis-clock"), official("jarvis-web"), third())), [])

    def test_breaks(self):
        cases = {
            "keys": {"version": 1, "entries": []},
            "validUntil": dict(index(), validUntil="2026-10-23 12:00"),
            "after generatedAt": dict(index(), validUntil="2026-10-09T12:00:00Z"),
            "30 days": dict(index(), validUntil="2026-12-01T00:00:00Z"),
            "version": dict(index(), version="1"),
            "generatedAt": dict(index(), generatedAt="2026-10-09 12:00"),
            "real date": dict(index(), generatedAt="2026-13-40T00:00:00Z"),
            "duplicate entry ids": index(third(), third()),
            "sorted": {"version": 1, "generatedAt": "2026-10-09T12:00:00Z", "validUntil": "2026-10-23T12:00:00Z", "entries": [official(), third()]},
        }
        for needle, idx in cases.items():
            problems = schema.validate_index(idx)
            self.assertTrue(any(needle in p for p in problems), f"{needle}: {problems}")
        a, b = third(id_="acme-a"), third(id_="acme-b")
        self.assertTrue(any("exposed by both" in p for p in schema.validate_index(index(a, b))))

    def test_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "index.json"
            f.write_text(json.dumps(index(official())))
            ok = subprocess.run([sys.executable, str(ROOT / "schema.py"), "check-index", str(f)], capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            f.write_text(json.dumps(index(third(id_="jarvis-x"))))
            bad = subprocess.run([sys.executable, str(ROOT / "schema.py"), "check-index", str(f)], capture_output=True, text=True)
            self.assertEqual(bad.returncode, 1)


class SeedTest(unittest.TestCase):
    def test_official_sources(self):
        files = sorted((ROOT / "servers").glob("*.json"))
        self.assertEqual([f.stem for f in files], ["jarvis-clock", "jarvis-files", "jarvis-web"])
        for f in files:
            e = json.loads(f.read_text())
            self.assertEqual(e["id"], f.stem)
            self.assertEqual(schema.validate_entry(e, source=True), [], f.name)


if __name__ == "__main__":
    unittest.main()
