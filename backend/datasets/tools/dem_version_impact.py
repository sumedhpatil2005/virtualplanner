"""Impact of the DEM version (v1 vs v3, v2 for streams) on app outputs — docs/urbanos/DEM_V1_V3_COMPARISON.md.

Uses the app's own code paths: POST /api/terrain/profile and /api/terrain/subsurface-evidence (FastAPI TestClient,
URBANOS_DEM_VERSION switched per run), terrain.dem.Dem for the city-wide sewer-level check, and the stream GeoJSON the
Environment layer `dem_streams` serves (envdata catalogue file name).

    cd backend && python -m datasets.tools.dem_version_impact --out /path/to/impact.json
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

import numpy as np

from datasets import paths

DS = "elevation_copdem30"
HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def metro_tunnel() -> list[list[float]]:
    """OSM way 586112436 'Pune Metro Line 1: Purple Line' railway=subway tunnel=yes (Range Hills -> Swargate), from the
    app's OSM index (backend/data/osm/osm_index.db, infrastructure category metro)."""
    c = sqlite3.connect(f"file:{os.path.join(HERE, 'data/osm/osm_index.db')}?mode=ro", uri=True)
    for (e,) in c.execute("select element from infrastructure where category='metro' and element like '%586112436%'"):
        d = json.loads(e)
        if d.get("id") == 586112436:
            return [[p["lon"], p["lat"]] for p in d["geometry"]]
    raise RuntimeError("OSM way 586112436 not in the index")


TRANSECTS = {
    "T1_metro_purple_line_tunnel": None,  # filled from OSM
    "T2_mutha_river_crossing_N-S_lon73.8530": [[73.8530, 18.5130], [73.8530, 18.5250]],
    "T3_parvati_hill_W-E_lat18.4967": [[73.8380, 18.4967], [73.8560, 18.4967]],
    "T4_vetal_tekdi_W-E_lat18.5270": [[73.8050, 18.5270], [73.8450, 18.5270]],
}


def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.terrain_router import router
    app = FastAPI()
    app.include_router(router, prefix="/api")
    return TestClient(app)


def profiles(tc, coords, version):
    os.environ["URBANOS_DEM_VERSION"] = version
    r = tc.post("/api/terrain/profile", json={"coordinates": coords, "step_m": 30})
    r.raise_for_status()
    j = r.json()
    assert j["dataset"]["version"] == version, j["dataset"]["version"]
    return j


def evidence(tc, coords, version):
    os.environ["URBANOS_DEM_VERSION"] = version
    r = tc.post("/api/terrain/subsurface-evidence", json={"coordinates": coords, "radius_km": 1, "max_wells": 3, "sewer_near_m": 10})
    r.raise_for_status()
    return r.json()


def _s(d):
    d = np.asarray([x for x in d if x is not None and np.isfinite(x)], dtype=float)
    if not d.size:
        return {"n": 0}
    return {"n": int(d.size), "mean": round(float(d.mean()), 2), "rms": round(float(np.sqrt((d ** 2).mean())), 2),
            "p5": round(float(np.percentile(d, 5)), 2), "p95": round(float(np.percentile(d, 95)), 2),
            "max_abs": round(float(np.abs(d).max()), 2)}


def river_crossing_check(coords):
    import geopandas as gpd
    from shapely.geometry import LineString
    rv = gpd.read_file(paths.derived_version_dir("pmc_rivers") / "pmc_rivers.geojson").set_crs(4326, allow_override=True).to_crs(32643)
    ln = gpd.GeoSeries([LineString(coords)], crs=4326).to_crs(32643).iloc[0]
    inter = ln.intersection(rv.union_all())
    return round(inter.length, 1)


def depth_impact(p1, p3, n_vertices=4):
    """Underground long-section logic (frontend engine/underground/terrainProfile.ts): depths are entered per vertex
    relative to ground; crown elevation at a vertex = ground - depth; between vertices the crown is a straight grade, and
    depth below the DSM there = ground(ch) - crown(ch). With the same entered depths, the change between DEM versions is
    d_ground(ch) - lerp(d_ground at the two vertices). Evaluated for an alignment drawn with `n_vertices` evenly spaced
    vertices on the sampled chainage."""
    ch = np.array([s["chainage_m"] for s in p3["samples"]])
    g1 = np.array([np.nan if s["elevation_m"] is None else s["elevation_m"] for s in p1["samples"]])
    g3 = np.array([np.nan if s["elevation_m"] is None else s["elevation_m"] for s in p3["samples"]])
    dg = g3 - g1
    vi = np.linspace(0, len(ch) - 1, n_vertices).round().astype(int)
    interp = np.interp(ch, ch[vi], dg[vi])
    dd = dg - interp
    return {"n_vertices": n_vertices, "delta_crown_elevation_at_vertices_m": [round(float(x), 2) for x in dg[vi]],
            "delta_depth_below_dsm_between_vertices_m": _s(dd)}


def sewer_levels_citywide(versions):
    """DSM minus PMC published manhole top level at each pipe start (same comparison as evidence.sewers datum_check,
    city-wide). The PMC levels are an independent ground reference (road-surface manholes); a smaller spread = DSM
    better co-registered with the street network."""
    import pyogrio
    from terrain.dem import Dem
    d = paths.derived_version_dir("pmc_sewage_pipelines_fgb")
    df = pyogrio.read_dataframe(d / "pmc_sewage_pipelines.fgb", columns=["tl_start_m"])
    df = df[df.geometry.notna()].to_crs(32643)
    ts = df["tl_start_m"].apply(lambda v: float(v) if v not in (None, "") else np.nan).to_numpy()
    xs = np.array([(g.geoms[0] if hasattr(g, "geoms") else g).coords[0][0] for g in df.geometry])
    ys = np.array([(g.geoms[0] if hasattr(g, "geoms") else g).coords[0][1] for g in df.geometry])
    ok = np.isfinite(ts) & (ts > 300) & (ts < 1500)
    out = {"n_pipes_with_top_level": int(ok.sum())}
    for v in versions:
        dem = Dem(paths.derived_version_dir(DS, v))
        z = np.array([np.nan if (q := dem.sample_xy(x, y)[0]) is None else q for x, y in zip(xs[ok], ys[ok])])
        diff = z - ts[ok]
        diff = diff[np.isfinite(diff)]
        med = float(np.median(diff))
        mad = float(np.median(np.abs(diff - med)))
        out[v] = {"n": int(diff.size), "median_dsm_minus_tl_m": round(med, 3), "mad_m": round(mad, 3),
                  "nmad_m": round(1.4826 * mad, 3), "p10": round(float(np.percentile(diff, 10)), 2),
                  "p90": round(float(np.percentile(diff, 90)), 2), "iqr_m": round(float(np.percentile(diff, 75) - np.percentile(diff, 25)), 3)}
    return out


def streams(versions):
    import geopandas as gpd
    nal = gpd.read_file(paths.derived_version_dir("pmc_nallas") / "pmc_nallas.geojson").set_crs(4326, allow_override=True).to_crs(32643)
    riv = gpd.read_file(paths.derived_version_dir("pmc_rivers") / "pmc_rivers.geojson").set_crs(4326, allow_override=True).to_crs(32643)
    ref = nal.union_all().union(riv.union_all().boundary).union(riv.union_all())
    ref_b = {b: ref.buffer(b) for b in (30, 60, 100)}
    nal_u = nal.union_all()
    out = {"reference": {"pmc_nallas_features": len(nal), "pmc_nallas_length_km": round(nal.length.sum() / 1000, 1), "pmc_rivers_polygons": len(riv)}}
    # comparison area: the PMC data footprint (nallas+rivers hull), so streams outside PMC limits are not counted as misses
    hull = nal.union_all().union(riv.union_all()).convex_hull
    for v in versions:
        f = paths.derived_version_dir(DS, v) / "streams_derived_epsg32643.geojson"
        s = gpd.read_file(f)
        if s.crs is None:
            s = s.set_crs(32643)
        s = s.to_crs(32643)
        tot = s.length.sum()
        sh = s.clip(hull)
        shl = sh.length.sum()
        su = s.union_all()
        r = {"segments": len(s), "length_km": round(tot / 1000, 2), "length_in_pmc_hull_km": round(shl / 1000, 2)}
        for b, bb in ref_b.items():
            r[f"stream_len_within_{b}m_of_pmc_nalla_or_river_pct"] = round(100 * sh.intersection(bb).length.sum() / shl, 2)
        for b in (30, 60, 100):
            r[f"pmc_nalla_len_within_{b}m_of_stream_pct"] = round(100 * nal_u.intersection(su.buffer(b)).length / nal_u.length, 2)
        out[v] = r
    # geometric agreement v3 vs v1: share of v3 stream length within 30 m of v1 streams and vice versa
    s1 = gpd.read_file(paths.derived_version_dir(DS, "v1") / "streams_derived_epsg32643.geojson").to_crs(32643).union_all()
    s3 = gpd.read_file(paths.derived_version_dir(DS, "v3") / "streams_derived_epsg32643.geojson").to_crs(32643).union_all()
    s2 = gpd.read_file(paths.derived_version_dir(DS, "v2") / "streams_derived_epsg32643.geojson").to_crs(32643).union_all()
    out["agreement"] = {f"v3_len_within_{b}m_of_v1_pct": round(100 * s3.intersection(s1.buffer(b)).length / s3.length, 2) for b in (15, 30, 60)}
    out["agreement"].update({f"v1_len_within_{b}m_of_v3_pct": round(100 * s1.intersection(s3.buffer(b)).length / s1.length, 2) for b in (15, 30, 60)})
    out["agreement"]["v2_len_within_15m_of_v1_pct"] = round(100 * s2.intersection(s1.buffer(15)).length / s2.length, 2)
    # catchment outlets
    for v in versions:
        co = json.loads((paths.derived_version_dir(DS, v) / "catchment_outlets.json").read_text())
        out[v]["catchment_outlets"] = co if isinstance(co, (int, float)) else (len(co) if isinstance(co, list) else len(co.get("outlets", co)))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--part", default="all", choices=["all", "transects", "sewers", "streams"])
    a = ap.parse_args(argv)
    res = json.loads(open(a.out).read()) if os.path.exists(a.out) else {}
    if a.part in ("all", "transects"):
        TRANSECTS["T1_metro_purple_line_tunnel"] = metro_tunnel()
        tc = client()
        tr = {}
        for name, coords in TRANSECTS.items():
            p1, p3 = profiles(tc, coords, "v1"), profiles(tc, coords, "v3")
            e1 = [s["elevation_m"] for s in p1["samples"]]
            e3 = [s["elevation_m"] for s in p3["samples"]]
            dg = [None if (x is None or y is None) else y - x for x, y in zip(e1, e3)]
            k = int(np.nanargmax([abs(d) if d is not None else -1 for d in dg]))
            t = {"length_m": p3["length_m_utm"], "n_samples": len(e3), "v1_min_max": [p1["summary"]["min_m"], p1["summary"]["max_m"]],
                 "v3_min_max": [p3["summary"]["min_m"], p3["summary"]["max_m"]], "v1_nodata": p1["summary"]["n_nodata"], "v3_nodata": p3["summary"]["n_nodata"],
                 "delta_v3_minus_v1_m": _s(dg), "max_abs_at": {"chainage_m": p3["samples"][k]["chainage_m"], "lon": p3["samples"][k]["lon"], "lat": p3["samples"][k]["lat"],
                                                                 "v1": e1[k], "v3": e3[k]},
                 "relief_v1_m": round(p1["summary"]["max_m"] - p1["summary"]["min_m"], 2), "relief_v3_m": round(p3["summary"]["max_m"] - p3["summary"]["min_m"], 2)}
            if name.startswith("T2"):
                t["river_polygon_crossed_m"] = river_crossing_check(coords)
                # lowest sample = river surface/bed in the DSM
                i1 = int(np.nanargmin([x if x is not None else np.nan for x in e1])); i3 = int(np.nanargmin([x if x is not None else np.nan for x in e3]))
                t["lowest_v1"] = {"chainage_m": p1["samples"][i1]["chainage_m"], "elev": e1[i1]}
                t["lowest_v3"] = {"chainage_m": p3["samples"][i3]["chainage_m"], "elev": e3[i3]}
            if name.startswith("T3") or name.startswith("T4"):
                i1 = int(np.nanargmax([x if x is not None else np.nan for x in e1])); i3 = int(np.nanargmax([x if x is not None else np.nan for x in e3]))
                t["summit_v1"] = {"chainage_m": p1["samples"][i1]["chainage_m"], "elev": e1[i1]}
                t["summit_v3"] = {"chainage_m": p3["samples"][i3]["chainage_m"], "elev": e3[i3]}
            if name.startswith("T1"):
                t["depth_impact_4_vertices"] = depth_impact(p1, p3, 4)
                t["depth_impact_osm_vertices"] = {"note": "with a depth at every one of the 68 OSM vertices (~80 m apart)", **depth_impact(p1, p3, len(coords))}
                ev1, ev3 = evidence(tc, coords, "v1"), evidence(tc, coords, "v3")
                c1, c3 = ev1["sewers"]["crossings"], ev3["sewers"]["crossings"]
                pairs = [(x, y) for x, y in zip(c1, c3) if x["pipeline_id"] == y["pipeline_id"]]
                t["sewer_crossings"] = {"n_v1": len(c1), "n_v3": len(c3), "n_paired": len(pairs),
                                        "delta_invert_below_dsm_m": _s([None if (x["invert_below_dsm_m"] is None or y["invert_below_dsm_m"] is None)
                                                                        else y["invert_below_dsm_m"] - x["invert_below_dsm_m"] for x, y in pairs]),
                                        "datum_check_v1": ev1["sewers"].get("datum_check"), "datum_check_v3": ev3["sewers"].get("datum_check")}
            tr[name] = t
        res["transects"] = tr
        os.environ.pop("URBANOS_DEM_VERSION", None)
    if a.part in ("all", "sewers"):
        res["sewer_levels_citywide"] = sewer_levels_citywide(["v1", "v3"])
    if a.part in ("all", "streams"):
        res["streams"] = streams(["v1", "v2", "v3"])
    with open(a.out, "w") as f:
        json.dump(res, f, indent=1, default=str)
    print(json.dumps(res, indent=1, default=str)[:6000])


if __name__ == "__main__":
    sys.exit(main())
