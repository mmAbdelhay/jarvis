"""i18n_gate.py (M4 contracts §3): en/ar .ts pairs, nothing unfinished."""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import i18n_gate as g  # noqa: E402

AR_FILES = ["لا توجد ملفات", "ملف واحد", "ملفان", "%n ملفات", "%n ملفًا", "%n ملف"]
EN = [("Chat", "Send", "Send"), ("Chat", "Connect to %1", "Connect to %1"),
      ("Files", "%n file(s)", ["%n file", "%n files"])]
AR = [("Chat", "Send", "إرسال"), ("Chat", "Connect to %1", "الاتصال بـ %1"),
      ("Files", "%n file(s)", AR_FILES)]


def ts(lang: str, messages) -> str:
    """messages: (context, source, translation); translation is a str, a list
    of plural forms, or (type, str|list) for unfinished/vanished entries."""
    out = ['<?xml version="1.0" encoding="utf-8"?>', "<!DOCTYPE TS>", f'<TS version="2.1" language="{lang}">']
    contexts: dict[str, list] = {}
    for ctx, src, tr in messages:
        contexts.setdefault(ctx, []).append((src, tr))
    for ctx, items in contexts.items():
        out.append(f"<context><name>{escape(ctx)}</name>")
        for src, tr in items:
            kind = ""
            if isinstance(tr, tuple):
                kind, tr = tr
            attr = f' type="{kind}"' if kind else ""
            if isinstance(tr, list):
                forms = "".join(f"<numerusform>{escape(f)}</numerusform>" for f in tr)
                out.append(f'<message numerus="yes"><source>{escape(src)}</source><translation{attr}>{forms}</translation></message>')
            else:
                out.append(f"<message><source>{escape(src)}</source><translation{attr}>{escape(tr)}</translation></message>")
        out.append("</context>")
    out.append("</TS>")
    return "\n".join(out)


class GateTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)

    def write(self, comp: str, en=EN, ar=AR, en_lang="en", ar_lang="ar"):
        d = self.root / comp / "i18n"
        d.mkdir(parents=True, exist_ok=True)
        if en is not None:
            (d / "en.ts").write_text(ts(en_lang, en), encoding="utf-8")
        if ar is not None:
            (d / "ar.ts").write_text(ts(ar_lang, ar), encoding="utf-8")
        return self.root / comp

    def problems(self, **kw) -> list[str]:
        return g.check_component(self.write("shell", **kw))[0]

    def test_a_complete_pair_passes(self):
        self.assertEqual(g.check_component(self.write("shell")), ([], []))

    def test_arabic_plural_may_drop_percent_n(self):
        self.assertFalse(any("placeholder" in p for p in self.problems()))

    def test_missing_and_extra_keys(self):
        self.assertTrue(any('"Send"' in p and "no ar" in p for p in self.problems(ar=AR[1:])))
        self.assertTrue(any("no en" in p for p in self.problems(ar=AR + [("Chat", "Cancel", "إلغاء")])))

    def test_unfinished_in_either_language(self):
        self.assertTrue(any("ar:" in p and "unfinished" in p for p in self.problems(ar=[AR[0], ("Chat", "Connect to %1", ("unfinished", "")), AR[2]])))
        self.assertTrue(any("en:" in p and "unfinished" in p for p in self.problems(en=[("Chat", "Send", ("unfinished", "")), *EN[1:]])))

    def test_empty_translation(self):
        self.assertTrue(any("empty" in p for p in self.problems(ar=[("Chat", "Send", " "), *AR[1:]])))

    def test_arabic_needs_six_plural_forms(self):
        p = self.problems(ar=[*AR[:2], ("Files", "%n file(s)", ["ملف واحد", "%n ملفات"])])
        self.assertTrue(any("ar needs 6" in x for x in p), p)

    def test_dropped_placeholder(self):
        p = self.problems(ar=[AR[0], ("Chat", "Connect to %1", "الاتصال"), AR[2]])
        self.assertTrue(any("placeholders" in x for x in p), p)

    def test_language_attribute(self):
        self.assertTrue(any("declares language" in p for p in self.problems(ar_lang="en")))
        self.assertEqual(self.problems(ar_lang="ar_EG"), [])

    def test_vanished_messages_are_ignored(self):
        self.assertEqual(self.problems(ar=AR + [("Old", "Gone", ("vanished", "قديم"))]), [])

    def test_latin_only_arabic_is_a_warning(self):
        problems, warnings = g.check_component(self.write("shell", ar=[("Chat", "Send", "Send"), *AR[1:]]))
        self.assertEqual(problems, [])
        self.assertTrue(any("no Arabic letters" in w for w in warnings))

    def test_missing_file_and_malformed_xml(self):
        self.assertTrue(any("missing i18n/ar.ts" in p for p in self.problems(ar=None)))
        comp = self.write("shell")
        (comp / "i18n" / "ar.ts").write_text("<TS><context>", encoding="utf-8")
        self.assertTrue(any("ar.ts" in p for p in g.check_component(comp)[0]))

    def test_tree_requires_components_and_checks_extras(self):
        for c in g.REQUIRED[1:]:
            self.write(c)
        self.write("ui", ar=AR[1:])
        problems, _ = g.check_tree(self.root)
        self.assertTrue(any(p.startswith("shell: no i18n/") for p in problems), problems)
        self.assertTrue(any(p.startswith("ui: ") for p in problems), "optional components are checked too")

    def test_english_needs_two_plural_forms(self):
        p = self.problems(en=[*EN[:2], ("Files", "%n file(s)", ["%n file"])])
        self.assertTrue(any("en needs 2" in x for x in p), p)

    def test_empty_plural_form(self):
        p = self.problems(ar=[*AR[:2], ("Files", "%n file(s)", ["", *AR_FILES[1:]])])
        self.assertTrue(any("empty" in x for x in p), p)

    def test_obsolete_messages_are_ignored(self):
        self.assertEqual(self.problems(ar=AR + [("Old", "Gone", ("obsolete", "قديم"))]), [])

    def test_nonplural_percent_n_is_preserved(self):
        p = self.problems(en=[("Files", "%n file", "%n file")],
                          ar=[("Files", "%n file", "ملف")])
        self.assertTrue(any("placeholders" in x for x in p), p)

    def test_localized_and_repeated_placeholders_are_preserved(self):
        p = self.problems(en=[("Files", "%L1 %1 %1", "%L1 %1 %1")],
                          ar=[("Files", "%L1 %1 %1", "%L1 %1")])
        self.assertTrue(any("placeholders" in x for x in p), p)

    def test_wrong_xml_root(self):
        comp = self.write("shell")
        (comp / "i18n" / "ar.ts").write_text("<other/>", encoding="utf-8")
        self.assertTrue(any("not a Qt" in x for x in g.check_component(comp)[0]))

    def test_require_override_and_warning_only_cli(self):
        self.write("ui", ar=[("Chat", "Send", "Send"), *AR[1:]])
        self.assertEqual(g.main(["--root", str(self.root), "--require", "ui"]), 0)

    def test_cli(self):
        for c in g.REQUIRED:
            self.write(c)
        self.assertEqual(g.main(["--root", str(self.root)]), 0)
        self.write("lock", ar=AR[1:])
        self.assertEqual(g.main(["--root", str(self.root)]), 1)


if __name__ == "__main__":
    unittest.main()
