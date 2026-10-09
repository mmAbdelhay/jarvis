"""backup_model.py: pin, check and stage the backup brain (M4 contracts §1)."""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backup_model as bm  # noqa: E402

CONFIG, WEIGHTS, LICENSE = b'{"model_format":"gguf"}', b"GGUF" + b"\x01" * 4096, b"Apache-2.0"
TAG = "qwen3:1.7b"


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


MANIFEST = json.dumps({
    "schemaVersion": 2,
    "mediaType": bm.ACCEPT,
    "config": {"mediaType": "application/vnd.docker.container.image.v1+json", "digest": digest(CONFIG), "size": len(CONFIG)},
    "layers": [
        {"mediaType": "application/vnd.ollama.image.model", "digest": digest(WEIGHTS), "size": len(WEIGHTS)},
        {"mediaType": "application/vnd.ollama.image.license", "digest": digest(LICENSE), "size": len(LICENSE)},
    ],
}).encode()
TOTAL = len(CONFIG) + len(WEIGHTS) + len(LICENSE)


def catalog(tag=TAG, size=TOTAL, roles=("backup", "main")):
    return {"version": 1, "models": [
        {"id": f"m{i}", "ollamaTag": tag if r == "backup" else f"other{i}:8b",
         "sizeBytes": size if r == "backup" else 1, "role": r} for i, r in enumerate(roles)]}


class BackupModelTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.lock = bm.pin(catalog(), get=lambda url: MANIFEST)
        self.mirror = self.tmp / "mirror"
        (self.mirror / "blobs").mkdir(parents=True)
        for data in (CONFIG, WEIGHTS, LICENSE):
            (self.mirror / "blobs" / bm.blob_name(digest(data))).write_bytes(data)
        mp = self.mirror / bm.manifest_path(TAG)
        mp.parent.mkdir(parents=True)
        mp.write_bytes(MANIFEST)
        self.root, self.cache = self.tmp / "root", self.tmp / "cache"
        self.served = {bm.blob_url(TAG, digest(d)): d for d in (CONFIG, WEIGHTS, LICENSE)}
        self.downloads: list[str] = []

    def download(self, url: str, dest: Path) -> None:
        self.downloads.append(url)
        dest.write_bytes(self.served[url])

    def store(self) -> Path:
        return self.root / bm.STORE

    def test_paths_match_ollama(self):
        self.assertEqual(bm.manifest_url(TAG), "https://registry.ollama.ai/v2/library/qwen3/manifests/1.7b")
        self.assertEqual(bm.blob_url(TAG, "sha256:ab"), "https://registry.ollama.ai/v2/library/qwen3/blobs/sha256:ab")
        self.assertEqual(bm.manifest_path(TAG), Path("manifests/registry.ollama.ai/library/qwen3/1.7b"))
        self.assertEqual(bm.manifest_path("me/m:q4"), Path("manifests/registry.ollama.ai/me/m/q4"))
        self.assertEqual(bm.blob_name("sha256:ab"), "sha256-ab")

    def test_pin_records_manifest_and_every_blob(self):
        self.assertEqual(self.lock["ollamaTag"], TAG)
        self.assertEqual(self.lock["manifest"], {"sha256": hashlib.sha256(MANIFEST).hexdigest(), "size": len(MANIFEST)})
        self.assertEqual([b["digest"] for b in self.lock["blobs"]], [digest(CONFIG), digest(WEIGHTS), digest(LICENSE)])
        self.assertEqual(sum(b["size"] for b in self.lock["blobs"]), TOTAL)

    def test_check(self):
        self.assertEqual(bm.check(catalog(), self.lock), [])
        self.assertTrue(any("run backup_model.py pin" in p for p in bm.check(catalog(tag="qwen3:4b"), self.lock)))
        self.assertTrue(any("sizeBytes" in p for p in bm.check(catalog(size=TOTAL + 1), self.lock)))
        self.assertTrue(any("exactly one" in p for p in bm.check(catalog(roles=("backup", "backup")), self.lock)))
        bad = json.loads(json.dumps(self.lock))
        bad["blobs"][0]["digest"] = "md5:00"
        self.assertTrue(any("bad blob digest" in p for p in bm.check(catalog(), bad)))

    def test_stage_from_mirror_writes_an_ollama_store(self):
        out = bm.stage(self.root, self.lock, self.cache, self.mirror)
        self.assertEqual((self.store() / bm.manifest_path(TAG)).read_bytes(), MANIFEST)
        for data in (CONFIG, WEIGHTS, LICENSE):
            self.assertEqual((self.store() / "blobs" / bm.blob_name(digest(data))).read_bytes(), data)
        self.assertEqual(out["bytes"], TOTAL)

    def test_stage_from_registry_fills_and_reuses_the_cache(self):
        bm.stage(self.root, self.lock, self.cache, get=lambda u: MANIFEST, download=self.download)
        self.assertEqual(len(self.downloads), 3)
        bm.stage(self.tmp / "root2", self.lock, self.cache, get=lambda u: MANIFEST, download=self.download)
        self.assertEqual(len(self.downloads), 3, "second build must come from the cache")

    def test_tampered_mirror_blob_writes_nothing(self):
        (self.mirror / "blobs" / bm.blob_name(digest(WEIGHTS))).write_bytes(WEIGHTS + b"x")
        with self.assertRaisesRegex(ValueError, "does not match the lock"):
            bm.stage(self.root, self.lock, self.cache, self.mirror)
        self.assertFalse(self.store().exists())

    def test_bad_cached_blob_is_replaced_once(self):
        self.cache.mkdir()
        (self.cache / bm.blob_name(digest(WEIGHTS))).write_bytes(b"stale")
        bm.stage(self.root, self.lock, self.cache, get=lambda u: MANIFEST, download=self.download)
        self.assertEqual(self.downloads.count(bm.blob_url(TAG, digest(WEIGHTS))), 1)
        self.assertEqual((self.cache / bm.blob_name(digest(WEIGHTS))).read_bytes(), WEIGHTS)

    def test_registry_serving_other_bytes_fails_and_cleans_the_cache(self):
        self.served[bm.blob_url(TAG, digest(WEIGHTS))] = WEIGHTS[:-1] + b"\x02"
        with self.assertRaisesRegex(ValueError, "do not match the lock"):
            bm.stage(self.root, self.lock, self.cache, get=lambda u: MANIFEST, download=self.download)
        self.assertFalse((self.cache / bm.blob_name(digest(WEIGHTS))).exists())
        self.assertFalse(self.store().exists())

    def test_retagged_model_fails(self):
        other = MANIFEST.replace(b'"schemaVersion": 2', b'"schemaVersion": 2 ')
        with self.assertRaisesRegex(ValueError, "not the pinned one"):
            bm.stage(self.root, self.lock, self.cache, get=lambda u: other, download=self.download)

    def test_committed_lock_matches_catalog(self):
        self.assertEqual(bm.check(json.loads(bm.CATALOG.read_text()), json.loads(bm.LOCK.read_text())), [])
        self.assertEqual(bm.main(["check"]), 0)


if __name__ == "__main__":
    unittest.main()
