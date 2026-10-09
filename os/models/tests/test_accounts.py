"""accounts.json (Plan Y spec §2.2, §5.4): pinned official CLIs."""
import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "..", "accounts.json")
ACCOUNTS = ["claude", "chatgpt", "gemini", "copilot"]
PACKAGES = {
    "claude": "@anthropic-ai/claude-code",
    "chatgpt": "@openai/codex",
    "gemini": "@google/gemini-cli",
    "copilot": "@github/copilot",
}
VERSION = re.compile(r"^\d+\.\d+\.\d+$")
INTEGRITY = re.compile(r"^sha512-[A-Za-z0-9+/]{86}==$")
BIN = re.compile(r"^[A-Za-z0-9._/-]{1,80}$")
MODEL = re.compile(r"^[a-z0-9][a-z0-9.:-]{0,63}$")


def validate_accounts(doc):
    problems = []
    if not isinstance(doc, dict) or type(doc.get("version")) is not int or doc.get("version") != 1:
        return ["version must be 1"]
    rows = doc.get("accounts")
    if not isinstance(rows, list) or len(rows) != 4 or any(not isinstance(r, dict) for r in rows) or [r.get("account") for r in rows] != ACCOUNTS:
        return ["accounts must list claude, chatgpt, gemini, copilot in that order"]
    for row in rows:
        name = row["account"]
        where = f"accounts[{name}]"
        allowed = {"account", "package", "version", "integrity", "bin", "postinstall",
                   "omitOptional", "platformPackage", "models"}
        extra = set(row) - allowed
        if extra:
            problems.append(f"{where}: unknown fields {sorted(extra)}")
        if row.get("package") != PACKAGES[name]:
            problems.append(f"{where}: package must be {PACKAGES[name]}")
        if not VERSION.fullmatch(str(row.get("version", ""))):
            problems.append(f"{where}: version must be an exact x.y.z")
        if not INTEGRITY.fullmatch(str(row.get("integrity", ""))):
            problems.append(f"{where}: integrity must be an npm sha512 SRI string")
        b = row.get("bin")
        if not isinstance(b, str) or not BIN.fullmatch(b) or ".." in b or b.startswith("/") or any(part in {"", ".", ".."} for part in b.split("/")):
            problems.append(f"{where}: bin must be a relative path inside the package")
        post = row.get("postinstall")
        if post is not None and post != "install.cjs":
            problems.append(f"{where}: postinstall may only be the package's own install.cjs")
        if not isinstance(row.get("omitOptional"), bool):
            problems.append(f"{where}: omitOptional must be true or false")
        plat = row.get("platformPackage")
        if plat is not None:
            if not isinstance(plat, dict):
                problems.append(f"{where}: platformPackage must be an object or null")
            else:
                if set(plat) != {"name", "version", "integrity"}:
                    problems.append(f"{where}: platformPackage requires name, version, integrity only")
                if plat.get("name") != PACKAGES[name] + "-linux-x64":
                    problems.append(f"{where}: platformPackage.name must be the official linux-x64 package")
                pv = plat.get("version")
                if not isinstance(pv, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:-linux-x64)?", pv):
                    problems.append(f"{where}: platformPackage.version must be exact")
                if not INTEGRITY.fullmatch(str(plat.get("integrity", ""))):
                    problems.append(f"{where}: platformPackage.integrity must be sha512")
        models = row.get("models")
        if not isinstance(models, list) or not models or not isinstance(models[0], dict) or models[0].get("id") != "default":
            problems.append(f"{where}: models must start with {{id: default}}")
        else:
            seen = set()
            for m in models:
                if not isinstance(m, dict):
                    problems.append(f"{where}: model must be an object")
                    continue
                mid = m.get("id")
                if isinstance(mid, str):
                    if mid in seen:
                        problems.append(f"{where}: duplicate model id {mid}")
                    seen.add(mid)
                if not MODEL.fullmatch(str(m.get("id", ""))) or not isinstance(m.get("vision"), bool):
                    problems.append(f"{where}: bad model {m!r}")
                if m.get("vision") and name != "claude":
                    problems.append(f"{where}: only claude models may have vision in v1.1 (spec §5.8)")
    return problems


class AccountsJson(unittest.TestCase):
    def test_shipped_file_is_valid(self):
        with open(PATH, encoding="utf-8") as f:
            self.assertEqual(validate_accounts(json.load(f)), [])

    def test_rejects_a_range_version(self):
        with open(PATH, encoding="utf-8") as f:
            doc = json.load(f)
        doc["accounts"][0]["version"] = "^2.1.0"
        self.assertIn("accounts[claude]: version must be an exact x.y.z", validate_accounts(doc))

    def test_rejects_a_foreign_postinstall(self):
        with open(PATH, encoding="utf-8") as f:
            doc = json.load(f)
        doc["accounts"][2]["postinstall"] = "curl | sh"
        self.assertTrue(any("postinstall" in p for p in validate_accounts(doc)))

    def test_rejects_vision_outside_claude(self):
        with open(PATH, encoding="utf-8") as f:
            doc = json.load(f)
        doc["accounts"][1]["models"][0]["vision"] = True
        self.assertTrue(any("only claude" in p for p in validate_accounts(doc)))


    def test_rejects_malformed_shapes_and_unsafe_pin_values(self):
        import copy
        with open(PATH, encoding="utf-8") as f:
            base = json.load(f)
        bad_docs = []
        for key, value in [
            ("bin", "bin//claude.exe"),
            ("version", "2.1.280\n"),
            ("models", [None]),
            ("models", [{"id": "default", "vision": True}, {"id": "default", "vision": True}]),
            ("platformPackage", {"name": "@anthropic-ai/claude-code-evil", "version": "2.1.280", "integrity": base["accounts"][0]["integrity"]}),
            ("platformPackage", {"name": "@anthropic-ai/claude-code-linux-x64", "version": "^2.1.280", "integrity": base["accounts"][0]["integrity"]}),
        ]:
            doc = copy.deepcopy(base)
            doc["accounts"][0][key] = value
            bad_docs.append(doc)
        doc = copy.deepcopy(base)
        doc["accounts"].append(None)
        bad_docs.append(doc)
        doc = copy.deepcopy(base)
        doc["version"] = True
        bad_docs.append(doc)
        for doc in bad_docs:
            with self.subTest(case=bad_docs.index(doc)):
                self.assertTrue(validate_accounts(doc))


class AccountsPin(unittest.TestCase):
    def test_pin_preview_write_and_refusals(self):
        import importlib.util
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location("accounts_pin", Path(HERE) / "../tools/accounts_pin.py")
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        original = Path(PATH).read_text()
        integrity = "sha512-" + "A" * 86 + "=="
        def registry(package, field):
            if field == "time":
                return {"9.8.7": "2020-01-01T00:00:00Z", "9.8.6": "2999-01-01T00:00:00Z"}
            if field == "optionalDependencies":
                return {"@openai/codex-linux-x64": "npm:@openai/codex-linux-x64@9.8.7-linux-x64"}
            if field == "dist.integrity":
                return integrity
            raise AssertionError((package, field))
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "accounts.json"
            target.write_text(original)
            with patch.object(tool, "PATH", str(target)), patch.object(tool, "npm_view", registry), patch("sys.stdout"):
                with patch("sys.argv", ["accounts_pin.py", "chatgpt", "9.8.7"]):
                    tool.main()
                self.assertEqual(target.read_text(), original)
                with patch("sys.argv", ["accounts_pin.py", "chatgpt", "9.8.7", "--write"]):
                    tool.main()
                doc = json.loads(target.read_text())
                self.assertEqual(validate_accounts(doc), [])
                self.assertEqual(doc["accounts"][1]["version"], "9.8.7")
                self.assertEqual(doc["accounts"][1]["platformPackage"]["version"], "9.8.7-linux-x64")
                saved = target.read_text()
                def foreign_registry(package, field):
                    if field == "optionalDependencies":
                        return {"@openai/codex-linux-x64": "npm:@foreign/cli@9.8.7"}
                    return registry(package, field)
                with patch.object(tool, "npm_view", foreign_registry), patch("sys.argv", ["accounts_pin.py", "chatgpt", "9.8.7", "--write"]):
                    with self.assertRaises(SystemExit):
                        tool.main()
                self.assertEqual(target.read_text(), saved)
                for version in ["9.8.6", "0.0.0", "^9.8.7"]:
                    with patch("sys.argv", ["accounts_pin.py", "chatgpt", version, "--write"]):
                        with self.assertRaises(SystemExit):
                            tool.main()
                    self.assertEqual(target.read_text(), saved)

    def test_rejects_malformed_registry_integrity_without_writing(self):
        import importlib.util
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        spec = importlib.util.spec_from_file_location("accounts_pin", Path(HERE) / "../tools/accounts_pin.py")
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        original = Path(PATH).read_text()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "accounts.json"
            target.write_text(original)
            with patch.object(tool, "PATH", str(target)), patch.object(tool, "npm_view", lambda spec, field: {"9.8.7": "2020-01-01T00:00:00Z"} if field == "time" else "invalid"), patch("sys.argv", ["accounts_pin.py", "gemini", "9.8.7", "--write"]):
                with self.assertRaises(SystemExit):
                    tool.main()
            self.assertEqual(target.read_text(), original)


if __name__ == "__main__":
    unittest.main()
