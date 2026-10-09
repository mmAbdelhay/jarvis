#!/usr/bin/env python3
"""CI gate (Rafiq M4 contracts §3) for one component's <component>/i18n/{en,ar}.ts.

Fails when: an entry is unfinished/vanished/obsolete or empty; a key is in one
file but not the other; a translation drops a %1..%9 placeholder; a numerus
entry has the wrong number of forms (en 2, ar 6); or, with --lupdate, the .ts
files are stale (a fresh lupdate over --sources finds different keys).
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

PLACEHOLDER = re.compile(r"%L?[1-9]")
FORMS = {"en": 2, "ar": 6}


def load(path):
    root = ET.parse(path).getroot()
    entries = {}
    for ctx in root.iter("context"):
        cname = ctx.findtext("name", default="")
        for msg in ctx.iter("message"):
            key = (cname, msg.findtext("source", default=""), msg.findtext("comment", default=""))
            tr = msg.find("translation")
            numerus = msg.get("numerus") == "yes"
            kind = tr.get("type", "") if tr is not None else "unfinished"
            if tr is None:
                forms = [""]
            elif numerus:
                forms = [(f.text or "") for f in tr.findall("numerusform")]
            else:
                forms = [tr.text or ""]
            entries[key] = (numerus, forms, kind)
    return entries


def show(key):
    ctx, source, comment = key
    return f"{ctx}: {source!r}" + (f" ({comment})" if comment else "")


def check_file(component, lang, entries, problems):
    for key, (numerus, forms, kind) in entries.items():
        if kind in ("unfinished", "vanished", "obsolete"):
            problems.append(f"{component} {lang}: {kind} entry {show(key)}")
        if any(not f.strip() for f in forms):
            problems.append(f"{component} {lang}: empty translation for {show(key)}")
        if numerus and len(forms) != FORMS[lang]:
            problems.append(f"{component} {lang}: {show(key)} needs {FORMS[lang]} forms, has {len(forms)}")
        wanted = set(PLACEHOLDER.findall(key[1]))
        for form in forms:
            missing = wanted - set(PLACEHOLDER.findall(form))
            if form.strip() and missing:
                problems.append(f"{component} {lang}: {show(key)} lost {', '.join(sorted(missing))} in {form!r}")


def fresh_keys(lupdate, sources):
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "fresh.ts")
        subprocess.run([lupdate, "-silent", "-locations", "none", "-source-language", "en",
                        "-target-language", "ar", *sources, "-ts", out], check=True,
                       stdout=subprocess.DEVNULL)
        return set(load(out).keys()) if os.path.exists(out) else set()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--component", required=True)
    p.add_argument("--en", required=True)
    p.add_argument("--ar", required=True)
    p.add_argument("--lupdate")
    p.add_argument("--sources", nargs="*", default=[])
    a = p.parse_args()

    problems = []
    for path in (a.en, a.ar):
        if not os.path.exists(path):
            print(f"{a.component}: missing {path}")
            return 1
    en, ar = load(a.en), load(a.ar)
    check_file(a.component, "en", en, problems)
    check_file(a.component, "ar", ar, problems)
    for key in sorted(set(en) - set(ar)):
        problems.append(f"{a.component}: {show(key)} is in en.ts but not in ar.ts")
    for key in sorted(set(ar) - set(en)):
        problems.append(f"{a.component}: {show(key)} is in ar.ts but not in en.ts")
    if a.lupdate and a.sources:
        fresh = fresh_keys(a.lupdate, a.sources)
        for key in sorted(fresh - set(ar)):
            problems.append(f"{a.component}: stale .ts — {show(key)} is in the sources but not translated "
                            f"(run os/ui/i18n/update-ts.sh)")
        for key in sorted(set(ar) - fresh):
            problems.append(f"{a.component}: stale .ts — {show(key)} is no longer in the sources")
    for line in problems:
        print(line)
    if not problems:
        print(f"{a.component}: {len(ar)} strings, en and ar complete")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
