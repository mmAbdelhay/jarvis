"""Recipes (M4 contracts §4): format, seeds, and the tool allowlist (Review Focus 4)."""
from __future__ import annotations

import copy
import json
import shutil
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import check_sources  # noqa: E402
import recipes  # noqa: E402

GOOD = {
    "id": "demo",
    "title": {"en": "Demo", "ar": "تجربة"},
    "description": {"en": "A demo recipe.", "ar": "وصفة للتجربة."},
    "steps": [
        {"tool": "pkg.install", "input": {"items": [{"source": "apt", "id": "git"}]},
         "title": {"en": "Install Git", "ar": "تثبيت Git"}},
        {"tool": "svc.restart", "input": {"unit": "docker"},
         "title": {"en": "Start Docker", "ar": "تشغيل دوكر"}},
    ],
    "requires": {"os": "rafiq", "minRamGB": 4},
}


def step(tool, inp):
    return {"tool": tool, "input": inp, "title": {"en": "Step", "ar": "خطوة"}}


class CommittedRecipes(unittest.TestCase):
    def test_all_valid(self):
        self.assertEqual(recipes.validate_dir(recipes.RECIPES), [])

    def test_seeds_and_workspace_present(self):
        ids = {p.stem for p in recipes.RECIPES.glob("*.json")}
        self.assertEqual(ids, set(recipes.SEED) | set(recipes.EXTRA))

    def test_workspace_recipe_installs_the_package(self):
        r = json.loads((recipes.RECIPES / "jarvis-workspace.json").read_text())
        self.assertEqual(r["steps"][0]["input"], {"items": [{"source": "apt", "id": "jarvis-workspace"}]})

    def test_workspace_recipe_unavailable(self):
        r = json.loads((recipes.RECIPES / "jarvis-workspace.json").read_text())
        self.assertIs(r["available"], False)

    def test_docker_recipe_ends_with_a_note(self):
        r = json.loads((recipes.RECIPES / "docker.json").read_text())
        self.assertEqual(r["steps"][-1]["tool"], "note")

    def test_allowlist_is_exact(self):
        self.assertEqual(set(recipes.RECIPE_TOOLS), {"pkg.install", "svc.restart", "apps.set_default"})

    def test_sources(self):
        src = recipes.sources(recipes.RECIPES)
        self.assertIn(("apt", "docker.io"), src)
        self.assertIn(("flatpak", "org.libreoffice.LibreOffice"), src)
        self.assertEqual(src, sorted(set(src)))


class Validator(unittest.TestCase):
    def assertRefused(self, mutate, why):
        r = copy.deepcopy(GOOD)
        mutate(r)
        self.assertNotEqual(recipes.validate(r, "demo.json"), [], why)

    def test_good(self):
        self.assertEqual(recipes.validate(copy.deepcopy(GOOD), "demo.json"), [])

    def test_forbidden_tools(self):
        for tool, inp in [("users.add", {"username": "x"}), ("disks.format_removable", {"device": "/dev/sdb"}),
                          ("recipes.run", {"id": "docker"}), ("registry.install", {"id": "x", "version": "1"}),
                          ("pkg.remove", {"items": [{"source": "apt", "id": "git"}]}),
                          ("files.trash", {"items": [{"from": "~/x"}]}), ("settings.wifi", {"on": False}),
                          ("svc.restart ", {"unit": "docker"})]:
            self.assertRefused(lambda r, t=tool, i=inp: r["steps"].append(step(t, i)), tool)

    def test_pkg_install_limits(self):
        many = {"items": [{"source": "apt", "id": f"pkg{i}"} for i in range(11)]}
        cases = {
            "11 items": many,
            "no items": {"items": []},
            "extra key": {"items": [{"source": "apt", "id": "git"}], "force": True},
            "bad source": {"items": [{"source": "snap", "id": "git"}]},
            "bad apt name": {"items": [{"source": "apt", "id": "Git;rm"}]},
            "OS package": {"items": [{"source": "apt", "id": "jarvis-shell"}]},
            "short flatpak": {"items": [{"source": "flatpak", "id": "org.vlc"}]},
            "dash flatpak": {"items": [{"source": "flatpak", "id": "-org.videolan.VLC"}]},
            "item extra key": {"items": [{"source": "apt", "id": "git", "version": "1"}]},
        }
        for why, inp in cases.items():
            self.assertRefused(lambda r, i=inp: r["steps"].__setitem__(0, step("pkg.install", i)), why)

    def test_svc_restart_limits(self):
        for why, inp in {"not allowlisted": {"unit": "ssh"}, "user scope": {"unit": "docker", "scope": "user"},
                         "extra key": {"unit": "docker", "now": True}, "unit not a string": {"unit": ["docker"]}}.items():
            self.assertRefused(lambda r, i=inp: r["steps"].__setitem__(1, step("svc.restart", i)), why)
        r = copy.deepcopy(GOOD)
        r["steps"][1] = step("svc.restart", {"unit": "docker.service", "scope": "system"})
        self.assertEqual(recipes.validate(r, "demo.json"), [])

    def test_apps_set_default_limits(self):
        r = copy.deepcopy(GOOD)
        r["steps"].append(step("apps.set_default", {"mimeType": "application/pdf", "appId": "org.gnome.Evince"}))
        self.assertEqual(recipes.validate(r, "demo.json"), [])
        for why, inp in {"extra key": {"mimeType": "text/html", "appId": "x", "force": 1},
                         "no app": {"mimeType": "text/html"},
                         "bad mime": {"mimeType": "text/html; rm -rf", "appId": "firefox-esr"},
                         "bad app": {"mimeType": "text/html", "appId": "a b"},
                         "app not string": {"mimeType": "text/html", "appId": ["x"]}}.items():
            self.assertRefused(lambda r, i=inp: r["steps"].append(step("apps.set_default", i)), why)

    def test_note_steps(self):
        text = {"en": "Sign out and back in.", "ar": "سجّل الخروج ثم الدخول."}
        r = copy.deepcopy(GOOD)
        r["steps"].append(step("note", {"text": text}))
        self.assertEqual(recipes.validate(r, "demo.json"), [])
        self.assertRefused(lambda r: r["steps"].insert(0, step("note", {"text": text})), "note before a runnable step")
        self.assertRefused(lambda r: r["steps"].append(step("note", {"text": {"en": "x"}})), "note without ar")
        self.assertRefused(lambda r: r["steps"].append(step("note", {"text": text, "run": "id"})), "extra key")
        self.assertRefused(lambda r: r.update(steps=[step("note", {"text": text})]), "only notes")

    def test_available_flag(self):
        r = copy.deepcopy(GOOD)
        r["available"] = False
        self.assertEqual(recipes.validate(r, "demo.json"), [])
        self.assertRefused(lambda r: r.update(available="no"), "non-bool")

    def test_text_rules(self):
        self.assertRefused(lambda r: r["title"].pop("ar"), "missing ar")
        self.assertRefused(lambda r: r["title"].update(ar="Demo"), "ar without Arabic letters")
        self.assertRefused(lambda r: r["description"].update(en="وصفة"), "en with Arabic")
        self.assertRefused(lambda r: r["steps"][0]["title"].update(en=""), "empty step title")
        self.assertRefused(lambda r: r["title"].update(en="x" * 81), "title too long")

    def test_shape_rules(self):
        r = copy.deepcopy(GOOD)
        r["id"] = "jarvis-workspace"
        self.assertNotEqual(recipes.validate(r, "jarvis-workspace.json"), [], "workspace must be available:false")
        self.assertRefused(lambda r: r.update(extra=1), "extra key")
        self.assertRefused(lambda r: r["requires"].update(os="debian"), "other OS")
        self.assertRefused(lambda r: r["requires"].update(minRamGB=True), "bool RAM")
        self.assertRefused(lambda r: r.update(steps=[]), "no steps")
        self.assertRefused(lambda r: r.update(steps=[GOOD["steps"][0]] * 11), "11 steps")
        self.assertRefused(lambda r: r["steps"].append(copy.deepcopy(GOOD["steps"][0])), "duplicate package")
        self.assertRefused(lambda r: r.update(id="Demo"), "bad id")
        self.assertNotEqual(recipes.validate(copy.deepcopy(GOOD), "other.json"), [], "file name must match id")

    def test_dir_needs_every_seed(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        (tmp / "demo.json").write_text(json.dumps(GOOD))
        problems = recipes.validate_dir(tmp)
        self.assertTrue(any("python-dev" in p for p in problems), problems)
        (tmp / "broken.json").write_text("{")
        self.assertTrue(any("broken.json" in p for p in recipes.validate_dir(tmp)))


class Sources(unittest.TestCase):
    def test_flathub_lookup(self):
        class Resp:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False
        def missing(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)
        self.assertTrue(check_sources.flathub_exists("org.videolan.VLC", opener=lambda req, timeout: Resp()))
        self.assertFalse(check_sources.flathub_exists("org.example.Nope", opener=missing))


if __name__ == "__main__":
    unittest.main()
