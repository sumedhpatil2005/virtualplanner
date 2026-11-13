"""
/api/infra — municipal infrastructure layers (PMC via OpenCity) and the merged buildings layer for Explore, read from the
spatial index (datasets/infra_store.py). bbox-limited, capped; every response carries source / date / licence / class.
Also: the Census 2011 ward table (listed, not mappable) and the traffic-count availability statement (no official counts).
docs/urbanos/INFRASTRUCTURE_DATA.md.
"""
from __future__ import annotations

import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from datasets import infra_store as IS
from datasets.vocab import PUNE_BBOX, data_root

router = APIRouter(prefix="/infra", tags=["infrastructure"])

GROUP_ORDER = ["Municipal infrastructure (PMC via OpenCity)", "Buildings (OSM + Microsoft + Google)"]
MAX_BBOX_DEG2 = 0.25 * 0.25   # a request larger than ~27 km × 27 km is refused for dense layers (zoom in)
DENSE = {"buildings", "sewer", "revenue_parcels", "road_centreline", "swd_chambers"}

TRAFFIC_COUNTS = {
    "status": "none_from_official_sources",
    "label": "Traffic counts: none from official sources",
    "detail": ("No official, openly published traffic-count dataset for Pune was found (government data search, 2026-11-13; "
               "PUNE_DATA_AVAILABILITY.md). None are invented. The PMC open-data portal lists 'PMC Traffic Details' (dataset 431, xlsx; "
               "contents UNKNOWN), but each download needs a purpose form with a CAPTCHA: registered as RESTRICTED, not accessed. "
               "Counts the simulator reads are research transcriptions (6 junctions, NICMAR 2025; 8 CCTV cameras, Mendeley 2023; "
               "CMP 2008 screen line) — the model still FAILS TAG M3.1."),
    "collection_plan": "docs/urbanos/MISSING_DATA_AND_COLLECTION_PLAN.md",
    "restricted_sources": [{"id": "pmc_portal_traffic_details", "name": "PMC open-data portal — 'PMC Traffic Details' (id 431, xlsx)",
                            "access": "restricted (CAPTCHA purpose form)", "url": "https://opendata.pmc.gov.in",
                            "note": "Contents UNKNOWN. Not accessed: UrbanOS never bypasses CAPTCHAs or logins; a person can download it via the form (plan §2.7)."}],
}


def _census_path() -> Optional[str]:
    for r in [os.environ.get("URBANOS_DATA_DIR"), os.environ.get("URBANOS_DATA_ROOT"), data_root()]:
        if not r:
            continue
        base = os.path.join(r, "derived", "census2011_pune_wards")
        if os.path.isdir(base):
            for v in sorted(os.listdir(base), reverse=True):
                f = os.path.join(base, v, "census2011_pune_wards.json")
                if os.path.exists(f):
                    return f
    return None


def census_summary(full: bool = False) -> dict:
    p = _census_path()
    if p is None:
        return {"available": False, "mappable": False, "reason": "Census 2011 ward table not derived (python -m datasets.pipelines.census2011_wards)."}
    d = json.load(open(p, encoding="utf-8"))
    out = {"available": True, "title": d["title"], "vintage": d["vintage"], "mappable": d["mappable"], "not_mappable_reasons": d["not_mappable_reasons"],
           "wards": len(d["rows"]), "total_population": d["total_population"], "source": d["source"], "data_class": "observed",
           "suitability": "screening", "historical": True, "duplicate_ward_numbers": d.get("duplicate_ward_numbers", {})}
    offices: dict[str, dict] = {}
    for r in d["rows"]:
        o = offices.setdefault(r["ward_office"], {"ward_office": r["ward_office"], "wards": 0, "population": 0, "households": 0})
        o["wards"] += 1
        o["population"] += r.get("population", 0)
        o["households"] += r.get("households", 0)
    out["by_ward_office"] = sorted(offices.values(), key=lambda x: x["ward_office"])
    if full:
        out["rows"] = d["rows"]
    return out


@router.get("/status")
def infra_status():
    return {**IS.status(), "study_bbox": list(PUNE_BBOX)}


@router.get("/layers")
def infra_layers():
    st = IS.status()
    ls = IS.layers()
    groups = []
    for g in GROUP_ORDER + sorted({l["group"] for l in ls} - set(GROUP_ORDER)):
        items = [l for l in ls if l["group"] == g]
        if items:
            groups.append({"label": g, "layers": items})
    return {"index": st, "groups": groups, "feature_cap": IS.DEFAULT_CAP, "max_cap": IS.MAX_CAP,
            "population": census_summary(), "traffic_counts": TRAFFIC_COUNTS,
            "note": "Only data in view is sent (bbox query, capped). Absence of a feature is not evidence of absence."}


@router.get("/layers/{lid}/features")
def infra_features(lid: str, bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat (WGS84)"),
                   limit: int = Query(IS.DEFAULT_CAP, ge=1, le=IS.MAX_CAP), source: Optional[str] = None):
    try:
        box = [float(v) for v in bbox.split(",")]
        assert len(box) == 4 and box[0] < box[2] and box[1] < box[3]
    except (ValueError, AssertionError) as e:
        raise HTTPException(422, "bbox must be minLon,minLat,maxLon,maxLat with min < max") from e
    meta = IS.layer(lid)
    if meta is None:
        raise HTTPException(404, f"layer '{lid}' not in the infrastructure index (index built? URBANOS_DATA_DIR set?)")
    area = (box[2] - box[0]) * (box[3] - box[1])
    if lid in DENSE and area > MAX_BBOX_DEG2:
        return {"type": "FeatureCollection", "layer": lid, "bbox": box, "features": [], "returned": 0, "total_in_bbox": None, "truncated": True,
                "not_shown": None, "cap": limit, "too_large": True, "meta": meta,
                "message": f"View too large for this dense layer ({area:.3f} deg²; limit {MAX_BBOX_DEG2:.4f}). Zoom in to load features."}
    where = {"source": set(source.split(","))} if source else None
    try:
        fc = IS.query(lid, box, limit, where)
    except KeyError as e:
        raise HTTPException(404, f"layer '{lid}' not available") from e
    fc["meta"] = meta
    if fc["truncated"]:
        fc["message"] = f"{fc['returned']:,} shown; {fc['not_shown']:,} more in this view not shown (cap {limit:,}). Zoom in to see all."
    return fc


@router.get("/census2011")
def census2011():
    return census_summary(full=True)


@router.get("/traffic-counts")
def traffic_counts():
    return TRAFFIC_COUNTS
