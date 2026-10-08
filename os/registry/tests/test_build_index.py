"""build_index.py: index + artifacts site tree, immutability, carry-over (M2.5 contracts §3)."""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build_index  # noqa: E402
import schema  # noqa: E402

T1, T2, T3 = "2026-10-09T10:00:00Z", "2026-10-10T10:00:00Z", "2026-10-11T10:00:00Z"
IDS = ("jarvis-clock", "jarvis-files", "jarvis-web")


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class BuildIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.servers = self.tmp / "servers"
        shutil.copytree(ROOT / "servers", self.servers)
        self.art = self.tmp / "art"
        self.art.mkdir()
        self.write_artifacts(b"v1")
        self.warnings: list[str] = []

    def write_artifacts(self, tag: bytes, art: Path | None = None):
        art = art or self.art
        art.mkdir(exist_ok=True)
        for i in IDS:
            (art / schema.artifact_name(i, "0.1.0")).write_bytes(tag + i.encode())

    def build(self, out, channel="stable", previous=None, at=T1, art=None, verify=None):
        return build_index.build(self.servers, art or self.art, out, channel, previous=previous,
                                 generated_at=at, verify=verify, warn=self.warnings.append)

    def index(self, site, channel="stable"):
        return json.loads((site / schema.CHANNEL_DIRS[channel] / "index.json").read_text())

    def test_builds_index_with_urls_and_hashes(self):
        site = self.tmp / "site"
        self.assertEqual(self.build(site), [])
        idx = self.index(site)
        self.assertEqual(schema.validate_index(idx), [])
        self.assertEqual([e["id"] for e in idx["entries"]], list(IDS))
        clock = idx["entries"][0]
        self.assertEqual(clock["artifact"]["url"], schema.official_url("stable", "jarvis-clock", "0.1.0"))
        self.assertEqual(clock["artifact"]["sha256"], sha(b"v1jarvis-clock"))
        placed = site / "registry/artifacts/jarvis-clock/0.1.0" / schema.artifact_name("jarvis-clock", "0.1.0")
        self.assertEqual(placed.read_bytes(), b"v1jarvis-clock")
        self.assertEqual(idx["generatedAt"], T1)
        self.assertEqual(idx["validUntil"], "2026-11-08T10:00:00Z")

    def test_testing_channel(self):
        site = self.tmp / "site"
        self.assertEqual(self.build(site, "testing"), [])
        self.assertIn("/registry-testing/artifacts/", self.index(site, "testing")["entries"][0]["artifact"]["url"])
        self.assertFalse((site / "registry").exists())

    def test_deterministic(self):
        a, b = self.tmp / "a", self.tmp / "b"
        self.build(a)
        self.build(b)
        self.assertEqual((a / "registry/index.json").read_bytes(), (b / "registry/index.json").read_bytes())

    def test_missing_artifact_fails(self):
        (self.art / schema.artifact_name("jarvis-web", "0.1.0")).unlink()
        problems = self.build(self.tmp / "site")
        self.assertTrue(any("jarvis-web" in p and "package-official.sh" in p for p in problems), problems)

    def test_invalid_source_listed_and_nothing_written(self):
        bad = json.loads((self.servers / "jarvis-clock.json").read_text())
        bad.update(id="acme-x", tier="community", artifact={"url": "https://e.org/a.tgz", "sha256": "a" * 64, "runtime": "node"},
                   permissions={"network": False, "paths": ["~/.ssh"]}, tools=[{"name": "acme.x", "risk": "safe"}])
        (self.servers / "acme-x.json").write_text(json.dumps(bad))
        site = self.tmp / "site"
        problems = self.build(site)
        self.assertTrue(any("acme-x.json" in p and "protected" in p for p in problems), problems)
        self.assertFalse((site / "registry/index.json").exists())

    def test_source_id_must_match_file_name(self):
        shutil.move(self.servers / "jarvis-clock.json", self.servers / "clock.json")
        self.assertTrue(any("file name" in p for p in self.build(self.tmp / "site")))

    def test_immutable_version_keeps_published_bytes(self):
        s1, s2 = self.tmp / "s1", self.tmp / "s2"
        self.assertEqual(self.build(s1), [])
        art2 = self.tmp / "art2"
        self.write_artifacts(b"v2", art2)
        self.assertEqual(self.build(s2, previous=s1, at=T2, art=art2), [])
        placed = s2 / "registry/artifacts/jarvis-clock/0.1.0" / schema.artifact_name("jarvis-clock", "0.1.0")
        self.assertEqual(placed.read_bytes(), b"v1jarvis-clock")
        self.assertEqual(self.index(s2)["entries"][0]["artifact"]["sha256"], sha(b"v1jarvis-clock"))
        self.assertTrue(any("jarvis-clock 0.1.0" in w and "bump the version" in w for w in self.warnings), self.warnings)

    def test_new_version_published_old_kept(self):
        s1, s2 = self.tmp / "s1", self.tmp / "s2"
        self.build(s1)
        clock = json.loads((self.servers / "jarvis-clock.json").read_text())
        clock["version"] = "0.2.0"
        (self.servers / "jarvis-clock.json").write_text(json.dumps(clock))
        (self.art / schema.artifact_name("jarvis-clock", "0.2.0")).write_bytes(b"new clock")
        self.assertEqual(self.build(s2, previous=s1, at=T2), [])
        self.assertEqual(self.index(s2)["entries"][0]["version"], "0.2.0")
        self.assertTrue((s2 / "registry/artifacts/jarvis-clock/0.1.0").is_dir(), "older artifacts stay downloadable")

    def test_tampered_previous_artifact_refused(self):
        s1, s2 = self.tmp / "s1", self.tmp / "s2"
        self.build(s1)
        (s1 / "registry/artifacts/jarvis-web/0.1.0" / schema.artifact_name("jarvis-web", "0.1.0")).write_bytes(b"evil")
        problems = self.build(s2, previous=s1, at=T2)
        self.assertTrue(any("jarvis-web" in p and "previously signed index" in p for p in problems), problems)

    def test_planted_artifact_without_index_refused(self):
        s1, s2 = self.tmp / "s1", self.tmp / "s2"
        self.build(s1, "testing")
        planted = s1 / "registry/artifacts/jarvis-web/0.1.0"
        planted.mkdir(parents=True)
        (planted / schema.artifact_name("jarvis-web", "0.1.0")).write_bytes(b"planted")
        problems = self.build(s2, previous=s1, at=T2)
        self.assertTrue(any("previously signed index" in p for p in problems), problems)

    def test_version_may_not_go_backwards(self):
        s1, s2 = self.tmp / "s1", self.tmp / "s2"
        clock = json.loads((self.servers / "jarvis-clock.json").read_text())
        clock["version"] = "0.3.0"
        (self.servers / "jarvis-clock.json").write_text(json.dumps(clock))
        (self.art / schema.artifact_name("jarvis-clock", "0.3.0")).write_bytes(b"c3")
        self.build(s1)
        clock["version"] = "0.2.0"
        (self.servers / "jarvis-clock.json").write_text(json.dumps(clock))
        (self.art / schema.artifact_name("jarvis-clock", "0.2.0")).write_bytes(b"c2")
        problems = self.build(s2, previous=s1, at=T2)
        self.assertTrue(any("backwards" in p for p in problems), problems)

    def test_generated_at_must_increase(self):
        s1, s2 = self.tmp / "s1", self.tmp / "s2"
        self.build(s1, at=T2)
        self.assertTrue(any("generatedAt" in p for p in self.build(s2, previous=s1, at=T1)))

    def test_other_channel_carried_over(self):
        s1, s2, s3 = self.tmp / "s1", self.tmp / "s2", self.tmp / "s3"
        self.build(s1, "testing")
        (s1 / "registry-testing/index.json.sig").write_bytes(b"sig")
        self.assertEqual(self.build(s2, "stable", previous=s1, at=T2), [])
        self.assertEqual((s2 / "registry-testing/index.json.sig").read_bytes(), b"sig")
        self.assertTrue((s2 / "registry/index.json").exists())
        # rebuilding a channel never carries its own old index or signature
        self.assertEqual(self.build(s3, "testing", previous=s2, at=T3), [])
        self.assertFalse((s3 / "registry-testing/index.json.sig").exists())
        self.assertTrue((s3 / "registry/index.json").exists())

    def test_verify_remote(self):
        entry = {"id": "acme-notes", "tier": "community",
                 "artifact": {"url": "https://e.org/a.tgz", "sha256": sha(b"good"), "runtime": "node"}}
        official = {"id": "jarvis-clock", "tier": "official", "artifact": {"url": "x", "sha256": "y", "runtime": "go-static"}}
        self.assertEqual(build_index.verify_remote([official, entry], fetch=lambda url: sha(b"good")), [])
        problems = build_index.verify_remote([entry], fetch=lambda url: sha(b"tampered"))
        self.assertTrue(any("acme-notes" in p and "pins" in p for p in problems), problems)

        def boom(url):
            raise OSError("404")
        self.assertTrue(any("cannot fetch" in p for p in build_index.verify_remote([entry], fetch=boom)))


if __name__ == "__main__":
    unittest.main()
