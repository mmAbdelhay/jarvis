#!/usr/bin/env python3
"""i18n gate for the Qt components (M4 contracts §3).

Every component keeps <component>/i18n/en.ts and ar.ts. The gate fails when a
message exists in one language but not the other, when an entry is unfinished
or empty, when a plural lacks its forms (en 2, ar 6), when a translation drops
a %1-style placeholder, or when <TS language> does not match the file name.
Messages lupdate marked vanished or obsolete are ignored (never shown).
Warnings (an Arabic translation with no Arabic letters) never fail.

  i18n_gate.py [--root OS_DIR] [--require shell,installer,...]
"""
from __future__ import annotations

import argparse
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

REQUIRED = ("shell", "installer", "greeter", "lock", "classic")
LANGS = ("en", "ar")
NUMERUS_FORMS = {"en": 2, "ar": 6}
PLACEHOLDER = re.compile(r"%L?[1-9][0-9]?|%n")
ARABIC = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]")
LETTER = re.compile(r"[A-Za-z]")
DEFAULT_ROOT = Path(__file__).resolve().parents[2]  # os/

Key = tuple[str, str, str]


@dataclass
class Message:
    source: str
    forms: list[str]
    numerus: bool
    unfinished: bool
    where: str


@dataclass
class TsFile:
    language: str
    messages: dict[Key, Message] = field(default_factory=dict)


def parse_ts(path: Path) -> TsFile:
    root = ET.parse(path).getroot()
    if root.tag != "TS":
        raise ValueError("not a Qt .ts file")
    ts = TsFile(language=root.get("language", ""))
    for ctx in root.iter("context"):
        cname = ctx.findtext("name", "")
        for msg in ctx.findall("message"):
            tr = msg.find("translation")
            kind = "unfinished" if tr is None else tr.get("type", "")
            if kind in ("vanished", "obsolete"):
                continue
            numerus = msg.get("numerus") == "yes"
            if tr is None:
                forms = []
            elif numerus:
                forms = [f.text or "" for f in tr.findall("numerusform")]
            else:
                forms = [tr.text or ""]
            source = msg.findtext("source", "")
            loc = msg.find("location")
            where = f"{loc.get('filename')}:{loc.get('line')}" if loc is not None else cname
            key: Key = ("id", msg.get("id", ""), "") if msg.get("id") else (cname, source, msg.findtext("comment", ""))
            ts.messages[key] = Message(source, forms, numerus, kind == "unfinished", where)
    return ts


def holders(text: str, numerus: bool = False) -> list[str]:
    return sorted(p for p in PLACEHOLDER.findall(text) if not (numerus and p == "%n"))


def describe(key: Key) -> str:
    text = key[1] if len(key[1]) <= 50 else key[1][:47] + "..."
    return f'"{text}" [{key[0]}]'


def check_component(comp: Path) -> tuple[list[str], list[str]]:
    name = comp.name
    problems: list[str] = []
    warnings: list[str] = []
    parsed: dict[str, TsFile] = {}
    for lang in LANGS:
        path = comp / "i18n" / f"{lang}.ts"
        if not path.is_file():
            problems.append(f"{name}: missing i18n/{lang}.ts")
            continue
        try:
            parsed[lang] = parse_ts(path)
        except (ET.ParseError, ValueError) as e:
            problems.append(f"{name}: i18n/{lang}.ts: {e}")
    if len(parsed) != len(LANGS):
        return problems, warnings
    for lang, ts in parsed.items():
        if ts.language.split("_")[0] != lang:
            problems.append(f"{name}: i18n/{lang}.ts declares language {ts.language!r}")
    en, ar = parsed["en"].messages, parsed["ar"].messages
    for key in sorted(en.keys() - ar.keys()):
        problems.append(f"{name}: {describe(key)} has en but no ar")
    for key in sorted(ar.keys() - en.keys()):
        problems.append(f"{name}: {describe(key)} has ar but no en")
    for lang, ts in parsed.items():
        for key, m in sorted(ts.messages.items()):
            label = f"{name}: {lang}: {describe(key)} ({m.where})"
            if m.unfinished:
                problems.append(f"{label} is unfinished")
                continue
            want = NUMERUS_FORMS[lang] if m.numerus else 1
            if len(m.forms) != want:
                problems.append(f"{label} has {len(m.forms)} forms, {lang} needs {want}")
            if any(not f.strip() for f in m.forms):
                problems.append(f"{label} has an empty translation")
            for f in m.forms:
                if holders(f, m.numerus) != holders(m.source, m.numerus):
                    problems.append(f"{label}: placeholders {holders(f, m.numerus)} differ from the source's {holders(m.source, m.numerus)}")
            if lang == "ar" and LETTER.search(m.source) and not any(ARABIC.search(f) for f in m.forms):
                warnings.append(f"{label}: Arabic translation has no Arabic letters")
    return problems, warnings


def check_tree(root: Path, required=REQUIRED) -> tuple[list[str], list[str]]:
    problems: list[str] = []
    warnings: list[str] = []
    for name in required:
        if not (root / name / "i18n").is_dir():
            problems.append(f"{name}: no i18n/ directory (M4 contracts §3: {name}/i18n/{{en,ar}}.ts)")
    for comp in sorted(p.parent for p in root.glob("*/i18n") if p.is_dir()):
        p, w = check_component(comp)
        problems += p
        warnings += w
    return problems, warnings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="directory holding the components (os/)")
    ap.add_argument("--require", default=",".join(REQUIRED))
    a = ap.parse_args(argv)
    required = tuple(x for x in a.require.split(",") if x)
    problems, warnings = check_tree(a.root, required)
    for w in warnings:
        print(f"i18n: warning: {w}")
    for p in problems:
        print(f"i18n: {p}", file=sys.stderr)
    if problems:
        return 1
    print(f"i18n: ok ({len(list(a.root.glob('*/i18n')))} components)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
