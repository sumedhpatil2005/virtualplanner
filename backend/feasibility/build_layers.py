"""
Builds the feasibility site-data layers (see layers.py) from the OSM extract.

    python -m feasibility.build_layers --pbf data/osm/western-zone-latest.osm.pbf

Kept: waterway=* lines; natural=water/wetland, water=*, landuse=reservoir/basin
areas; historic=* and heritage=* (nodes, ways, areas); natural=tree nodes and
natural=tree_row ways; railway=rail/light_rail/narrow_gauge/tram lines
(subway is in the metro layer of the road index). Explicit maintenance only;
the application never downloads or rebuilds this file by itself.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sqlite3
import sys
import time

import osmium

from osm.build_index import DEFAULT_BBOX, EXTRACT_PATH
from osm.index import parse_boxes

from .layers import LAYERS_PATH, SCHEMA

WATER_NATURAL = {"water", "wetland"}
WATER_LANDUSE = {"reservoir", "basin"}
RAIL = {"rail", "light_rail", "narrow_gauge", "tram", "construction"}


def category_of(tags) -> str | None:
    if tags.get("waterway") or tags.get("natural") in WATER_NATURAL or tags.get("water") or tags.get("landuse") in WATER_LANDUSE:
        return "water"
    if tags.get("historic") or tags.get("heritage"):
        return "heritage"
    if tags.get("natural") in ("tree", "tree_row"):
        return "trees"
    rw = tags.get("railway")
    if rw in RAIL and not (rw == "construction" and tags.get("construction") == "subway"):
        return "railway"
    return None


def build(pbf: str, bbox, out_path: str) -> dict:
    x0, y0, x1, y1 = bbox
    tmp = out_path + ".building"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript(SCHEMA)
    started = time.time()
    counts = {"water": 0, "heritage": 0, "trees": 0, "railway": 0}
    key = 0

    def overlaps(coords):
        return bool(coords) and max(p[0] for p in coords) >= x0 and min(p[0] for p in coords) <= x1 and max(p[1] for p in coords) >= y0 and min(p[1] for p in coords) <= y1

    def add(cat, element, coords):
        nonlocal key
        key += 1
        db.execute("INSERT INTO features VALUES (?, ?, ?)", (key, cat, json.dumps(element)))
        db.execute("INSERT INTO features_rtree VALUES (?, ?, ?, ?, ?)", (key, min(c[0] for c in coords), max(c[0] for c in coords), min(c[1] for c in coords), max(c[1] for c in coords)))
        counts[cat] += 1

    area_filter = osmium.filter.KeyFilter("natural", "water", "landuse", "historic", "heritage")
    processor = (
        osmium.FileProcessor(pbf)
        .with_locations()
        .with_areas(area_filter)
        .with_filter(osmium.filter.KeyFilter("waterway", "natural", "water", "landuse", "historic", "heritage", "railway"))
    )
    header = processor.header
    for obj in processor:
        cat = category_of(obj.tags)
        if cat is None:
            continue
        tags = dict(obj.tags)
        if obj.is_node():
            if not obj.location.valid():
                continue
            c = [(round(obj.location.lon, 7), round(obj.location.lat, 7))]
            if overlaps(c):
                add(cat, {"type": "node", "id": obj.id, "tags": tags, "lon": c[0][0], "lat": c[0][1]}, c)
        elif obj.is_way():
            coords = [(round(n.lon, 7), round(n.lat, 7)) for n in obj.nodes if n.location.valid()]
            if len(coords) < 2 or len(coords) != len(obj.nodes) or not overlaps(coords):
                continue
            closed = coords[0] == coords[-1] and len(coords) >= 4
            # Closed ways that are areas are emitted again as areas below; keep lines (waterway, railway, tree_row) and unclosed ways here.
            if closed and cat in ("water", "heritage") and not tags.get("waterway"):
                continue
            add(cat, {"type": "way", "id": obj.id, "tags": tags, "geometry": [{"lon": a, "lat": b} for a, b in coords]}, coords)
        elif obj.is_area():
            rings = []
            all_coords = []
            ok = True
            for outer in obj.outer_rings():
                coords = [(round(n.lon, 7), round(n.lat, 7)) for n in outer if n.location.valid()]
                if len(coords) < 4 or len(coords) != len(outer):
                    ok = False
                    break
                rings.append([{"lon": a, "lat": b} for a, b in coords])
                all_coords.extend(coords)
            if not ok or not overlaps(all_coords) or cat not in ("water", "heritage"):
                continue
            add(cat, {"type": "area", "id": obj.orig_id(), "fromWay": obj.from_way(), "tags": tags, "outer": rings}, all_coords)

    meta = {
        "source": os.path.basename(pbf),
        "categories": json.dumps(sorted(counts)),
        "data_timestamp": header.get("osmosis_replication_timestamp") or datetime.datetime.fromtimestamp(os.path.getmtime(pbf), datetime.timezone.utc).isoformat(),
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "bbox": json.dumps([x0, y0, x1, y1]),
    }
    db.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
    db.commit()
    db.close()
    os.replace(tmp, out_path)
    return {**counts, "seconds": round(time.time() - started, 1), **meta}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--pbf", default=EXTRACT_PATH)
    p.add_argument("--bbox", default=DEFAULT_BBOX)
    p.add_argument("--out", default=LAYERS_PATH)
    a = p.parse_args(argv)
    if not os.path.exists(a.pbf):
        print(f"No extract at {a.pbf}", file=sys.stderr)
        return 1
    (bbox,) = parse_boxes(a.bbox)
    print(json.dumps(build(a.pbf, bbox, a.out), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
