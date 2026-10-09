import unittest
from unittest.mock import patch
from types import SimpleNamespace

from jarvis_smoke.cu_changes import changed, wants_cu


class CuChangesTest(unittest.TestCase):
    def test_computer_use_paths_trigger(self):
        for path in ("os/go/cmd/jarvis-cu/main.go", "os/go/internal/cu/capture.go", "os/go/go.mod",
                     "os/packaging/jarvis-cu/jarvis-cu.service", "os/packaging/jarvis-session/jarvis-shell-guard",
                     "os/iso/cu/session.sh", "os/iso/smoke/assets/cu/fakevision.mjs",
                     "os/iso/config/includes.chroot_after_packages/etc/xdg/labwc/autostart",
                     "os/shell/qml/ComputerUse.qml", "packages/core/src/agent/tool-loop.ts",
                     "packages/platform/src/model/ollama.ts", "packages/desktop/src/daemon/os/cu.ts",
                     ".github/workflows/os.yml", "os/models/catalog.json"):
            self.assertTrue(wants_cu([path]), path)

    def test_unrelated_paths_do_not(self):
        self.assertFalse(wants_cu(["docs/README.md", "os/recipes/docker.json", "os/registry/servers/x.json",
                                   "packages/desktop/src/renderer/App.tsx", "os/models/README.md"]))
        self.assertFalse(wants_cu([]))
        self.assertFalse(wants_cu([""]))

    def test_file_patterns_match_only_the_exact_file(self):
        for path in ("os/go/go.mod.bak", "os/go/go.sum.old",
                     "os/models/catalog.json.backup", ".github/workflows/os.yml.disabled"):
            with self.subTest(path=path):
                self.assertFalse(wants_cu([path]))

    @patch("jarvis_smoke.cu_changes.subprocess.run")
    def test_diff_preserves_deleted_rename_sources_and_filename_boundaries(self, run):
        run.return_value = SimpleNamespace(stdout="os/go/internal/cu/old.go\0docs/new\nname.go\0")
        self.assertEqual(changed("origin/master"),
                         ["os/go/internal/cu/old.go", "docs/new\nname.go"])
        run.assert_called_once_with(
            ["git", "diff", "--no-renames", "--name-only", "-z", "origin/master...HEAD", "--"],
            check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
