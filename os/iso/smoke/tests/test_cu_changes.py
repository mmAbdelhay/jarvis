import unittest

from jarvis_smoke.cu_changes import wants_cu


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


if __name__ == "__main__":
    unittest.main()
