"""
Builds the local OpenStreetMap road index (see index.py) from an extract file.

    python -m osm.build_index                 # download the latest extract, then build
    python -m osm.build_index --no-download   # build from the file already downloaded
    python -m osm.build_index --pbf my.osm.pbf --bbox 73.55,18.30,74.20,18.85

The extract (Geofabrik's India - Western Zone, which covers Maharashtra) is
refreshed daily by Geofabrik; run this again to bring the roads up to date.
Only roads for motor vehicles and traffic signals inside --bbox are kept.
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
    ways = signals = 0
    processor = osmium.FileProcessor(pbf).with_locations().with_filter(osmium.filter.KeyFilter("highway"))
    header = processor.header
    for obj in processor:
        highway = obj.tags.get("highway")
        if obj.is_node():
            if highway == "traffic_signals" and obj.location.valid() and inside(obj.location.lon, obj.location.lat):
                lon, lat = round(obj.location.lon, 7), round(obj.location.lat, 7)
                db.execute("INSERT INTO signals VALUES (?, ?, ?)", (obj.id, lon, lat))
                db.execute("INSERT INTO signals_rtree VALUES (?, ?, ?, ?, ?)", (obj.id, lon, lon, lat, lat))
                signals += 1
        elif obj.is_way():
            if highway not in VEHICLE_HIGHWAYS:
                continue
            coords = [(round(n.lon, 7), round(n.lat, 7)) for n in obj.nodes if n.location.valid()]
            if len(coords) < 2 or len(coords) != len(obj.nodes):
                continue  # nodes outside the extract: incomplete geometry
            if not any(inside(lon, lat) for lon, lat in coords):
                continue
            lons = [c[0] for c in coords]
            lats = [c[1] for c in coords]
            db.execute("INSERT INTO ways VALUES (?, ?, ?)", (obj.id, json.dumps(dict(obj.tags)), json.dumps(coords)))
            db.execute("INSERT INTO ways_rtree VALUES (?, ?, ?, ?, ?)", (obj.id, min(lons), max(lons), min(lats), max(lats)))
            ways += 1

    meta = {
        "source": os.path.basename(pbf),
        "data_timestamp": header.get("osmosis_replication_timestamp") or datetime.datetime.fromtimestamp(os.path.getmtime(pbf), datetime.timezone.utc).isoformat(),
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "bbox": json.dumps([x0, y0, x1, y1]),
    }
    db.executemany("INSERT INTO meta VALUES (?, ?)", meta.items())
    db.commit()
    db.close()
    os.replace(tmp, out_path)
    return {"ways": ways, "signals": signals, "seconds": round(time.time() - started, 1), **meta}


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
