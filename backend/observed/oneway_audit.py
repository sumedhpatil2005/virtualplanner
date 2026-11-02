"""
Left-hand-traffic audit of one-way carriageways in the local OSM index.

India drives on the left (Rules of the Road Regulations, 1989, "keep left"),
so on a dual carriageway each one-way carriageway has its opposite carriageway
on its right. Two parallel one-way ways of the same road pointing the same way
mean one of them is drawn backwards: the one whose partner lies on its left.

    python -m observed.oneway_audit WAY_A,WAY_B [WAY_C,WAY_D ...]

prints, for each pair, where the partner lies, whether they point the same way,
and which one the rule says is reversed. Used as evidence for
backend/data/network_corrections/*.json; nothing is changed.
"""
from __future__ import annotations

import json
import math
import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "osm" / "osm_index.db"


def _xy(p, o):
    kx = 111320 * math.cos(math.radians(o[1]))
    return ((p[0] - o[0]) * kx, (p[1] - o[1]) * 111320)


def pair_side(a: list[tuple[float, float]], b: list[tuple[float, float]]) -> dict:
    """Side of carriageway b relative to a's travel direction, at a's middle segment.

    Returns left_m (> 0: b lies on a's left), same_direction, separation_m and,
    when both point the same way, reversed: 'a' or 'b' (the one drawn backwards).
    """
    o = a[0]
    ax = [_xy(p, o) for p in a]
    bx = [_xy(p, o) for p in b]
    i = max(1, len(ax) // 2)
    p0, p1 = ax[i - 1], ax[i]
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    n = math.hypot(dx, dy) or 1.0
    dx, dy = dx / n, dy / n
    mid = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    j = min(range(len(bx)), key=lambda k: math.hypot(bx[k][0] - mid[0], bx[k][1] - mid[1]))
    j2 = min(j + 1, len(bx) - 1)
    j1 = j2 - 1
    bdx, bdy = bx[j2][0] - bx[j1][0], bx[j2][1] - bx[j1][1]
    q = bx[j]
    left = dx * (q[1] - mid[1]) - dy * (q[0] - mid[0])
    same = (dx * bdx + dy * bdy) > 0
    out = {"left_m": round(left, 1), "same_direction": same, "separation_m": round(math.hypot(q[0] - mid[0], q[1] - mid[1]), 1)}
    if same:
        out["reversed"] = "a" if left > 0 else "b"
    return out


def _geometry(con, way_id: int):
    tags, geom = con.execute("select tags, geometry from ways where id = ?", (way_id,)).fetchone()
    pts = [(p["lon"], p["lat"]) if isinstance(p, dict) else (p[0], p[1]) for p in json.loads(geom)]
    return json.loads(tags), pts


def audit(pairs: list[tuple[int, int]], db: Path = DB) -> list[dict]:
    con = sqlite3.connect(db)
    out = []
    for a, b in pairs:
        ta, ga = _geometry(con, a)
        tb, gb = _geometry(con, b)
        r = pair_side(ga, gb)
        r.update({"a": a, "b": b, "a_oneway": ta.get("oneway"), "b_oneway": tb.get("oneway"), "name": ta.get("name") or tb.get("name")})
        if "reversed" in r:
            r["reversed_way"] = a if r["reversed"] == "a" else b
        out.append(r)
    return out


if __name__ == "__main__":
    for row in audit([tuple(int(x) for x in arg.split(",")) for arg in sys.argv[1:]]):
        print(json.dumps(row))
