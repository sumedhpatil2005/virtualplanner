"""Tree census 2019 bbox API over the R*Tree index (datasets.pipelines.tree_index).

Points are returned only when the box holds ≤ `limit` trees; otherwise pre-aggregated grid clusters (count + centroid per
cell, the finest grid level that keeps ≤ MAX_CELLS cells in view), with the total stated, so nothing is silently dropped.
"""
from __future__ import annotations

import sqlite3
import threading
from typing import Sequence

from . import paths

DATASET, VERSION, FILE = "pmc_tree_census_2019_index", "v1", "trees_index.sqlite"
MAX_LIMIT = 5000
MAX_CELLS = 1500
MAX_POLYGON_CANDIDATES = 200_000  # count_in_polygon loads candidates into memory; a city-wide polygon was ~4M rows
_local = threading.local()


def db_path():
    return paths.derived(DATASET, VERSION, FILE)


def _conn() -> sqlite3.Connection:
    p = str(db_path())
    c = getattr(_local, "conn", None)
    if c is None or getattr(_local, "path", None) != p:
        c = sqlite3.connect(f"file:{p}?mode=ro", uri=True, check_same_thread=False)
        c.row_factory = sqlite3.Row
        _local.conn, _local.path = c, p
    return c


_WHERE = ("r.maxx>=? AND r.minx<=? AND r.maxy>=? AND r.miny<=? "
          "AND t.lon>=? AND t.lon<=? AND t.lat>=? AND t.lat<=?")


def _args(b):
    return (b[0], b[2], b[1], b[3], b[0], b[2], b[1], b[3])


def _levels(c) -> list[float]:
    r = c.execute("SELECT value FROM meta WHERE key='grid_levels_deg'").fetchone()
    return [float(x) for x in r[0].split(",")]


def pick_level(bbox: Sequence[float], levels: Sequence[float], max_cells: int = MAX_CELLS) -> int:
    """Finest level whose cell count over the box stays ≤ max_cells (pure)."""
    best = 0
    for i, s in enumerate(levels):
        n = ((bbox[2] - bbox[0]) / s + 1) * ((bbox[3] - bbox[1]) / s + 1)
        if n <= max_cells:
            best = i
    return best


def _grid_sum(c, level: int, s: float, bbox) -> list[sqlite3.Row]:
    gx0, gx1 = int(bbox[0] // s), int(bbox[2] // s)
    gy0, gy1 = int(bbox[1] // s), int(bbox[3] // s)
    return c.execute("SELECT gx, gy, n, sum_lon, sum_lat FROM grid WHERE level=? AND gx BETWEEN ? AND ? AND gy BETWEEN ? AND ?",
                     (level, gx0, gx1, gy0, gy1)).fetchall()


def query(bbox: Sequence[float], limit: int = 2000) -> dict:
    limit = max(1, min(MAX_LIMIT, int(limit)))
    c = _conn()
    levels = _levels(c)
    finest = len(levels) - 1
    # exact count via the R*Tree when the box is small enough that the finest grid estimate is modest
    est = sum(r["n"] for r in _grid_sum(c, finest, levels[finest], bbox))
    total = None
    # R*Tree bounds are float32 (rounded outward): select by overlap, then filter on the exact float64 coordinates
    if est <= 60000:
        total = c.execute("SELECT count(*) FROM trees_rt r JOIN trees t ON t.id=r.id WHERE " + _WHERE, _args(bbox)).fetchone()[0]
    if total is not None and total <= limit:
        rows = c.execute(
            """SELECT t.id, t.lon, t.lat, t.girth_cm, t.height_m, t.canopy_dia_m, t.condition, t.ownership, t.ward, t.is_rare,
                      s.botanical_name, s.common_name, s.local_name
               FROM trees_rt r JOIN trees t ON t.id=r.id LEFT JOIN species s ON s.id=t.species_id
               WHERE """ + _WHERE, _args(bbox)).fetchall()
        return {"mode": "points", "total": total, "returned": len(rows), "limit": limit, "points": [dict(r) for r in rows]}
    level = pick_level(bbox, levels)
    s = levels[level]
    cells = [{"lon": r["sum_lon"] / r["n"], "lat": r["sum_lat"] / r["n"], "n": r["n"], "cell_deg": s}
             for r in _grid_sum(c, level, s, bbox)]
    cells = [x for x in cells if bbox[0] <= x["lon"] <= bbox[2] and bbox[1] <= x["lat"] <= bbox[3]]
    in_cells = sum(x["n"] for x in cells)
    return {"mode": "clusters", "total": total if total is not None else in_cells, "total_exact": total is not None,
            "returned": 0, "limit": limit, "cell_deg": s, "clusters": cells,
            "message": f"{(total if total is not None else in_cells):,} trees in view — more than the {limit:,}-point cap; "
                       f"shown as {len(cells):,} grid clusters ({s}° cells). Zoom in to see individual trees."}


def count_in_polygon(geom_4326: dict) -> dict:
    """Trees whose point lies inside a WGS84 polygon (used by feasibility screening's treesInFootprint slot)."""
    from shapely.geometry import Point

    from .render import polygon_4326
    g = polygon_4326(geom_4326)
    b = g.bounds
    c = _conn()
    (cand,) = c.execute("SELECT count(*) FROM trees_rt r JOIN trees t ON t.id=r.id WHERE " + _WHERE, _args(b)).fetchone()
    if cand > MAX_POLYGON_CANDIDATES:
        raise ValueError(f"polygon too large: {cand:,} trees in its bounding box (limit {MAX_POLYGON_CANDIDATES:,}); draw a smaller area")
    rows = c.execute("""SELECT t.lon, t.lat, t.condition, t.is_rare FROM trees_rt r JOIN trees t ON t.id=r.id
                        WHERE """ + _WHERE, _args(b)).fetchall()
    from shapely.prepared import prep
    pg = prep(g)
    inside = [r for r in rows if pg.contains(Point(r["lon"], r["lat"]))]
    return {"count": len(inside), "rare": sum(1 for r in inside if r["is_rare"] == 1),
            "data_class": "observed", "vintage": "2019", "suitability": "screening",
            "note": "PMC tree census 2019 points inside the footprint. Trees felled/planted since 2019 are not reflected; a Trees Act survey is still required."}
