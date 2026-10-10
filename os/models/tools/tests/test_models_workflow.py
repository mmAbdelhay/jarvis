"""Static checks of the workflow's wiring; Python stdlib only."""
import unittest
from pathlib import Path

WF = Path(__file__).resolve().parents[4] / ".github" / "workflows" / "os-models.yml"


def block(text, key, indent):
    """Read a mapping block at a known indentation, without a YAML dependency."""
    lines = text.splitlines()
    header = " " * indent + key + ":"
    if header not in lines:
        return ""
    start = lines.index(header)
    result = []
    for line in lines[start + 1:]:
        if line.strip() and not line.lstrip().startswith("#"):
            width = len(line) - len(line.lstrip())
            if width <= indent:
                break
        result.append(line)
    return "\n".join(result)


class ModelsWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.text = WF.read_text()
        self.jobs = block(self.text, "jobs", 0)

    def test_vision_input_and_jobs(self):
        vision = block(self.text, "vision", 6)
        self.assertRegex(vision, r"(?m)^        type: boolean$")
        matrix = block(self.jobs, "vision-matrix", 2)
        self.assertIn("vision-candidates.json", matrix)
        self.assertIn("github.event_name == 'schedule'", matrix)
        self.assertIn("inputs.vision", matrix)
        probe = block(self.jobs, "vision-probe", 2)
        self.assertRegex(probe, r"(?m)^    needs: vision-matrix$")
        for value in ("VISION_MODEL_TAG", "VISION_PROBE_OUT", "vision-probe.test.ts",
                      "upload-artifact", "fetch-ollama.sh"):
            self.assertIn(value, probe)
        catalog = block(self.jobs, "probe", 2)
        self.assertIn("catalog-probe.test.ts", catalog)
        self.assertNotIn("vision-probe.test.ts", catalog)

    def test_registry_job_checks_candidates(self):
        registry = block(self.jobs, "registry", 2)
        self.assertIn("vision_pick.py check", registry)
        self.assertIn("check_registry.py os/models/vision-candidates.json", registry)

    def test_concurrency_and_paths_kept(self):
        concurrency = block(self.text, "concurrency", 0)
        self.assertRegex(concurrency, r"(?m)^  cancel-in-progress: true$")
        paths = block(self.text, "paths", 4)
        self.assertIn('"os/models/**"', paths)
        self.assertEqual(block(self.text, "permissions", 0).strip(), "contents: read")


if __name__ == "__main__":
    unittest.main()
