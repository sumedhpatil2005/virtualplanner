"""
Deterministic 2.5D conflict geometry (EGR §D3): exact 2D distance in UTM zone 43N (EPSG:32643, pyproj) between
footprints (Shapely), plus interval arithmetic on depth ranges (Shapely ignores z). Pure functions, no database.

Classes (never "clear" on missing data):
  conflict                            horizontal hit and vertical hit (both depth bounds needed are known)
  potential_conflict                  horizontal hit (or cannot be excluded: footprint width UNKNOWN) and depth UNKNOWN
  vertically_separated                horizontal hit, depth ranges separated (gap reported; whether the gap is enough is
                                      UNKNOWN when no vertical clearance rule/value is set)
  no_conflict_within_available_data   no horizontal hit within the data that covers the area
  unknown_no_coverage                 (assigned by the caller) the area is not covered by the data
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon, shape
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

UTM_EPSG = 32643
_TO_UTM = Transformer.from_crs(4326, UTM_EPSG, always_xy=True)
_FROM_UTM = Transformer.from_crs(UTM_EPSG, 4326, always_xy=True)
EPS = 1e-6
SEVERITY = {"conflict": 0, "potential_conflict": 1, "vertically_separated": 2, "no_conflict_within_available_data": 3,
            "unknown_no_coverage": 4}
_CERT_RANK = {"measured": 0, "estimated": 1, "hypothetical": 2, "unknown": 3}


def to_utm(lon: float, lat: float) -> tuple[float, float]:
    return _TO_UTM.transform(lon, lat)


def from_utm(x: float, y: float) -> tuple[float, float]:
    return _FROM_UTM.transform(x, y)


def worst_certainty(*cs: Optional[str]) -> str:
    vals = [c if c in _CERT_RANK else "unknown" for c in cs]
    return max(vals, key=lambda c: _CERT_RANK[c]) if vals else "unknown"


def geojson_from_coords(coords: list, obj_type: str | None = None) -> Optional[dict]:
    """City-object storage ([[lon, lat, z], ...]) to GeoJSON. Buildings / zones are polygons, others lines/points."""
    if not isinstance(coords, list) or not coords:
        return None
    if isinstance(coords[0], (int, float)):
        return {"type": "Point", "coordinates": coords[:2]}
    pts = [[float(c[0]), float(c[1])] for c in coords if isinstance(c, (list, tuple)) and len(c) >= 2]
    if len(pts) == 1:
        return {"type": "Point", "coordinates": pts[0]}
    if obj_type in ("building", "zone") and len(pts) >= 3:
        if pts[0] != pts[-1]:
            pts.append(pts[0])
        return {"type": "Polygon", "coordinates": [pts]}
    return {"type": "LineString", "coordinates": pts}


def project_geojson(g: dict) -> BaseGeometry:
    """GeoJSON (EPSG:4326) to a Shapely geometry in UTM 43N metres."""
    geom = shape(g)

    def tx(coords):
        return [to_utm(c[0], c[1]) for c in coords]

    if geom.geom_type == "Point":
        return Point(to_utm(geom.x, geom.y))
    if geom.geom_type == "LineString":
        return LineString(tx(geom.coords))
    if geom.geom_type == "Polygon":
        return Polygon(tx(geom.exterior.coords), [tx(r.coords) for r in geom.interiors])
    if geom.geom_type in ("MultiLineString", "MultiPolygon", "MultiPoint", "GeometryCollection"):
        from shapely.ops import transform
        return transform(lambda x, y, z=None: _TO_UTM.transform(x, y), geom)
    raise ValueError(f"Unsupported geometry type {geom.geom_type}")


@dataclass
class Segment:
    """One piece of an element (an alignment is split by vertex so each piece has its own depth range)."""
    owner: str                       # element / asset id
    index: Optional[int]
    kind: str
    geom: BaseGeometry               # footprint in UTM (buffered by width/2 when width is known)
    width_known: bool
    z_min: Optional[float]
    z_max: Optional[float]
    certainty: str
    clearance_m: Optional[float] = None
    meta: dict = field(default_factory=dict)


def _interp_profile(profile: list[dict], ch: float, key: str) -> Optional[float]:
    pts = [(float(p["chainage_m"]), p.get(key)) for p in profile if p.get("chainage_m") is not None]
    pts.sort()
    if not pts:
        return None
    if ch <= pts[0][0]:
        return pts[0][1] if ch >= pts[0][0] - EPS else None
    for (c0, v0), (c1, v1) in zip(pts, pts[1:]):
        if c0 - EPS <= ch <= c1 + EPS:
            if v0 is None or v1 is None:
                return None
            t = 0.0 if c1 == c0 else (ch - c0) / (c1 - c0)
            return float(v0) + t * (float(v1) - float(v0))
    return pts[-1][1] if abs(ch - pts[-1][0]) < EPS else None


def _profile_range(profile: list[dict], c0: float, c1: float) -> tuple[Optional[float], Optional[float]]:
    """Envelope of the profile between chainages c0..c1 (ends interpolated + profile points inside)."""
    chs = [c0, c1] + [float(p["chainage_m"]) for p in profile if p.get("chainage_m") is not None and c0 < float(p["chainage_m"]) < c1]
    mins, maxs = [], []
    for ch in chs:
        lo, hi = _interp_profile(profile, ch, "z_min_m"), _interp_profile(profile, ch, "z_max_m")
        mins.append(lo)
        maxs.append(hi)
    zmin = None if any(v is None for v in mins) else min(mins)
    zmax = None if any(v is None for v in maxs) else max(maxs)
    return zmin, zmax


def segments_for(owner: str, kind: str, geojson: dict, *, width_m: Optional[float], z_min: Optional[float],
                 z_max: Optional[float], certainty: str, profile: Optional[list[dict]] = None,
                 clearance_m: Optional[float] = None, meta: Optional[dict] = None, max_segments: int = 400) -> list[Segment]:
    g = project_geojson(geojson)
    half = (float(width_m) / 2.0) if width_m and width_m > 0 else None

    def foot(x: BaseGeometry) -> BaseGeometry:
        if x.geom_type in ("Polygon", "MultiPolygon"):
            return x.buffer(half) if half else x
        return x.buffer(half, cap_style="flat" if x.geom_type == "LineString" else "round") if half else x

    width_known = half is not None or g.geom_type in ("Polygon", "MultiPolygon")
    out: list[Segment] = []
    if g.geom_type == "LineString" and len(g.coords) >= 2:
        coords = list(g.coords)
        if len(coords) - 1 > max_segments:  # merge consecutive vertices so a long alignment stays tractable
            step = math.ceil((len(coords) - 1) / max_segments)
            coords = coords[::step] + ([coords[-1]] if (len(coords) - 1) % step else [])
        ch = 0.0
        for i, (a, b) in enumerate(zip(coords, coords[1:])):
            seg = LineString([a, b])
            c0, c1 = ch, ch + seg.length
            ch = c1
            zl, zh = (_profile_range(profile, c0, c1) if profile else (z_min, z_max))
            out.append(Segment(owner, i, kind, foot(seg), width_known, zl, zh, certainty, clearance_m,
                               {**(meta or {}), "chainage_m": [round(c0, 2), round(c1, 2)]}))
        return out
    return [Segment(owner, None, kind, foot(g), width_known, z_min, z_max, certainty, clearance_m, dict(meta or {}))]


def vertical_gap(a: Segment, b: Segment) -> Optional[float]:
    """Gap between depth ranges, or None when it cannot be established from the known bounds.
    Ranges overlapping (all four bounds known) -> 0. One side known to lie entirely above the other -> that gap."""
    gaps = []
    if a.z_min is not None and b.z_max is not None:
        gaps.append(a.z_min - b.z_max)   # a above b
    if b.z_min is not None and a.z_max is not None:
        gaps.append(b.z_min - a.z_max)   # b above a
    if any(g > EPS for g in gaps):
        return max(gaps)                 # one range lies entirely above the other
    if len(gaps) == 2:                   # all bounds known and neither lies above the other -> overlap / touching
        return 0.0
    if len(gaps) == 1 and abs(gaps[0]) <= EPS:
        return 0.0                       # touching
    return None


def _kind_match(spec: str, kind: str) -> bool:
    return spec == "*" or kind in [s.strip() for s in spec.split(",")]


def applicable_rules(rules: Iterable[dict], ka: str, kb: str) -> list[dict]:
    return [r for r in rules if (_kind_match(r["subject_kind"], ka) and _kind_match(r["other_kind"], kb))
            or (_kind_match(r["subject_kind"], kb) and _kind_match(r["other_kind"], ka))]


def evaluate_pair(a: Segment, b: Segment, rules: list[dict], screening_radius_m: float, b_is_proposal: bool = True) -> dict:
    """Classify one segment pair. Returns class, distances, reasons, permission triggers, rule ids used.
    Engineering clearances apply symmetrically. A permission distance is directional: subject_kind is the WORK, other_kind
    the protected asset; it fires for a's work near b, and for b's work near a only when b is itself a proposal (an existing
    baseline asset or record is not a work that needs a permission)."""
    rs = applicable_rules(rules, a.kind, b.kind)
    eng = [r for r in rs if r["rule_type"] == "engineering_clearance"]
    perm = [r for r in rules if r["rule_type"] == "permission_distance" and (
        (_kind_match(r["subject_kind"], a.kind) and _kind_match(r["other_kind"], b.kind))
        or (b_is_proposal and _kind_match(r["subject_kind"], b.kind) and _kind_match(r["other_kind"], a.kind)))]
    d = float(a.geom.distance(b.geom))
    reasons: list[str] = []
    h_vals = [r["horizontal_m"] for r in eng if r.get("horizontal_m") is not None]
    h_vals += [c for c in (a.clearance_m, b.clearance_m) if c is not None]
    h_req = max(h_vals) if h_vals else 0.0
    if not h_vals:
        reasons.append("no horizontal clearance set: horizontal test is physical footprint overlap only")
    v_vals = [r["vertical_m"] for r in eng if r.get("vertical_m") is not None]
    v_vals += [c for c in (a.clearance_m, b.clearance_m) if c is not None]
    v_req = max(v_vals) if v_vals else None

    if d <= h_req + EPS:
        h = "hit"
    elif (not a.width_known or not b.width_known) and d <= screening_radius_m + EPS:
        h = "unknown"
        reasons.append("footprint width UNKNOWN: overlap cannot be excluded within the screening radius")
    else:
        h = "miss"

    gap = vertical_gap(a, b)
    if gap is None:
        v = "unknown"
    elif gap <= EPS:
        v = "hit"
    elif v_req is None:
        v = "separated"
        reasons.append("required vertical clearance UNKNOWN (no rule or element clearance set): adequacy of the gap not assessed")
    elif gap < v_req - EPS:
        v = "hit"
        reasons.append(f"vertical gap {gap:.2f} m < required {v_req:.2f} m")
    else:
        v = "separated"

    if h == "miss":
        cls = "no_conflict_within_available_data"
    elif v == "separated":
        cls = "vertically_separated"
    elif h == "hit" and v == "hit":
        cls = "conflict"
    else:
        cls = "potential_conflict"
        if v == "unknown":
            reasons.append("depth UNKNOWN on at least one side: vertical separation cannot be established")
    triggers = [{"rule_id": r["id"], "label": r["label"], "distance_m": round(d, 2), "threshold_m": r["horizontal_m"],
                 "basis": r["basis"], "citation": r.get("citation"),
                 "note": "permission distance (trigger for an NOC / permission), NOT an engineering clearance"}
                for r in perm if r.get("horizontal_m") is not None and d <= r["horizontal_m"] + EPS]
    return {"class": cls, "horizontal_distance_m": round(d, 3), "vertical_gap_m": None if gap is None else round(gap, 3),
            "horizontal": h, "vertical": v, "reasons": reasons, "permission_triggers": triggers,
            "rule_ids": [r["id"] for r in eng], "certainty": "unknown" if cls == "potential_conflict" else worst_certainty(a.certainty, b.certainty)}


def build_tree(segs: list[Segment]) -> STRtree:
    return STRtree([s.geom for s in segs])


def candidates(tree: STRtree, segs: list[Segment], a: Segment, radius: float) -> list[Segment]:
    if not segs:
        return []
    idx = tree.query(a.geom.buffer(radius))
    return [segs[int(i)] for i in idx]


def bbox_lonlat(g: dict, pad_deg: float = 0.0) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = shape(g).bounds
    return (x0 - pad_deg, y0 - pad_deg, x1 + pad_deg, y1 + pad_deg)


def box_inside(inner: tuple, outer: Any) -> bool:
    if not outer:
        return False
    a, b, c, d = outer
    x0, y0, x1, y1 = inner
    return a <= x0 and b <= y0 and x1 <= c and y1 <= d
