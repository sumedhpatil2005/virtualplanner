"""
Observed traffic count files (backend/data/observed_counts/*.json).

A count file holds counts taken at real junctions, with the publication they
were taken from, the survey period and the units. This module reads a file,
checks it (every movement value is a non-negative integer, every junction has
a location and four-way approach/turn keys, every source is cited) and adds
derived totals: vehicles and PCU per movement, per approach and per junction,
using the PCU factors the file itself states.

Validation never repairs data. A file that fails is rejected with the list of
problems; a published table that does not add up is kept as printed and its
discrepancy is carried in the junction's notes.
"""

from __future__ import annotations

import json
import os
from typing import Any

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "observed_counts")
SCHEMA = "twincity.observed_counts/v1"
APPROACHES = ("N", "S", "E", "W")
TURNS = ("left", "straight", "right")
CLASSES = ("LV", "HV", "TW")


class CountFileError(ValueError):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def _is_count(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def validate(doc: dict) -> list[str]:
    """Problems with a count file (empty when it is valid)."""
    p: list[str] = []
    if doc.get("schema") != SCHEMA:
        p.append(f"schema must be {SCHEMA!r}")
    for key in ("dataset_id", "version", "title", "sources", "survey", "units", "pcu", "junctions"):
        if key not in doc:
            p.append(f"missing {key}")
    if p:
        return p
    if doc.get("data_source_type") not in ("observed", "survey"):
        p.append("data_source_type must be 'observed' or 'survey'")
    if not doc["sources"]:
        p.append("at least one source is required")
    for i, s in enumerate(doc["sources"]):
        if not s.get("citation") or not (s.get("doi") or s.get("url")):
            p.append(f"sources[{i}] needs a citation and a DOI or URL")
    if doc["units"].get("count") != "veh/h":
        p.append("units.count must be 'veh/h'")
    factors = doc["pcu"].get("factors", {})
    for c in CLASSES:
        f = factors.get(c)
        if not isinstance(f, (int, float)) or f <= 0:
            p.append(f"pcu.factors.{c} must be a positive number")
    if not doc["pcu"].get("standard"):
        p.append("pcu.standard must name the standard the factors come from")
    seen: set[str] = set()
    for j in doc["junctions"]:
        jid = j.get("id", "?")
        if jid in seen:
            p.append(f"duplicate junction id {jid}")
        seen.add(jid)
        if not j.get("name"):
            p.append(f"{jid}: missing name")
        loc = j.get("location") or {}
        if not (isinstance(loc.get("lon"), (int, float)) and isinstance(loc.get("lat"), (int, float))
                and -180 <= loc["lon"] <= 180 and -90 <= loc["lat"] <= 90):
            p.append(f"{jid}: location needs lon/lat")
        elif not loc.get("method"):
            p.append(f"{jid}: location.method must say how it was found")
        keys: set[tuple[str, str]] = set()
        for m in j.get("movements", []):
            k = (m.get("approach"), m.get("turn"))
            if k[0] not in APPROACHES or k[1] not in TURNS:
                p.append(f"{jid}: bad movement key {k}")
                continue
            if k in keys:
                p.append(f"{jid}: duplicate movement {k}")
            keys.add(k)
            for c in CLASSES:
                if c in m and not _is_count(m[c]):
                    p.append(f"{jid} {k[0]} {k[1]}: {c} must be a non-negative integer, got {m[c]!r}")
            if not any(c in m for c in CLASSES):
                p.append(f"{jid} {k[0]} {k[1]}: no class counts")
        if not keys:
            p.append(f"{jid}: no movements")
    return p


def movement_totals(m: dict, factors: dict) -> tuple[int, float]:
    """(vehicles per hour, PCU per hour) for one movement. Missing classes count as absent, not zero-filled."""
    veh = sum(m[c] for c in CLASSES if c in m)
    pcu = sum(m[c] * factors[c] for c in CLASSES if c in m)
    return veh, round(pcu, 2)


def enrich(doc: dict) -> dict:
    """The file with derived totals added (a copy; the input is untouched)."""
    out = json.loads(json.dumps(doc))
    factors = out["pcu"]["factors"]
    for j in out["junctions"]:
        jveh, jpcu = 0, 0.0
        by_approach: dict[str, dict] = {}
        for m in j["movements"]:
            veh, pcu = movement_totals(m, factors)
            m["veh"], m["pcu"] = veh, pcu
            a = by_approach.setdefault(m["approach"], {"veh": 0, "pcu": 0.0})
            a["veh"] += veh
            a["pcu"] = round(a["pcu"] + pcu, 2)
            jveh += veh
            jpcu += pcu
        j["totals"] = {"veh": jveh, "pcu": round(jpcu, 2), "by_approach": by_approach,
                       "matches_published_total": j.get("published_total_veh") == jveh}
    return out


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    problems = validate(doc)
    if problems:
        raise CountFileError(problems)
    return enrich(doc)


def list_datasets(data_dir: str = DATA_DIR) -> list[dict]:
    out = []
    if not os.path.isdir(data_dir):
        return out
    for name in sorted(os.listdir(data_dir)):
        if not name.endswith(".json"):
            continue
        try:
            doc = load(os.path.join(data_dir, name))
        except (CountFileError, json.JSONDecodeError) as e:
            out.append({"file": name, "valid": False, "error": str(e)})
            continue
        lons = [j["location"]["lon"] for j in doc["junctions"]]
        lats = [j["location"]["lat"] for j in doc["junctions"]]
        out.append({"file": name, "valid": True, "dataset_id": doc["dataset_id"], "version": doc["version"],
                    "title": doc["title"], "data_source_type": doc["data_source_type"], "junctions": len(doc["junctions"]),
                    "bbox": [min(lons), min(lats), max(lons), max(lats)]})
    return out


def load_dataset(dataset_id: str, data_dir: str = DATA_DIR) -> dict:
    for entry in list_datasets(data_dir):
        if entry.get("valid") and entry["dataset_id"] == dataset_id:
            return load(os.path.join(data_dir, entry["file"]))
    raise KeyError(dataset_id)
