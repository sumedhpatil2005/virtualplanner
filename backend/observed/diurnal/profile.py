"""
Hour-of-day traffic profile (backend/data/diurnal/*.json).

The file is produced by build_profile.py from cited sources and states, per
hour, the share of daily traffic, its Peak/Moderate/Low label and whether the
hour was measured or filled. This module only loads and checks it; it never
fills or smooths anything.
"""
from __future__ import annotations

import json
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data", "diurnal")
PERIODS = ("Peak", "Moderate", "Low")


def validate(doc: dict) -> list[str]:
    problems: list[str] = []
    if doc.get("id") != "pune_hourly_profile":
        problems.append("id must be pune_hourly_profile")
    if not doc.get("sources"):
        problems.append("no sources cited")
    for daytype in ("weekday", "weekend"):
        d = doc.get(daytype)
        if not isinstance(d, dict):
            problems.append(f"{daytype} missing")
            continue
        hours = d.get("hours", [])
        if [h.get("hour") for h in hours] != list(range(24)):
            problems.append(f"{daytype}: hours must be 0..23 in order")
            continue
        total = sum(h.get("share", 0) for h in hours)
        if abs(total - 1) > 1e-3:
            problems.append(f"{daytype}: shares sum to {total:.4f}, not 1")
        for h in hours:
            if not (isinstance(h.get("share"), (int, float)) and h["share"] >= 0):
                problems.append(f"{daytype} {h['hour']}: share must be >= 0")
            if h.get("period") not in PERIODS:
                problems.append(f"{daytype} {h['hour']}: period must be one of {PERIODS}")
            if not isinstance(h.get("measured"), bool) or not h.get("source"):
                problems.append(f"{daytype} {h['hour']}: measured flag and source are required")
    return problems


def load(profile_id: str = "pune_hourly_profile_v1") -> dict:
    path = os.path.join(DATA_DIR, f"{profile_id}.json")
    if not os.path.isfile(path):
        raise KeyError(profile_id)
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    problems = validate(doc)
    if problems:
        raise ValueError("; ".join(problems))
    return doc


def hour_factor(doc: dict, hour: int, reference_hour: int, daytype: str = "weekday") -> float:
    """Demand at `hour` relative to `reference_hour` (the hour the counts were taken)."""
    hours = doc[daytype]["hours"]
    ref = hours[reference_hour % 24]["share"]
    return hours[hour % 24]["share"] / ref if ref > 0 else 0.0
