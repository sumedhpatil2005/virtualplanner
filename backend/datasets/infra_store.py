"""
Read-only access to the infrastructure spatial index built by `python -m datasets.pipelines.infra_index`
(docs/urbanos/INFRASTRUCTURE_DATA.md). bbox queries through SQLite R*Tree; geometry is WGS84 WKB.

Index location: env URBANOS_INFRA_INDEX (file), else <data dir>/derived/infra_index/<latest version>/infra_index.sqlite where
the data dir is URBANOS_DATA_DIR (canonical), URBANOS_DATA_ROOT (alias used by the pipelines), else datasets.vocab.data_root().
Missing index → every call reports `available: false` (nothing is invented).
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
from typing import Iterable, Optional

from .vocab import data_root

_LOCAL = threading.local()
LAYER_ID = re.compile(r"^[a-z0-9_]{1,40}$")
DEFAULT_CAP = 2000
MAX_CAP = 5000


def index_path() -> Optional[str]:
    p = os.environ.get("URBANOS_INFRA_INDEX")
    if p:
        return p if os.path.exists(p) else None
    roots = [os.environ.get("URBANOS_DATA_DIR"), os.environ.get("URBANOS_DATA_ROOT"), data_root()]
    for r in roots:
        if not r:
            continue
        base = os.path.join(r, "derived", "infra_index")
        if os.path.isdir(base):
            from .paths import version_key
            for v in sorted(os.listdir(base), key=version_key, reverse=True):
                f = os.path.join(base, v, "infra_index.sqlite")
                if os.path.exists(f):
                    return f
    return None


def _con() -> Optional[sqlite3.Connection]:
    p = index_path()
    if p is None:
        return None
    cached = getattr(_LOCAL, "con", None)
    if cached is not None and cached[0] == p and os.path.getmtime(p) == cached[2]:
        return cached[1]
    if cached is not None:
        _reset()  # index replaced or moved: close the stale connection instead of leaking it
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, check_same_thread=False)
    _LOCAL.con = (p, con, os.path.getmtime(p))
    return con


def _reset() -> None:
    cached = getattr(_LOCAL, "con", None)
    if cached is not None:
        try:
            cached[1].close()
        except Exception:  # noqa: BLE001
            pass
    _LOCAL.con = None


def _retry(fn):
    """One retry on a fresh connection when SQLite reports a read error (seen once on the network filesystem right after
    the index file was replaced: pages of the old and new file mixed in one connection)."""
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except sqlite3.DatabaseError:
            _reset()
            return fn(*a, **kw)
    wrapper.__name__ = fn.__name__
    wrapper.__wrapped__ = fn
    wrapper.__doc__ = fn.__doc__
    return wrapper


@_retry
def status() -> dict:
    p = index_path()
    if p is None:
        return {"available": False, "reason": "Infrastructure index not built (python -m datasets.pipelines.infra_index) or URBANOS_DATA_DIR not set."}
    con = _con()
    meta = dict(con.execute("select key, value from meta").fetchall()) if _has(con, "meta") else {}
    return {"available": True, "path": p, "built_at": meta.get("built_at"), "git_commit": meta.get("git_commit"), "crs": meta.get("crs", "EPSG:4326"),
            "fingerprint": f"{os.path.basename(os.path.dirname(p))}|{meta.get('built_at')}|{os.path.getsize(p)}"}


def _has(con, table: str) -> bool:
    return con.execute("select 1 from sqlite_master where name=?", (table,)).fetchone() is not None


@_retry
def layers() -> list[dict]:
    con = _con()
    if con is None:
        return []
    cols = [c[1] for c in con.execute("pragma table_info(layers)")]
    out = []
    for row in con.execute("select * from layers order by grp, subgroup, id"):
        d = dict(zip(cols, row))
        meta = json.loads(d.pop("meta") or "{}")
        d.pop("reserved", None)
        d["group"] = d.pop("grp")
        d.update({"active": meta.get("active", True), "notes": meta.get("notes", ""), "feature_count": meta.get("feature_count"),
                  "bbox": meta.get("bbox"), "geometry_types": meta.get("geometry_types")})
        d["available"] = _has(con, f"f_{d['id']}")
        out.append(d)
    return out


def layer(lid: str) -> Optional[dict]:
    return next((l for l in layers() if l["id"] == lid), None)


@_retry
def query(lid: str, bbox: Iterable[float], limit: int = DEFAULT_CAP, where: Optional[dict] = None) -> dict:
    """Features of one layer intersecting bbox (by R*Tree bbox, then exact geometry). Capped: `total_in_bbox` counts R*Tree
    candidates (an upper bound on intersecting features), `returned` is what is sent, `not_shown` the difference."""
    import shapely
    from shapely.geometry import box, mapping
    if not LAYER_ID.match(lid):
        raise KeyError(lid)
    con = _con()
    if con is None or not _has(con, f"f_{lid}"):
        raise KeyError(lid)
    x0, y0, x1, y1 = (float(v) for v in bbox)
    limit = max(1, min(int(limit), MAX_CAP))
    (total,) = con.execute(f"select count(*) from r_{lid} where max_lon>=? and min_lon<=? and max_lat>=? and min_lat<=?", (x0, x1, y0, y1)).fetchone()
    b = box(x0, y0, x1, y1)
    feats = []
    cur = con.execute(f"select f.fid, f.ext_id, f.props, f.wkb from r_{lid} r join f_{lid} f on f.fid=r.fid "
                      "where r.max_lon>=? and r.min_lon<=? and r.max_lat>=? and r.min_lat<=?", (x0, x1, y0, y1))
    for fid, ext, props, wkb in cur:
        p = json.loads(props)
        if where and any(p.get(k) not in v for k, v in where.items()):
            continue
        g = shapely.from_wkb(wkb)
        if not g.intersects(b):
            continue
        feats.append({"type": "Feature", "id": fid, "properties": {"_fid": fid, "_ext_id": ext, **p}, "geometry": mapping(g)})
        if len(feats) >= limit:
            break
    truncated = len(feats) >= limit and total > len(feats)
    return {"type": "FeatureCollection", "layer": lid, "bbox": [x0, y0, x1, y1], "total_in_bbox": total, "returned": len(feats),
            "not_shown": max(0, total - len(feats)) if truncated else 0, "truncated": truncated, "cap": limit,
            "features": feats}


@_retry
def features_near(lid: str, bbox: Iterable[float], where: Optional[dict] = None, max_features: int = 50000):
    """(fid, ext_id, props, shapely geometry) for coordination; raises KeyError when the layer is missing."""
    import shapely
    if not LAYER_ID.match(lid):
        raise KeyError(lid)
    con = _con()
    if con is None or not _has(con, f"f_{lid}"):
        raise KeyError(lid)
    x0, y0, x1, y1 = (float(v) for v in bbox)
    out = []
    for fid, ext, props, wkb in con.execute(
            f"select f.fid, f.ext_id, f.props, f.wkb from r_{lid} r join f_{lid} f on f.fid=r.fid "
            "where r.max_lon>=? and r.min_lon<=? and r.max_lat>=? and r.min_lat<=?", (x0, x1, y0, y1)):
        p = json.loads(props)
        if where and any(p.get(k) not in v for k, v in where.items()):
            continue
        out.append((fid, ext, p, shapely.from_wkb(wkb)))
        if len(out) >= max_features:
            break
    return out


def iter_layer(lid: str):
    """Every (fid, ext_id, props, wkb) of a layer (importers)."""
    con = _con()
    if con is None or not _has(con, f"f_{lid}"):
        raise KeyError(lid)
    yield from con.execute(f"select fid, ext_id, props, wkb from f_{lid} order by fid")
