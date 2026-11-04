"""
Observed mid-block (screen-line) counts, backend/data/observed_screenlines/*.json.

Each station is a road (usually a bridge) counted in both directions together,
with the OSM ways it is matched to, its peak hour and the source table. The
values are kept exactly as printed; files that fail validation are rejected.
"""

from __future__ import annotations

import json
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "observed_screenlines")
SCHEMA = "twincity.observed_screenline/v1"


def validate(doc: dict) -> list[str]:
    problems: list[str] = []
    if doc.get("schema") != SCHEMA:
        problems.append(f"schema must be {SCHEMA}")
    src = doc.get("source") or {}
    if not src.get("title") or not src.get("url") or not src.get("surveyYear"):
        problems.append("source needs title, url and surveyYear")
    stations = doc.get("stations")
    if not isinstance(stations, list) or not stations:
        problems.append("stations must be a non-empty list")
        return problems
    for i, s in enumerate(stations):
        where = f"stations[{i}]"
        if not s.get("id") or not s.get("name"):
            problems.append(f"{where}: id and name are required")
        ways = s.get("osmWays")
        if not isinstance(ways, list) or not ways or not all(isinstance(w, int) and w > 0 for w in ways):
            problems.append(f"{where}: osmWays must be positive integers")
        for k in ("peakVehicles", "peakPcu", "day12hVehicles"):
            v = s.get(k)
            if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                problems.append(f"{where}: {k} must be a non-negative integer")
        h = s.get("peakStartHour")
        if not isinstance(h, int) or not 0 <= h <= 23:
            problems.append(f"{where}: peakStartHour must be 0-23")
        if not isinstance(s.get("comparable"), bool):
            problems.append(f"{where}: comparable must be true or false")
    return problems


def list_files() -> list[str]:
    if not os.path.isdir(DATA_DIR):
        return []
    return sorted(f[:-5] for f in os.listdir(DATA_DIR) if f.endswith(".json"))


def load(file_id: str) -> dict:
    if file_id not in list_files():
        raise KeyError(file_id)
    with open(os.path.join(DATA_DIR, f"{file_id}.json"), encoding="utf-8") as f:
        doc = json.load(f)
    problems = validate(doc)
    if problems:
        raise ValueError("; ".join(problems))
    return doc
