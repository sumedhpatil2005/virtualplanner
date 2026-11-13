"""PMC Tree Census 2019 (17 CSV parts via OpenCity) -> one compact, validated point table.

  cd backend && python -m datasets.pipelines.opencity_trees --raw-date 2026-11-13

Input columns (observed in the files): FID,id,geom ('POINT (lon lat)'),girth_cm,height_m,
canopy_dia_m,condition,ownership,botanical_name,common_name,local_name,ward,is_rare,
northing,easting,... NOTE: in the published files 'northing' holds latitude and 'easting'
longitude in decimal degrees (not projected metres); we take coordinates from 'geom' and use
northing/easting only as a consistency check.
Output: derived/pmc_tree_census_2019/<version>/trees_pune.csv (+ processing.json)
Class: observed (field census, 2019 vintage per dataset title). Suitability: screening for
Trees Act surveys; a fresh site survey is still required (trees are felled/planted since).
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

from . import gov_common as gc

SOURCE_ID = "opencity_pune"
DATASET_ID = "pmc_tree_census_2019"
POINT_RE = re.compile(r"POINT\s*\(\s*([-0-9.eE]+)\s+([-0-9.eE]+)\s*\)")
KEEP = ["id", "girth_cm", "height_m", "canopy_dia_m", "condition", "ownership", "botanical_name",
        "common_name", "local_name", "ward", "is_rare"]


def parse_point(geom: str):
    m = POINT_RE.search(geom or "")
    if not m:
        return None
    return float(m.group(1)), float(m.group(2))


def _f(v):
    try:
        x = float(v)
        return x
    except (TypeError, ValueError):
        return None


def process_rows(rows, writer, stats: Counter, seen: set):
    for r in rows:
        stats["rows_read"] += 1
        pt = parse_point(r.get("geom", ""))
        if pt is None:
            stats["no_geometry"] += 1
            continue
        lon, lat = pt
        if not (gc.PUNE_BBOX[0] <= lon <= gc.PUNE_BBOX[2] and gc.PUNE_BBOX[1] <= lat <= gc.PUNE_BBOX[3]):
            stats["outside_study_box"] += 1
            continue
        n, e = _f(r.get("northing")), _f(r.get("easting"))
        if n is not None and e is not None and (abs(n - lat) > 1e-4 or abs(e - lon) > 1e-4):
            stats["geom_vs_northing_easting_mismatch"] += 1
        tid = (r.get("id") or "").strip()
        if tid and tid in seen:
            stats["duplicate_id_dropped"] += 1
            continue
        seen.add(tid)
        for k, lo, hi in (("girth_cm", 1, 2000), ("height_m", 0.3, 60), ("canopy_dia_m", 0.1, 60)):
            v = _f(r.get(k))
            if v is None:
                stats[f"{k}_missing"] += 1
            elif not (lo <= v <= hi):
                stats[f"{k}_outside_{lo}_{hi}"] += 1
        stats[f"condition:{(r.get('condition') or '').strip() or 'blank'}"] += 1
        if (r.get("is_rare") or "").strip().upper() == "TRUE":
            stats["is_rare_true"] += 1
        writer.writerow([round(lon, 7), round(lat, 7)] + [(r.get(k) or "").strip().replace("\n", " ") for k in KEEP])
        stats["written"] += 1


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--raw-date", required=True)
    p.add_argument("--version")
    a = p.parse_args(argv)
    csv.field_size_limit(sys.maxsize)
    rd = gc.data_home() / "raw" / SOURCE_ID / a.raw_date
    man = json.loads((rd / "manifest.json").read_text())["files"]
    parts = sorted([e for e in man if e.get("ckan_dataset") == "pune-tree-census-2019"],
                   key=lambda e: int(e["ckan_resource_name"].rsplit(" ", 1)[-1]))
    out = gc.derived_dir(DATASET_ID, a.version or a.raw_date)
    path = out / "trees_pune.csv"
    stats, seen = Counter(), set()
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["lon", "lat"] + KEEP)
        for e in parts:
            with open(rd / e["file"], encoding="utf-8", errors="replace", newline="") as src:
                process_rows(csv.DictReader(src), w, stats, seen)
    stats["parts"] = len(parts)
    gc.write_processing(out, pipeline="datasets.pipelines.opencity_trees", inputs=[
        {"file": e["file"], "sha256": e["sha256"], "url": e["url"], "part": e["ckan_resource_name"]} for e in parts],
        parameters={"study_bbox_wgs84": gc.PUNE_BBOX, "coords_from": "geom WKT POINT(lon lat)", "dedupe": "id",
                    "plausibility_ranges": {"girth_cm": [1, 2000], "height_m": [0.3, 60], "canopy_dia_m": [0.1, 60]}},
        outputs=[path], validation=dict(stats),
        notes="Observed (PMC tree census, 2019 vintage). Out-of-range attribute values are counted, not altered.")
    print(json.dumps(dict(stats), indent=1))


if __name__ == "__main__":
    main()
