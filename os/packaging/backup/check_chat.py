#!/usr/bin/env python3
"""Ask the packaged backup model for a tool call through Ollama's /api/chat
(M4 contracts §1: the backup brain must call simple tools, in English and
Arabic). Tool names use underscores, as jarvisd offers them (M1 §6 #15)."""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:11434"
TOOLS = [
    {"type": "function", "function": {
        "name": "net_status",
        "description": "Check whether this computer is online: connectivity, Wi-Fi, DNS and the gateway.",
        "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {
        "name": "apps_open",
        "description": "Open an installed app by its id.",
        "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}}},
]
PROMPTS = {
    "en": "Is my internet connection working right now?",
    "ar": "هل اتصالي بالإنترنت يعمل الآن؟",
}


def call(path: str, body: dict | None = None, timeout: int = 900) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def normalise(tag: str) -> str:
    return tag if ":" in tag else tag + ":latest"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tag", required=True)
    tag = ap.parse_args().tag
    names = {normalise(m["name"]) for m in call("/api/tags")["models"]}
    ok = normalise(tag) in names
    print(f"{'ok  ' if ok else 'FAIL'} {tag} is in the local store ({sorted(names)})")
    failures = 0 if ok else 1
    for lang, prompt in PROMPTS.items():
        resp = call("/api/chat", {
            "model": tag, "stream": False, "think": False, "tools": TOOLS,
            "options": {"temperature": 0, "seed": 1},
            "messages": [
                {"role": "system", "content": "You are Jarvis, a helpful assistant. Use a tool when one fits."},
                {"role": "user", "content": prompt}],
        })
        calls = [c["function"]["name"] for c in resp.get("message", {}).get("tool_calls") or []]
        good = "net_status" in calls
        failures += 0 if good else 1
        print(f"{'ok  ' if good else 'FAIL'} {lang}: tool calls {calls}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
