"""Subsurface evidence near an alignment, from datasets actually on disk. Nothing is interpolated or invented.

- Groundwater: NWDP (CGWB / GSDA) manual depth-to-water observations at wells -> nearest wells within radius, each a POINT
  OBSERVATION (latest level + date, full series), never a surface.
- Soil: SoilGrids 2.0 (ISRIC) 0-30 cm properties sampled (nearest 250 m cell) at points along the alignment; SoilGrids
  masks urban cells (no prediction) -> UNKNOWN there.
- Sewers: PMC sewage pipelines (OpenCity copy) crossing / near the alignment; levels are the agency's design/as-recorded
  values with no stated datum or survey accuracy -> ASCE 38 QL-D, unverified.
- Boreholes: only records imported by the user (Underground -> Subsurface records, AGS4). None -> "required: site
  investigation".
"""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path

from datasets import paths

GW_ID = "nwdp_groundwater_pune"
SOIL_ID = "soil_soilgrids250"
SEWER_ID = "pmc_sewage_pipelines_fgb"
SOIL_PROPS = [("clay", "%"), ("sand", "%"), ("silt", "%"), ("bdod", "kg/dm3"), ("cfvo", "vol%"), ("soc", "g/kg")]
SOIL_LABELS = {"clay": "Clay", "sand": "Sand", "silt": "Silt", "bdod": "Bulk density", "cfvo": "Coarse fragments", "soc": "Organic carbon"}
MAX_NEAR_SEWERS = 40
MAX_SERIES = 120


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _vmeta(dataset_id: str, d: Path | None) -> dict:
    if d is None:
        return {"dataset_id": dataset_id, "available": False}
    proc = json.loads((d / "processing.json").read_text())
    return {"dataset_id": dataset_id, "version": d.name, "available": True, "pipeline": proc.get("pipeline"),
            "run_at": proc.get("run_at"), "git_commit": proc.get("git_commit"),
            "outputs": [{"path": o.get("path") or o.get("file"), "sha256": o.get("sha256")} for o in proc.get("outputs", [])],
            "notes": proc.get("notes", "")}


class Alignment:
    """Polyline in EPSG:32643 with chainage helpers."""

    def __init__(self, coords: list[list[float]]):
        from pyproj import Transformer
        from shapely.geometry import LineString

        if len(coords) < 2:
            raise ValueError("a polyline needs at least 2 vertices")
        self.fwd = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
        self.inv = Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True)
        self.xy = [self.fwd.transform(float(c[0]), float(c[1])) for c in coords]
        self.line = LineString(self.xy)
        self.ll = [(float(c[0]), float(c[1])) for c in coords]

    def bbox_wgs84(self, pad_m: float) -> tuple[float, float, float, float]:
        x0, y0, x1, y1 = self.line.bounds
        pts = [self.inv.transform(x, y) for x, y in ((x0 - pad_m, y0 - pad_m), (x1 + pad_m, y1 + pad_m))]
        return (pts[0][0], pts[0][1], pts[1][0], pts[1][1])

    def to_utm(self, geom):
        import numpy as np
        import shapely

        def f(a):
            x, y = self.fwd.transform(a[:, 0], a[:, 1])
            return np.column_stack([x, y])
        return shapely.transform(geom, f)


# ---------------- groundwater ----------------
def groundwater(al: Alignment, radius_km: float, max_wells: int) -> dict:
    from shapely.geometry import Point

    d = paths.derived_version_dir(GW_ID)
    meta = _vmeta(GW_ID, d)
    out = {"dataset": meta, "classification": "observed", "suitability": "screening",
           "statement": "Point observations of depth to water (m below ground level) at monitoring wells; NOT interpolated "
                        "between wells and NOT the level at the alignment.", "wells": [], "radius_km": radius_km}
    if d is None:
        out["status"] = "dataset not on disk"
        return out
    st = json.loads((d / "gwl_stations_pune.geojson").read_text())["features"]
    near = []
    for f in st:
        lon, lat = f["geometry"]["coordinates"][:2]
        p = Point(al.fwd.transform(lon, lat))
        dist = al.line.distance(p)
        if dist <= radius_km * 1000:
            near.append((dist, al.line.project(p), f))
    near.sort(key=lambda t: t[0])
    near = near[:max_wells]
    ids = {f["properties"]["station_id"] for _, _, f in near}
    series: dict[str, list] = {i: [] for i in ids}
    with open(d / "gwl_observations_pune.csv", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["station_id"] in ids:
                v = _num(r["depth_to_water_m_bgl"])
                if v is not None:
                    series[r["station_id"]].append({"date": r["date"], "depth_m_bgl": v})
    for dist, ch, f in near:
        p = f["properties"]
        s = sorted(series.get(p["station_id"], []), key=lambda o: o["date"])
        latest = s[-1] if s else None
        lon, lat = f["geometry"]["coordinates"][:2]
        out["wells"].append({
            "station_id": p["station_id"], "agency": p.get("agency"), "village": p.get("village"), "lon": lon, "lat": lat,
            "distance_m": round(dist, 1), "nearest_chainage_m_utm": round(ch, 1),
            "latest": latest, "first_date": s[0]["date"] if s else None, "n_obs": len(s),
            "series": s[-MAX_SERIES:], "series_truncated": max(0, len(s) - MAX_SERIES),
            "well_depth_m": p.get("well_depth_m"), "aquifer": p.get("aquifer"),  # None = UNKNOWN (not published)
            "classification": "observed — point observation, not interpolated"})
    out["status"] = "ok" if out["wells"] else f"no monitoring well within {radius_km} km"
    return out


# ---------------- soil ----------------
def soil(al: Alignment, spacing_m: float = 250.0, max_points: int = 40) -> dict:
    import rasterio

    d = paths.derived_version_dir(SOIL_ID)
    meta = _vmeta(SOIL_ID, d)
    out = {"dataset": meta, "classification": "estimated (global machine-learning prediction)", "suitability": "screening",
           "depth": "0-30 cm weighted", "statement": "SoilGrids 2.0 (ISRIC, CC BY 4.0) topsoil predictions at 250 m. Urban cells "
           "are masked by the product -> UNKNOWN. Not for foundation design, bearing capacity or tunnelling ground model.",
           "properties": [{"key": k, "label": SOIL_LABELS[k], "unit": u} for k, u in SOIL_PROPS], "points": []}
    if d is None:
        out["status"] = "dataset not on disk"
        return out
    L = al.line.length
    n = max(2, min(max_points, int(L // spacing_m) + 1))
    chs = [L * i / (n - 1) for i in range(n)]
    rasters = {}
    for k, _ in SOIL_PROPS:
        f = d / f"soil_{k}_0-30cm_epsg32643_250m.tif"
        if f.exists():
            with rasterio.open(f) as src:
                rasters[k] = (src.read(1), src.transform)
    for ch in chs:
        p = al.line.interpolate(ch)
        lon, lat = al.inv.transform(p.x, p.y)
        vals = {}
        for k, (a, tr) in rasters.items():
            c, r = int((p.x - tr.c) // tr.a), int((p.y - tr.f) // tr.e)
            v = float(a[r, c]) if 0 <= r < a.shape[0] and 0 <= c < a.shape[1] else float("nan")
            vals[k] = round(v, 2) if math.isfinite(v) else None
        out["points"].append({"chainage_m_utm": round(ch, 1), "lon": round(lon, 6), "lat": round(lat, 6), "values": vals,
                              "status": "ok" if any(v is not None for v in vals.values()) else "UNKNOWN (masked: urban / no prediction)"})
    out["n_unknown"] = sum(1 for p in out["points"] if p["status"] != "ok")
    out["status"] = "ok"
    return out


# ---------------- sewers ----------------
def sewers(al: Alignment, near_m: float, dem=None) -> dict:
    d = paths.derived_version_dir(SEWER_ID)
    meta = _vmeta(SEWER_ID, d)
    out = {"dataset": meta, "publisher": "Pune Municipal Corporation (via OpenCity)", "classification": "observed (as published; survey method UNKNOWN)",
           "suitability": "screening", "quality_level": "ASCE 38 QL-D",
           "statement": "Invert / top levels are the agency's design/as-recorded values — unverified, ASCE 38 QL-D. The "
                        "publisher states no vertical datum; levels are shown as published and compared with the DSM only as a "
                        "consistency check.", "crossings": [], "near": [], "near_not_shown": 0}
    if d is None:
        out["status"] = "dataset not on disk"
        return out
    import pyogrio
    from shapely.ops import nearest_points

    df = pyogrio.read_dataframe(d / "pmc_sewage_pipelines.fgb", bbox=al.bbox_wgs84(near_m))
    zone = al.line.buffer(near_m)
    datum_diffs = []
    near = []
    for row in df.itertuples(index=False):
        g = al.to_utm(row.geometry)
        if not g.intersects(zone):
            continue
        si, ei = _num(row.start_inve), _num(row.end_invert)
        ts, te = _num(row.tl_start_m), _num(row.tl_end_man)
        dia_mm = _num(row.pipeline_d)
        base = {"pipeline_id": row.pipeline_i, "label": row.label, "type": row.drainaige_, "material": row.material_o,
                "diameter_m": round(dia_mm / 1000, 3) if dia_mm else None, "start_invert_m": si, "end_invert_m": ei,
                "start_top_level_m": ts, "end_top_level_m": te, "sewer_district": row.sd_name,
                "quality_level": "QL-D", "certainty": "design/unverified"}
        if dem is not None and ts is not None:
            sx, sy = g.coords[0]
            z, stt = dem.sample_xy(sx, sy)
            if z is not None:
                datum_diffs.append(z - ts)
        inter = g.intersection(al.line)
        pts = [] if inter.is_empty else ([inter] if inter.geom_type == "Point" else
                                         [p for p in getattr(inter, "geoms", []) if p.geom_type == "Point"])
        if pts:
            for p in pts:
                frac = g.project(p) / g.length if g.length > 0 else 0.0
                inv = si + frac * (ei - si) if si is not None and ei is not None else None
                top = ts + frac * (te - ts) if ts is not None and te is not None else None
                z = None
                if dem is not None:
                    z, _ = dem.sample_xy(p.x, p.y)
                lon, lat = al.inv.transform(p.x, p.y)
                out["crossings"].append({**base, "chainage_m_utm": round(al.line.project(p), 1), "lon": round(lon, 7), "lat": round(lat, 7),
                                         "invert_at_crossing_m": None if inv is None else round(inv, 3),
                                         "top_level_at_crossing_m": None if top is None else round(top, 3),
                                         "level_method": "linear between the pipe's published start/end levels (derived)",
                                         "dsm_at_crossing_m": None if z is None else round(z, 2),
                                         "invert_below_dsm_m": None if (z is None or inv is None) else round(z - inv, 2)})
        else:
            near.append({**base, "distance_m": round(g.distance(al.line), 1),
                         "nearest_chainage_m_utm": round(al.line.project(nearest_points(g, al.line)[1]), 1)})
    out["crossings"].sort(key=lambda c: c["chainage_m_utm"])
    near.sort(key=lambda n: n["distance_m"])
    out["near"] = near[:MAX_NEAR_SEWERS]
    out["near_not_shown"] = max(0, len(near) - MAX_NEAR_SEWERS)
    out["near_m"] = near_m
    if datum_diffs:
        datum_diffs.sort()
        m = datum_diffs[len(datum_diffs) // 2]
        out["datum_check"] = {"n": len(datum_diffs), "median_dsm_minus_top_level_m": round(m, 2),
                              "p10": round(datum_diffs[int(0.1 * (len(datum_diffs) - 1))], 2),
                              "p90": round(datum_diffs[int(0.9 * (len(datum_diffs) - 1))], 2),
                              "note": "DSM (EGM2008, includes buildings/trees) minus published manhole top level at pipe starts. "
                                      "A consistent offset suggests a datum difference; spread includes DSM error (<4 m LE90 spec)."}
    out["status"] = "ok"
    return out


# ---------------- boreholes ----------------
def boreholes(al: Alignment, radius_km: float, db=None) -> dict:
    from shapely.geometry import shape

    recs = []
    if db is not None:
        try:
            from sqlalchemy import select

            from coordination.models import SubsurfaceRecordEntity as R
            for r in db.scalars(select(R).where(R.record_type == "borehole")):
                if not r.geometry_geojson:
                    continue
                g = shape(json.loads(r.geometry_geojson))
                gu = al.to_utm(g)
                dist = gu.distance(al.line)
                if dist <= radius_km * 1000:
                    recs.append({"id": r.id, "external_id": r.external_id, "dataset_id": r.dataset_id, "distance_m": round(dist, 1),
                                 "final_depth_m": r.final_depth_m, "ground_level_m": r.ground_level_m,
                                 "nearest_chainage_m_utm": round(al.line.project(gu.centroid), 1)})
        except Exception:  # pragma: no cover
            pass
    recs.sort(key=lambda r: r["distance_m"])
    out = {"records": recs, "radius_km": radius_km,
           "source": "Borehole records imported in Underground → Subsurface records (AGS4 / CSV / JSON). No open Pune borehole dataset exists in the registry."}
    if not recs:
        out["status"] = "none"
        out["message"] = "No borehole records — required: site investigation"
        out["import_hint"] = "Import AGS4 borehole logs in Underground → Subsurface records."
    else:
        out["status"] = "ok"
    return out


def evidence(coords, radius_km: float = 3.0, max_wells: int = 8, sewer_near_m: float = 50.0, db=None, dem=None) -> dict:
    al = Alignment(coords)
    return {"alignment_length_m_utm": round(al.line.length, 1), "crs_for_distances": "EPSG:32643",
            "groundwater": groundwater(al, radius_km, max_wells), "soil": soil(al), "sewers": sewers(al, sewer_near_m, dem),
            "boreholes": boreholes(al, radius_km, db),
            "honesty": "Evidence near the alignment, not a ground model. Missing = UNKNOWN."}
