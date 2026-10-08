#!/usr/bin/env python3
"""ctest <component>_strings_wrapped: no bare UI text in QML or C++ sources.

QML: a string literal that looks like UI text (a letter plus a space, or a
capitalised word, or an ellipsis) must be the first argument of qsTr(...) or
the second of qsTranslate("Ctx", ...). C++: a u"..."_s or QStringLiteral("...")
that looks like a sentence (capital + lowercase letter, then a space) must be
tr("...") / QCoreApplication::translate(...) instead. A line ending in
"// i18n: ignore" is exempt. Lines with objectName, import, console. and
format-only literals (HH:mm, dddd, d MMMM) are exempt.
"""
import argparse
import os
import re
import sys

FORMAT_ONLY = re.compile(r"^[dMyHhmsaAP ,:.\-،]+$")
SVG_PATH = re.compile(r"^[MmLlHhVvCcSsQqTtAaZz][0-9MmLlHhVvCcSsQqTtAaZz .,\-]*$")  # Icons.qml path data
QML_SKIP = ("objectName", "import ", "console.", "textRole", "valueRole", "sequence:", "font.family")
CPP_LITERAL = re.compile(r'u"((?:[^"\\]|\\.)*)"_s|QStringLiteral\("((?:[^"\\]|\\.)*)"\)')


def literals(line):
    """(start, text) of each "..." or '...' literal; stops at a // comment."""
    out, i, n = [], 0, len(line)
    while i < n:
        c = line[i]
        if c == "/" and i + 1 < n and line[i + 1] == "/":
            break
        if c in "\"'":
            j, buf = i + 1, []
            while j < n and line[j] != c:
                if line[j] == "\\" and j + 1 < n:
                    buf.append(line[j + 1])
                    j += 2
                    continue
                buf.append(line[j])
                j += 1
            out.append((i, "".join(buf)))
            i = j + 1
            continue
        i += 1
    return out


def looks_like_ui_qml(text):
    if not re.search(r"[A-Za-z؀-ۿ]", text) or FORMAT_ONLY.match(text):
        return False
    if SVG_PATH.match(text) and re.search(r"\d", text):
        return False
    return " " in text.strip() or re.match(r"^[A-Z][a-z]", text) is not None or text.endswith("…")


def wrapped(prefix):
    p = prefix.rstrip()
    return p.endswith("qsTr(") or p.endswith("qsTrId(") or p.endswith("QT_TR_NOOP(") or \
        re.search(r'qsTranslate\(\s*["\'][^"\']*["\']\s*,$', p) is not None or \
        re.search(r'QT_TRANSLATE_NOOP\(\s*"[^"]*"\s*,$', p) is not None


def lint_qml(root, problems):
    for dirpath, _, files in os.walk(root):
        for name in sorted(files):
            if not name.endswith(".qml"):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8") as f:
                for no, line in enumerate(f, 1):
                    stripped = line.strip()
                    if stripped.startswith("//") or stripped.endswith("// i18n: ignore"):
                        continue
                    if any(s in line for s in QML_SKIP):
                        continue
                    for start, text in literals(line):
                        if looks_like_ui_qml(text) and not wrapped(line[:start]):
                            problems.append(f"{path}:{no}: bare UI text {text!r} — use qsTr()")


def lint_cpp(root, problems):
    for dirpath, _, files in os.walk(root):
        for name in sorted(files):
            if not name.endswith((".cpp", ".h")):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8") as f:
                for no, line in enumerate(f, 1):
                    if line.rstrip().endswith("// i18n: ignore") or line.lstrip().startswith("//"):
                        continue
                    for m in CPP_LITERAL.finditer(line):
                        text = m.group(1) if m.group(1) is not None else m.group(2)
                        if text.startswith("^"):
                            continue
                        if re.match(r"^[A-Z][a-z'’]", text) and " " in text:
                            problems.append(f"{path}:{no}: bare UI text {text!r} — use tr()")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--qml", nargs="*", default=[])
    p.add_argument("--cpp", nargs="*", default=[])
    a = p.parse_args()
    problems = []
    for d in a.qml:
        lint_qml(d, problems)
    for d in a.cpp:
        lint_cpp(d, problems)
    for line in problems:
        print(line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
