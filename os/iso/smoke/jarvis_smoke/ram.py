"""Idle RAM (success criterion 2): MemTotal - MemAvailable, in MB.

Counts the live session's tmpfs overlay (a real cost of running live) but not
reclaimable page cache, close to the "used" column of `free`."""

from __future__ import annotations


def used_mb(meminfo: str) -> float:
    fields: dict[str, int] = {}
    for line in meminfo.splitlines():
        name, _, rest = line.partition(":")
        parts = rest.split()
        if parts:
            fields[name.strip()] = int(parts[0])
    if "MemTotal" not in fields or "MemAvailable" not in fields:
        raise ValueError("meminfo lacks MemTotal or MemAvailable")
    return (fields["MemTotal"] - fields["MemAvailable"]) / 1024


def verdict(used: float, warn_mb: int, fail_mb: int) -> str:
    if used > fail_mb:
        return "fail"
    if used > warn_mb:
        return "warn"
    return "ok"
