import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_registry  # noqa: E402
import matrix  # noqa: E402

CATALOG = Path(__file__).resolve().parents[2] / "catalog.json"


class RegistryTest(unittest.TestCase):
    def test_manifest_url(self):
        self.assertEqual(check_registry.manifest_url("qwen3:4b"), "https://registry.ollama.ai/v2/library/qwen3/manifests/4b")
        self.assertEqual(check_registry.manifest_url("me/model:q4"), "https://registry.ollama.ai/v2/me/model/manifests/q4")

    def test_manifest_size_sums_layers_and_config(self):
        m = {"config": {"size": 10}, "layers": [{"size": 100}, {"size": 5}]}
        self.assertEqual(check_registry.manifest_size(m), 115)

    def test_compare_and_fix(self):
        catalog = json.loads(CATALOG.read_text())
        sizes = {m["ollamaTag"]: m["sizeBytes"] for m in catalog["models"]}
        first = catalog["models"][0]["ollamaTag"]
        sizes[first] += 1
        problems = check_registry.compare(catalog, lambda tag: sizes[tag])
        self.assertEqual(len(problems), 1)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "c.json"
            path.write_text(CATALOG.read_text())
            check_registry.fix(path, lambda tag: sizes[tag])
            fixed = json.loads(path.read_text())
            self.assertEqual(fixed["models"][0]["sizeBytes"], sizes[first])
            self.assertTrue(path.read_text().endswith("}\n"))


class MatrixTest(unittest.TestCase):
    def test_hosted_and_large(self):
        out = matrix.build(json.loads(CATALOG.read_text()), max_hosted=12 << 30, large_runner="skip")
        runners = {row["id"]: row["runner"] for row in out["include"]}
        self.assertEqual(runners["qwen3-4b"], "ubuntu-24.04")
        self.assertEqual(runners["qwen3-30b-a3b"], "skip")
        self.assertEqual(set(out["include"][0]), {"id", "tag", "sizeBytes", "runner"})
