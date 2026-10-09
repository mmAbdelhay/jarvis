#!/usr/bin/env python3
"""Fill a Qt .ts file from a reviewed TSV table (source<TAB>translation).

--lang en: plain entries get translation = source; numerus entries need a TSV
row with two forms "singular || plural". --lang ar: every entry needs a row;
numerus rows carry six forms (zero || one || two || few || many || other).
Entries already finished keep their translation unless --force. Exits 1 and
lists every source still unfinished.
"""
import argparse
import sys
import xml.etree.ElementTree as ET


def unescape(text):
    return text.replace("\\t", "\t").replace("\\n", "\n")


def read_tsv(path):
    table = {}
    if not path:
        return table
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if "\t" not in line:
                sys.exit(f"bad TSV line (no tab): {line!r}")
            source, translation = line.split("\t", 1)
            table[unescape(source)] = [unescape(f.strip()) for f in translation.split(" || ")] \
                if " || " in translation else [unescape(translation)]
    return table


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--ts", required=True)
    p.add_argument("--lang", required=True, choices=["en", "ar"])
    p.add_argument("--tsv")
    p.add_argument("--force", action="store_true")
    a = p.parse_args()

    table = read_tsv(a.tsv)
    tree = ET.parse(a.ts)
    missing = []
    for msg in tree.getroot().iter("message"):
        source = msg.findtext("source", default="")
        numerus = msg.get("numerus") == "yes"
        tr = msg.find("translation")
        if tr is None:
            tr = ET.SubElement(msg, "translation")
        done = tr.get("type") is None and (
            all((f.text or "").strip() for f in tr.findall("numerusform")) if numerus else (tr.text or "").strip())
        if done and not a.force:
            continue
        forms = table.get(source)
        if forms is None and a.lang == "en" and not numerus:
            forms = [source]
        if forms is None or (numerus and len(forms) != (2 if a.lang == "en" else 6)):
            missing.append(source)
            continue
        for child in list(tr):
            tr.remove(child)
        tr.attrib.pop("type", None)
        if numerus:
            tr.text = None
            for form in forms:
                ET.SubElement(tr, "numerusform").text = form
        else:
            tr.text = forms[0]

    ET.indent(tree, space="    ")
    with open(a.ts, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE TS>\n')
        f.write(ET.tostring(tree.getroot(), encoding="unicode"))
        f.write("\n")
    for source in missing:
        print(f"untranslated: {source}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
