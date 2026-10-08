"""
Builds the local OpenStreetMap road index (see index.py) from an extract file.

    python -m osm.build_index                 # download the latest extract, then build
    python -m osm.build_index --no-download   # build from the file already downloaded
    python -m osm.build_index --pbf my.osm.pbf --bbox 73.55,18.30,74.20,18.85

The extract (Geofabrik's India - Western Zone, which covers Maharashtra) is
refreshed daily by Geofabrik; run this again to bring the roads up to date.
Roads, traffic signals, buildings and subway infrastructure overlapping --bbox are kept.
The application never downloads an extract automatically; this command is explicit maintenance.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sqlite3
import sys
import time
import urllib.request

import osmium

from .index import DATA_DIR, INDEX_PATH, SCHEMA, VEHICLE_HIGHWAYS, parse_boxes

EXTRACT_URL = "https://download.geofabrik.de/asia/india/western-zone-latest.osm.pbf"
EXTRACT_PATH = os.path.join(DATA_DIR, "western-zone-latest.osm.pbf")
# Pune Metropolitan Region, with a margin: Hinjewadi and Talegaon to Hadapsar and Wagholi
DEFAULT_BBOX = "73.55,18.30,74.20,18.85"


def download(url: str, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    part = path + ".part"
    print(f"Downloading {url} ...", flush=True)
    urllib.request.urlretrieve(url, part)
    os.replace(part, path)
    print(f"Saved {os.path.getsize(path) / 1e6:.0f} MB to {path}", flush=True)


def build(pbf: str, bbox: tuple[float, float, float, float], out_path: str) -> dict:
    """Reads the extract once and writes a fresh index to out_path (replacing it only when complete)."""
    x0, y0, x1, y1 = bbox
    inside = lambda lon, lat: x0 <= lon <= x1 and y0 <= lat <= y1  # noqa: E731
    tmp = out_path + ".building"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript(SCHEMA)

    started = time.time()
    ways = signals = buildings = metro = 0
    feature_key = 0

    def overlaps(coords):
        return bool(coords) and max(p[0] for p in coords) >= x0 and min(p[0] for p in coords) <= x1 and max(p[1] for p in coords) >= y0 and min(p[1] for p in coords) <= y1

    def feature(category, element, coords):
        nonlocal feature_key
        feature_key += 1
        db.execute("INSERT INTO infrastructure VALUES (?, ?, ?)", (feature_key, category, json.dumps(element)))
        db.execute("INSERT INTO infrastructure_rtree VALUES (?, ?, ?, ?, ?)", (feature_key, min(c[0] for c in coords), max(c[0] for c in coords), min(c[1] for c in coords), max(c[1] for c in coords)))

    # libosmium assembles complete multipolygons; missing fragments are never closed by the importer.
    # Only tagged features reach Python: iterating every untagged node of a regional extract is what makes a build slow.
    processor = (
        osmium.FileProcessor(pbf)
        .with_locations()
        .with_areas(osmium.filter.KeyFilter("building"))
        .with_filter(osmium.filter.KeyFilter("highway", "railway", "building"))
    )
    header = processor.header
    for obj in processor:
        highway = obj.tags.get("highway")
        if obj.is_node():
            if highway == "traffic_signals" and obj.location.valid() and inside(obj.location.lon, obj.location.lat):
                lon, lat = round(obj.location.lon, 7), round(obj.location.lat, 7)
                db.execute("INSERT INTO signals VALUES (?, ?, ?)", (obj.id, lon, lat))
                db.execute("INSERT INTO signals_rtree VALUES (?, ?, ?, ?, ?)", (obj.id, lon, lon, lat, lat))
                signals += 1
            if obj.tags.get("railway") == "station" and obj.tags.get("station") == "subway" and obj.location.valid() and inside(obj.location.lon, obj.location.lat):
                coords = [(obj.location.lon, obj.location.lat)]
                feature("metro", {"type": "node", "id": obj.id, "tags": dict(obj.tags), "lon": obj.location.lon, "lat": obj.location.lat}, coords)
                metro += 1
        elif obj.is_way():
            is_metro = obj.tags.get("railway") == "subway" or (obj.tags.get("railway") == "construction" and obj.tags.get("construction") == "subway") or (obj.tags.get("railway") == "station" and obj.tags.get("station") == "subway")
            if highway not in VEHICLE_HIGHWAYS and not is_metro:
                continue
            coords = [(round(n.lon, 7), round(n.lat, 7)) for n in obj.nodes if n.location.valid()]
            if len(coords) < 2 or len(coords) != len(obj.nodes) or not overlaps(coords):
                continue
            if highway in VEHICLE_HIGHWAYS:
                db.execute("INSERT INTO ways VALUES (?, ?, ?)", (obj.id, json.dumps(dict(obj.tags)), json.dumps(coords)))
                db.execute("INSERT INTO ways_rtree VALUES (?, ?, ?, ?, ?)", (obj.id, min(c[0] for c in coords), max(c[0] for c in coords), min(c[1] for c in coords), max(c[1] for c in coords)))
                ways += 1
            if is_metro:
                feature("metro", {"type": "way", "id": obj.id, "tags": dict(obj.tags), "geometry": [{"lon": lon, "lat": lat} for lon, lat in coords]}, coords)
                metro += 1
        elif obj.is_area() and obj.tags.get("building"):
            members = []
            all_coords = []
            valid = True
            for outer in obj.outer_rings():
                rings = [("outer", outer), *(("inner", inner) for inner in obj.inner_rings(outer))]
                for role, ring in rings:
                    coords = [(round(n.lon, 7), round(n.lat, 7)) for n in ring if n.location.valid()]
                    if len(coords) < 4 or len(coords) != len(ring) or coords[0] != coords[-1]:
                        valid = False
                        break
                    all_coords.extend(coords)
                    members.append({"type": "way", "role": role, "geometry": [{"lon": lon, "lat": lat} for lon, lat in coords]})
            if not valid or not overlaps(all_coords):
                continue
            if obj.from_way():
                element = {"type": "way", "id": obj.orig_id(), "tags": dict(obj.tags), "geometry": members[0]["geometry"]}
            else:
                element = {"type": "relation", "id": obj.orig_id(), "tags": dict(obj.tags), "members": members}
            feature("buildings", element, all_coords)
            buildings += 1

    meta = {
        "source": os.path.basename(pbf),
        "capabilities": json.dumps(["roads", "signals", "buildings", "metro"]),
        "data_timestamp": header.get("osmosis_replication_timestamp") or datetime.datetime.fromtimestamp(os.path.getmtime(pbf), datetime.timezone.utc).isoformat(),
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "bbox": json.dumps([x0, y0, x1, y1]),
    }
    db.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
    db.commit()
    db.close()
    os.replace(tmp, out_path)
    return {"ways": ways, "signals": signals, "buildings": buildings, "metro": metro, "seconds": round(time.time() - started, 1), **meta}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pbf", default=EXTRACT_PATH, help="OpenStreetMap extract (.osm.pbf)")
    parser.add_argument("--bbox", default=DEFAULT_BBOX, help="minLng,minLat,maxLng,maxLat of the region to keep")
    parser.add_argument("--out", default=INDEX_PATH, help="index database to write")
    parser.add_argument("--no-download", action="store_true", help="use the extract already on disk")
    args = parser.parse_args(argv)

    if not args.no_download and args.pbf == EXTRACT_PATH:
        download(EXTRACT_URL, EXTRACT_PATH)
    if not os.path.exists(args.pbf):
        print(f"No extract at {args.pbf}. Run without --no-download to fetch it.", file=sys.stderr)
        return 1
    (bbox,) = parse_boxes(args.bbox)
    print(f"Building the road index from {args.pbf} ...", flush=True)
    result = build(args.pbf, bbox, args.out)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
