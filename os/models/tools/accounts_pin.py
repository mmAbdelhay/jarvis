#!/usr/bin/env python3
"""Re-pin one account CLI: accounts_pin.py <account> <version> [--write].

Reads integrity (and the linux-x64 platform package's) from the npm registry
with `npm view`, refuses versions younger than 7 days, prints the new row, and
with --write rewrites os/models/accounts.json in place.
"""
import argparse
import datetime
import json
import os
import subprocess
import sys
import importlib.util

validator_spec = importlib.util.spec_from_file_location(
    "accounts_validator", os.path.join(os.path.dirname(__file__), "..", "tests", "test_accounts.py")
)
validator = importlib.util.module_from_spec(validator_spec)
validator_spec.loader.exec_module(validator)

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, "..", "accounts.json")
MIN_AGE = datetime.timedelta(days=7)


def npm_view(spec, field):
    out = subprocess.run(["npm", "view", spec, field, "--json"], check=True, capture_output=True, text=True)
    return json.loads(out.stdout) if out.stdout.strip() else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("account", choices=["claude", "chatgpt", "gemini", "copilot"])
    p.add_argument("version")
    p.add_argument("--write", action="store_true")
    args = p.parse_args()
    if not validator.VERSION.fullmatch(args.version):
        sys.exit("version must be an exact x.y.z")
    with open(PATH, encoding="utf-8") as f:
        doc = json.load(f)
    row = next(r for r in doc["accounts"] if r["account"] == args.account)
    spec = f'{row["package"]}@{args.version}'
    published = npm_view(row["package"], "time").get(args.version)
    if not published:
        sys.exit(f"{spec} is not published")
    age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(published.replace("Z", "+00:00"))
    if age < MIN_AGE:
        sys.exit(f"{spec} is only {age.days} days old; pins need at least {MIN_AGE.days}")
    row["version"] = args.version
    row["integrity"] = npm_view(spec, "dist.integrity")
    plat = row.get("platformPackage")
    if plat:
        optional = npm_view(spec, "optionalDependencies") or {}
        target = optional.get(plat["name"])
        if target is None:
            sys.exit(f"{spec} no longer lists {plat['name']}")
        plat_spec = target[4:] if target.startswith("npm:") else f'{plat["name"]}@{target}'
        if plat_spec.rsplit("@", 1)[0] != plat["name"]:
            sys.exit(f"{spec} redirects {plat['name']} to a foreign package")
        plat["version"] = plat_spec.rsplit("@", 1)[1]
        plat["integrity"] = npm_view(plat_spec, "dist.integrity")
    problems = validator.validate_accounts(doc)
    if problems:
        sys.exit("; ".join(problems))
    print(json.dumps(row, indent=2))
    if args.write:
        with open(PATH, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.write("\n")


if __name__ == "__main__":
    main()
