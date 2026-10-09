"""ctest i18n_tools: the CI-gate scripts behave (Rafiq M4 contracts §3)."""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.dirname(HERE)


def run(script, *args):
    return subprocess.run([sys.executable, os.path.join(TOOLS, script), *args],
                          capture_output=True, text=True)


def ts(lang, messages):
    body = []
    for ctx, source, translation, attrs in messages:
        numerus = isinstance(translation, list)
        tr_attr = f' type="{attrs}"' if attrs else ""
        if numerus:
            forms = "".join(f"<numerusform>{f}</numerusform>" for f in translation)
            tr = f"<translation{tr_attr}>{forms}</translation>"
        else:
            tr = f"<translation{tr_attr}>{translation}</translation>"
        num = ' numerus="yes"' if numerus else ""
        body.append(f"<context><name>{ctx}</name><message{num}><source>{source}</source>{tr}</message></context>")
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE TS>\n'
            f'<TS version="2.1" language="{lang}" sourcelanguage="en">{"".join(body)}</TS>\n')


class Tmp:
    def __init__(self):
        self.dir = tempfile.TemporaryDirectory()

    def write(self, name, text):
        path = os.path.join(self.dir.name, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path


AR6 = ["%n أ", "أ", "أأ", "%n ب", "%n ج", "%n د"]


class CheckTs(unittest.TestCase):
    def test_complete_pair_passes(self):
        t = Tmp()
        en = t.write("en.ts", ts("en", [("A", "Save %1", "Save %1", None),
                                         ("A", "%n things", ["%n thing", "%n things"], None)]))
        ar = t.write("ar.ts", ts("ar", [("A", "Save %1", "احفظ %1", None), ("A", "%n things", AR6, None)]))
        r = run("check_ts.py", "--component", "x", "--en", en, "--ar", ar)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_unfinished_empty_and_missing_keys_fail(self):
        t = Tmp()
        en = t.write("en.ts", ts("en", [("A", "One", "One", None), ("A", "Two", "Two", None)]))
        ar = t.write("ar.ts", ts("ar", [("A", "One", "", "unfinished"), ("A", "Three", "ثلاثة", None)]))
        r = run("check_ts.py", "--component", "x", "--en", en, "--ar", ar)
        self.assertEqual(r.returncode, 1)
        self.assertIn("unfinished", r.stdout)
        self.assertIn("'Two'", r.stdout)     # in en, not in ar
        self.assertIn("'Three'", r.stdout)   # in ar, not in en

    def test_lost_placeholder_and_wrong_plural_count_fail(self):
        t = Tmp()
        en = t.write("en.ts", ts("en", [("A", "Save %1", "Save %1", None),
                                         ("A", "%n things", ["%n thing", "%n things"], None)]))
        ar = t.write("ar.ts", ts("ar", [("A", "Save %1", "احفظ", None), ("A", "%n things", ["a", "b"], None)]))
        r = run("check_ts.py", "--component", "x", "--en", en, "--ar", ar)
        self.assertEqual(r.returncode, 1)
        self.assertIn("%1", r.stdout)
        self.assertIn("6 forms", r.stdout)


class TsFill(unittest.TestCase):
    def test_fills_arabic_from_tsv_and_reports_missing(self):
        t = Tmp()
        ar = t.write("ar.ts", ts("ar", [("A", "Save", "", "unfinished"), ("A", "Load", "", "unfinished"),
                                         ("A", "%n things", ["", "", "", "", "", ""], "unfinished")]))
        tsv = t.write("ar.tsv", "# comment\nSave\tاحفظ\n%n things\t" + " || ".join(AR6) + "\n")
        r = run("ts_fill.py", "--ts", ar, "--lang", "ar", "--tsv", tsv)
        self.assertEqual(r.returncode, 1)
        self.assertIn("Load", r.stdout)
        text = open(ar, encoding="utf-8").read()
        self.assertIn("احفظ", text)
        self.assertIn("<numerusform>%n د</numerusform>", text)

    def test_english_copies_sources(self):
        t = Tmp()
        en = t.write("en.ts", ts("en", [("A", "Save", "", "unfinished"),
                                         ("A", "%n things", ["", ""], "unfinished")]))
        tsv = t.write("en.tsv", "%n things\t%n thing || %n things\n")
        r = run("ts_fill.py", "--ts", en, "--lang", "en", "--tsv", tsv)
        self.assertEqual(r.returncode, 0, r.stdout)
        text = open(en, encoding="utf-8").read()
        self.assertIn("<translation>Save</translation>", text)
        self.assertNotIn("unfinished", text)


class LintStrings(unittest.TestCase):
    def test_flags_bare_qml_text_and_accepts_wrapped(self):
        t = Tmp()
        t.write("q/A.qml", "\n".join([
            'import QtQuick',
            'Item {',
            '    objectName: "Not UI"',
            '    property string a: qsTr("Wrapped text")',
            '    property string b: "Bare text"',
            '    property string c: "HH:mm"',
            '    property string d: "transparent"',
            '    property string e: "Ignored text" // i18n: ignore',
            '    property string f: qsTranslate("Ctx", "Also wrapped")',
            '    property string g: "https://example.org/a b" + "x"',
            '    Accessible.name: "Log in"',
            '    readonly property string logo: "M3 12a9 9 0 1 0 18 0 M8 12h8"',
            '    property string chat: "Chat"',
            '}']))
        r = run("lint_strings.py", "--qml", os.path.join(t.dir.name, "q"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("Bare text", r.stdout)
        self.assertIn("Log in", r.stdout)
        self.assertIn("https://example.org/a b", r.stdout)
        self.assertIn("'Chat'", r.stdout)          # a word made of SVG letters is still text
        self.assertNotIn("M3 12a9", r.stdout)      # icon path data is not
        for ok in ("Not UI", "Wrapped text", "HH:mm", "transparent", "Ignored text", "Also wrapped"):
            self.assertNotIn(ok, r.stdout)

    def test_flags_sentence_literals_in_cpp(self):
        t = Tmp()
        t.write("c/a.cpp", "\n".join([
            'auto a = u"Couldn\'t save the provider."_s;',
            'auto b = QStringLiteral("Lost the connection");',
            'auto c = u"provider:list"_s;',
            'auto d = tr("Already wrapped.");',
            'auto e = u"IBM Plex Sans"_s;',
            'auto f = u"Debug text here."_s; // i18n: ignore',
            'auto g = u"^[A-Z][a-z]+ x$"_s;']))
        r = run("lint_strings.py", "--cpp", os.path.join(t.dir.name, "c"))
        self.assertEqual(r.returncode, 1)
        self.assertIn("Couldn't save the provider.", r.stdout)
        self.assertIn("Lost the connection", r.stdout)
        for ok in ("provider:list", "Already wrapped", "IBM Plex Sans", "Debug text", "^[A-Z]"):
            self.assertNotIn(ok, r.stdout)

    def test_clean_tree_passes(self):
        t = Tmp()
        t.write("q/A.qml", 'Item { property string a: qsTr("Fine") }\n')
        self.assertEqual(run("lint_strings.py", "--qml", os.path.join(t.dir.name, "q")).returncode, 0)


if __name__ == "__main__":
    unittest.main()
