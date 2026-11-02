"""
Local network-correction layers (backend/data/network_corrections/*.json):
documented fixes to imported OpenStreetMap roads, applied by the simulator on
top of the OSM data. OpenStreetMap itself is never edited.
"""
from __future__ import annotations

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "network_corrections"
SCHEMA = "twincity.network_corrections/v1"
ACTIONS = {"reverse", "set_two_way", "set_oneway", "set_lanes", "set_roundabout"}
CONFIDENCE = {"high", "medium", "low"}


def validate(layer: dict) -> list[str]:
    """Problems with a layer (empty when it is valid)."""
    problems: list[str] = []
    if layer.get("schema") != SCHEMA:
        problems.append(f"schema must be {SCHEMA}")
    for key in ("id", "version", "osm_snapshot"):
        if not layer.get(key):
            problems.append(f"missing {key}")
    seen: set[str] = set()
    for c in layer.get("corrections", []):
        cid = c.get("id")
        if not cid or cid in seen:
            problems.append(f"correction id missing or repeated: {cid!r}")
        seen.add(cid)
        if not isinstance(c.get("osm_way_id"), int):
            problems.append(f"{cid}: osm_way_id must be an integer OSM way id")
        if c.get("action") not in ACTIONS:
            problems.append(f"{cid}: unknown action {c.get('action')!r}")
        if not c.get("evidence"):
            problems.append(f"{cid}: no evidence")
        if c.get("confidence") not in CONFIDENCE:
            problems.append(f"{cid}: confidence must be one of {sorted(CONFIDENCE)}")
        if not c.get("proposed_osm_edit"):
            problems.append(f"{cid}: no proposed OSM edit")
        params = c.get("params") or {}
        if c.get("action") == "set_lanes" and not (isinstance(params.get("lanes"), int) and params["lanes"] >= 1):
            problems.append(f"{cid}: set_lanes needs an integer params.lanes >= 1")
        if c.get("action") == "set_two_way" and not all(isinstance(params.get(k), int) and params[k] >= 1 for k in ("lanes_forward", "lanes_backward")):
            problems.append(f"{cid}: set_two_way needs lanes_forward and lanes_backward")
    return problems


def list_layers() -> list[dict]:
    out = []
    for path in sorted(DATA_DIR.glob("*.json")):
        layer = json.loads(path.read_text(encoding="utf-8"))
        out.append({"id": layer.get("id"), "version": layer.get("version"), "title": layer.get("title"), "corrections": len(layer.get("corrections", []))})
    return out


def load(layer_id: str) -> dict:
    for path in DATA_DIR.glob("*.json"):
        layer = json.loads(path.read_text(encoding="utf-8"))
        if layer.get("id") == layer_id:
            problems = validate(layer)
            if problems:
                raise ValueError("; ".join(problems))
            return layer
    raise KeyError(layer_id)
