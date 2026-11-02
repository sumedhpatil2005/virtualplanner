"""
Locating a counted junction in the local OpenStreetMap index.

A traffic count names a junction ("Kokane Chowk"); the simulator needs the
point where its roads meet. Starting from an *anchor* (a named OSM way, a
landmark or a plus code, found by hand and recorded with its source in the
count file) this module finds the road junction in the index that the anchor
refers to:

* a roundabout: a ring of ways tagged junction=roundabout/circular, or a
  closed road way, near the anchor; the junction point is the ring's centroid
  and its arms are the other roads touching the ring;
* otherwise an at-grade intersection: an OSM vertex shared by road ways with
  three or more arms meeting there (an interior vertex of a way counts as two
  arms, an end vertex as one).

The index stores each way's geometry as coordinates without node ids, so a
shared vertex is identified by identical coordinates (OSM vertices shared by
two ways are the same node and so have identical coordinates).

Nothing here guesses a location: if no junction with three or more arms lies
within the search radius the result is None, and the count file records the
junction as not geolocated.
"""

from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import dataclass, field, asdict

M_PER_DEG_LAT = 111_320.0

# Roads that can form a counted junction's arms (a count survey stands at
# junctions of public roads, not driveways or tracks).
JUNCTION_HIGHWAYS = frozenset({
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "road",
})
CLUSTER_M = 30.0
MAJOR_HIGHWAYS = frozenset({
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
})


def distance_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    kx = M_PER_DEG_LAT * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon1 - lon2) * kx, (lat1 - lat2) * M_PER_DEG_LAT)


@dataclass
class Way:
    id: int
    tags: dict
    coords: list[tuple[float, float]]

    @property
    def highway(self) -> str:
        return self.tags.get("highway", "")

    @property
    def closed(self) -> bool:
        return len(self.coords) > 3 and self.coords[0] == self.coords[-1]

    @property
    def is_roundabout(self) -> bool:
        return self.tags.get("junction") in ("roundabout", "circular")


@dataclass
class JunctionMatch:
    lon: float
    lat: float
    kind: str  # 'roundabout' | 'intersection'
    # Roundabout: road ways touching the ring (a dual carriageway arm counts twice).
    # Intersection: arms meeting at the chosen vertex.
    arms: int
    distance_from_anchor_m: float
    way_ids: list[int] = field(default_factory=list)
    road_names: list[str] = field(default_factory=list)
    highways: list[str] = field(default_factory=list)
    # Junction vertices merged into this junction (a divided-road crossing has several)
    vertices: int = 1

    def to_dict(self) -> dict:
        d = asdict(self)
        d["lon"] = round(self.lon, 7)
        d["lat"] = round(self.lat, 7)
        d["distance_from_anchor_m"] = round(self.distance_from_anchor_m, 1)
        return d


def load_ways(db_path: str, lon: float, lat: float, radius_m: float) -> list[Way]:
    """Road ways from the index whose bounding box comes within `radius_m` of the point."""
    dlat = radius_m / M_PER_DEG_LAT
    dlon = radius_m / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as db:
        rows = db.execute(
            "SELECT w.id, w.tags, w.geometry FROM ways_rtree r JOIN ways w ON w.id = r.id "
            "WHERE r.max_lon >= ? AND r.min_lon <= ? AND r.max_lat >= ? AND r.min_lat <= ?",
            (lon - dlon, lon + dlon, lat - dlat, lat + dlat),
        ).fetchall()
    ways = []
    for way_id, tags, geometry in rows:
        t = json.loads(tags)
        if t.get("highway") not in JUNCTION_HIGHWAYS:
            continue
        ways.append(Way(way_id, t, [(float(a), float(b)) for a, b in json.loads(geometry)]))
    return ways


def _describe(ways: list[Way]) -> tuple[list[int], list[str], list[str]]:
    ids = sorted({w.id for w in ways})
    names = sorted({w.tags.get("name") for w in ways if w.tags.get("name")})
    highways = sorted({w.highway for w in ways})
    return ids, names, highways


def roundabouts(ways: list[Way]) -> list[tuple[list[Way], list[tuple[float, float]]]]:
    """Rings: groups of roundabout ways joined end to end, plus closed road ways."""
    ring_ways = [w for w in ways if w.is_roundabout or w.closed]
    # Union ways that share a vertex into one ring
    parent = {w.id: w.id for w in ring_ways}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    by_vertex: dict[tuple[float, float], list[int]] = {}
    for w in ring_ways:
        for c in w.coords:
            by_vertex.setdefault(c, []).append(w.id)
    for ids in by_vertex.values():
        for other in ids[1:]:
            parent[find(other)] = find(ids[0])
    groups: dict[int, list[Way]] = {}
    for w in ring_ways:
        groups.setdefault(find(w.id), []).append(w)
    out = []
    for group in groups.values():
        verts = sorted({c for w in group for c in w.coords})
        out.append((group, verts))
    return out


def intersections(ways: list[Way]) -> list[tuple[tuple[float, float], int, list[Way]]]:
    """Vertices where road ways meet with three or more arms."""
    arms: dict[tuple[float, float], int] = {}
    members: dict[tuple[float, float], list[Way]] = {}
    for w in ways:
        last = len(w.coords) - 1
        for i, c in enumerate(w.coords):
            if w.closed and i == last:
                continue  # the closing vertex is the first one again
            end = (i == 0 or i == last) and not w.closed
            arms[c] = arms.get(c, 0) + (1 if end else 2)
            members.setdefault(c, []).append(w)
    out = []
    for c, n in arms.items():
        ws = members[c]
        if n >= 3 and len({w.id for w in ws}) >= 2:
            out.append((c, n, ws))
    return out


def match_junction(db_path: str, anchor_lon: float, anchor_lat: float, radius_m: float = 150.0,
                   require_major: bool = True) -> JunctionMatch | None:
    """The junction the anchor refers to, or None when none lies within `radius_m`.

    A roundabout whose centroid lies within the radius wins over plain
    intersections (a "chowk" or "circle" that is a roundabout is counted as one
    junction, not as the several intersections around its ring). Otherwise the
    nearest intersection with three or more arms, at least one of them a major
    road when `require_major`, is chosen.
    """
    ways = load_ways(db_path, anchor_lon, anchor_lat, radius_m + 200)
    best: JunctionMatch | None = None

    for group, verts in roundabouts(ways):
        cx = sum(v[0] for v in verts) / len(verts)
        cy = sum(v[1] for v in verts) / len(verts)
        d = distance_m(cx, cy, anchor_lon, anchor_lat)
        span = max(distance_m(v[0], v[1], cx, cy) for v in verts)
        if d > radius_m or span > 120:  # a ring wider than this is a block of streets, not a roundabout
            continue
        ring_ids = {w.id for w in group}
        vert_set = set(verts)
        touching = [w for w in ways if w.id not in ring_ids and any(c in vert_set for c in w.coords)]
        if len(touching) < 3:
            continue
        if require_major and not any(w.highway in MAJOR_HIGHWAYS for w in group + touching):
            continue
        ids, names, highways = _describe(group + touching)
        cand = JunctionMatch(cx, cy, "roundabout", len(touching), d, ids, names, highways)
        if best is None or cand.distance_from_anchor_m < best.distance_from_anchor_m:
            best = cand
    if best is not None:
        return best

    for (x, y), n, ws in intersections(ways):
        d = distance_m(x, y, anchor_lon, anchor_lat)
        if d > radius_m:
            continue
        if require_major and not any(w.highway in MAJOR_HIGHWAYS for w in ws):
            continue
        ids, names, highways = _describe(ws)
        cand = JunctionMatch(x, y, "intersection", n, d, ids, names, highways)
        # Nearest first; among near-equal distances (within 15 m) prefer more arms, then bigger roads
        if best is None:
            best = cand
        else:
            key = lambda m: (round(m.distance_from_anchor_m / 15), -m.arms, -sum(h in MAJOR_HIGHWAYS for h in m.highways))
            if key(cand) < key(best):
                best = cand
    if best is None:
        return None
    # A divided road crossing is several OSM vertices a few metres apart: merge the
    # junction vertices within CLUSTER_M of the chosen one into one junction.
    cluster = [(c, ws) for c, n, ws in intersections(ways)
               if distance_m(c[0], c[1], best.lon, best.lat) <= CLUSTER_M]
    if len(cluster) > 1:
        cx = sum(c[0] for c, _ in cluster) / len(cluster)
        cy = sum(c[1] for c, _ in cluster) / len(cluster)
        ids, names, highways = _describe([w for _, ws in cluster for w in ws])
        best = JunctionMatch(cx, cy, "intersection", best.arms, distance_m(cx, cy, anchor_lon, anchor_lat),
                             ids, names, highways, vertices=len(cluster))
    return best
