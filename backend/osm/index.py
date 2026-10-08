"""
Local OpenStreetMap road index.

The roads and traffic signals of a region, taken from an OpenStreetMap
extract file (see build_index.py) and kept in a small SQLite database with a
spatial index. Study areas read their roads from here instead of from the
public Overpass servers, which are often overloaded and can answer with
partial data: the extract is complete for the region and the same for every
request.
"""

from __future__ import annotations

import json
import os
import sqlite3
from typing import Iterable

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "osm")
INDEX_PATH = os.environ.get("TWINCITY_OSM_INDEX", os.path.join(DATA_DIR, "osm_index.db"))

# highway=* values kept: roads for motor vehicles, as the frontend's importer allows
# (it decides per way, e.g. tracks only when open to motor vehicles)
VEHICLE_HIGHWAYS = frozenset({
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service", "road", "track",
})

Box = tuple[float, float, float, float]  # min_lon, min_lat, max_lon, max_lat

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE ways (id INTEGER PRIMARY KEY, tags TEXT NOT NULL, geometry TEXT NOT NULL);
CREATE VIRTUAL TABLE ways_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
CREATE TABLE infrastructure (key INTEGER PRIMARY KEY, category TEXT NOT NULL, element TEXT NOT NULL);
CREATE VIRTUAL TABLE infrastructure_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
CREATE TABLE signals (id INTEGER PRIMARY KEY, lon REAL NOT NULL, lat REAL NOT NULL);
CREATE VIRTUAL TABLE signals_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
"""


def parse_boxes(text: str) -> list[Box]:
    """'minLng,minLat,maxLng,maxLat;...' into boxes. Raises ValueError on bad input."""
    boxes: list[Box] = []
    for part in text.split(";"):
        if not part.strip():
            continue
        values = [float(v) for v in part.split(",")]
        if len(values) != 4 or values[0] > values[2] or values[1] > values[3]:
            raise ValueError(f"Bad box: {part!r}")
        boxes.append((values[0], values[1], values[2], values[3]))
    if not boxes:
        raise ValueError("No box given")
    return boxes


class OsmIndex:
    """Read access to a built index. A connection is opened per call, so the file can be rebuilt meanwhile."""

    def __init__(self, path: str = INDEX_PATH):
        self.path = path

    def available(self) -> bool:
        return os.path.exists(self.path)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)

    def status(self) -> dict:
        if not self.available():
            return {"available": False}
        with self._connect() as db:
            meta = dict(db.execute("SELECT key, value FROM meta"))
            ways = db.execute("SELECT COUNT(*) FROM ways").fetchone()[0]
            signals = db.execute("SELECT COUNT(*) FROM signals").fetchone()[0]
        capabilities = json.loads(meta.get("capabilities", '["roads", "signals"]'))
        return {
            "available": True,
            "capabilities": capabilities,
            "dataTimestamp": meta.get("data_timestamp"),
            "builtAt": meta.get("built_at"),
            "source": meta.get("source"),
            "bbox": json.loads(meta["bbox"]) if "bbox" in meta else None,
            "ways": ways,
            "signals": signals,
        }

    def covers(self, boxes: Iterable[Box]) -> bool:
        """Whether every box lies inside the region the index was built for."""
        st = self.status()
        if not st.get("available") or not st.get("bbox"):
            return False
        a, b, c, d = st["bbox"]
        return all(a <= x0 and b <= y0 and x1 <= c and y1 <= d for x0, y0, x1, y1 in boxes)

    def ways(self, boxes: Iterable[Box]) -> list[dict]:
        """Road ways overlapping any box, shaped like Overpass `out geom` elements."""
        out: dict[int, dict] = {}
        with self._connect() as db:
            for x0, y0, x1, y1 in boxes:
                rows = db.execute(
                    "SELECT w.id, w.tags, w.geometry FROM ways_rtree r JOIN ways w ON w.id = r.id "
                    "WHERE r.max_lon >= ? AND r.min_lon <= ? AND r.max_lat >= ? AND r.min_lat <= ?",
                    (x0, x1, y0, y1),
                )
                for way_id, tags, geometry in rows:
                    if way_id in out:
                        continue
                    out[way_id] = {
                        "type": "way",
                        "id": way_id,
                        "tags": json.loads(tags),
                        "geometry": [{"lon": lon, "lat": lat} for lon, lat in json.loads(geometry)],
                    }
        return list(out.values())

    def signals(self, boxes: Iterable[Box]) -> list[dict]:
        """Traffic signal nodes inside any box, shaped like Overpass node elements."""
        out: dict[int, dict] = {}
        with self._connect() as db:
            for x0, y0, x1, y1 in boxes:
                rows = db.execute(
                    "SELECT s.id, s.lon, s.lat FROM signals_rtree r JOIN signals s ON s.id = r.id "
                    "WHERE r.max_lon >= ? AND r.min_lon <= ? AND r.max_lat >= ? AND r.min_lat <= ?",
                    (x0, x1, y0, y1),
                )
                for node_id, lon, lat in rows:
                    out[node_id] = {"type": "node", "id": node_id, "lon": lon, "lat": lat}
        return list(out.values())

    def infrastructure(self, category: str, boxes: Iterable[Box]) -> list[dict]:
        if category not in ("buildings", "metro"):
            raise ValueError("Unknown infrastructure category")
        if category not in self.status().get("capabilities", []):
            raise ValueError("Rebuild the local index to include this category")
        out: dict[int, dict] = {}
        with self._connect() as db:
            for x0, y0, x1, y1 in boxes:
                rows = db.execute(
                    "SELECT f.key, f.element FROM infrastructure_rtree r JOIN infrastructure f ON f.key = r.id "
                    "WHERE f.category = ? AND r.max_lon >= ? AND r.min_lon <= ? AND r.max_lat >= ? AND r.min_lat <= ?",
                    (category, x0, x1, y0, y1),
                )
                for key, element in rows:
                    out[key] = json.loads(element)
        return list(out.values())
