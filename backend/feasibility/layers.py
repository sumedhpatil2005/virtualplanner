"""
Feasibility site-data layers from OpenStreetMap: water, heritage, trees and
(non-metro) railways. Built by ``python -m feasibility.build_layers`` from the
same Geofabrik extract the road index uses; read here by bounding box.

What the layers can and cannot say (docs/FEASIBILITY_ENGINE.md §3):
- a feature present in OSM is evidence the feature exists ("verified from
  available data", completeness never guaranteed);
- a feature *absent* from OSM proves nothing: the engine reports such an
  absence as ``unknown`` (or, at most, a screening distance), never as "clear".
- OSM ``natural=tree`` is sparse in Pune; a tree count from it is indicative.
- OSM ``historic=*`` / ``heritage=*`` is a locator only; the statutory ASI
  protected limits and the PMC heritage list are not in OSM.
"""

from __future__ import annotations

import json
import os
import sqlite3
from typing import Iterable

from osm.index import DATA_DIR

LAYERS_PATH = os.environ.get("TWINCITY_FEAS_LAYERS", os.path.join(DATA_DIR, "feasibility_layers.db"))
CATEGORIES = ("water", "heritage", "trees", "railway")

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE features (key INTEGER PRIMARY KEY, category TEXT NOT NULL, element TEXT NOT NULL);
CREATE VIRTUAL TABLE features_rtree USING rtree(id, min_lon, max_lon, min_lat, max_lat);
"""

Box = tuple[float, float, float, float]


class FeasibilityLayers:
    def __init__(self, path: str | None = None):
        self.path = path or LAYERS_PATH

    def available(self) -> bool:
        return os.path.exists(self.path)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)

    def status(self) -> dict:
        if not self.available():
            return {"available": False, "categories": []}
        with self._connect() as db:
            meta = dict(db.execute("SELECT key, value FROM meta"))
            counts = dict(db.execute("SELECT category, COUNT(*) FROM features GROUP BY category"))
        return {
            "available": True,
            "categories": json.loads(meta.get("categories", "[]")),
            "counts": counts,
            "source": meta.get("source"),
            "dataTimestamp": meta.get("data_timestamp"),
            "builtAt": meta.get("built_at"),
            "bbox": json.loads(meta["bbox"]) if "bbox" in meta else None,
        }

    def covers(self, box: Box) -> bool:
        st = self.status()
        if not st.get("bbox"):
            return False
        a, b, c, d = st["bbox"]
        x0, y0, x1, y1 = box
        return a <= x0 and b <= y0 and x1 <= c and y1 <= d

    def features(self, category: str, boxes: Iterable[Box], limit: int = 20000) -> list[dict]:
        if category not in CATEGORIES:
            raise ValueError("Unknown layer category")
        out: dict[int, dict] = {}
        with self._connect() as db:
            for x0, y0, x1, y1 in boxes:
                rows = db.execute(
                    "SELECT f.key, f.element FROM features_rtree r JOIN features f ON f.key = r.id "
                    "WHERE f.category = ? AND r.max_lon >= ? AND r.min_lon <= ? AND r.max_lat >= ? AND r.min_lat <= ? LIMIT ?",
                    (category, x0, x1, y0, y1, limit),
                )
                for key, element in rows:
                    out[key] = json.loads(element)
        return list(out.values())
