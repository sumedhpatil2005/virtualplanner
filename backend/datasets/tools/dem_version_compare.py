"""Measured comparison of elevation_copdem30 versions (v1 / v2 / v3) — docs/urbanos/DEM_V1_V3_COMPARISON.md.

Reads the actual files (rasterio), never processing.json claims. Memory-modest: the study-box rasters are ~5 MB each;
the raw 1x1 deg tiles are read through windows only.

    cd backend && python -m datasets.tools.dem_version_compare --out /path/to/result.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys

import numpy as np

from datasets import paths

DS = "elevation_copdem30"
BOX = (73.70, 18.40, 74.05, 18.70)
UTM = "dem_copglo30_epsg32643_30m.tif"
GEO = "dem_copglo30_epsg4326.tif"
RAW_TILES = {73: "Copernicus_DSM_COG_10_N18_00_E073_00_DEM.tif", 74: "Copernicus_DSM_COG_10_N18_00_E074_00_DEM.tif"}


def _stats(d: np.ndarray) -> dict:
    d = d[np.isfinite(d)]
    if d.size == 0:
        return {"n": 0}
    a = np.abs(d)
    return {"n": int(d.size), "mean": round(float(d.mean()), 3), "rms": round(float(np.sqrt((d ** 2).mean())), 3),
            "std": round(float(d.std()), 3), "p5": round(float(np.percentile(d, 5)), 3), "p95": round(float(np.percentile(d, 95)), 3),
            "le90_abs": round(float(np.percentile(a, 90)), 3), "max_abs": round(float(a.max()), 3),
            "frac_abs_gt_1m": round(float((a > 1).mean()), 4), "frac_abs_gt_5m": round(float((a > 5).mean()), 4),
            "frac_exact_zero": round(float((d == 0).mean()), 4)}


def raster_meta(path) -> dict:
    import rasterio
    with rasterio.open(path) as s:
        z = s.read(1, masked=False).astype("float64")
        nod = s.nodata
        bad = ~np.isfinite(z) if (nod is None or (isinstance(nod, float) and math.isnan(nod))) else (z == nod) | ~np.isfinite(z)
        return {"crs": s.crs.to_string(), "res": [abs(s.res[0]), abs(s.res[1])], "shape": [s.height, s.width],
                "bounds": [round(v, 6) for v in s.bounds], "dtype": s.dtypes[0], "nodata": None if nod is None else (str(nod)),
                "units": list(s.units), "tags": s.tags(), "vertical_crs_in_file": ("VERT_CS" in s.crs.to_wkt() or "VERTCRS" in s.crs.to_wkt()),
                "n_cells": int(z.size), "n_nodata": int(bad.sum()), "min": float(np.nanmin(np.where(bad, np.nan, z))),
                "max": float(np.nanmax(np.where(bad, np.nan, z)))}


def geo_box_nodata(path) -> dict:
    """Nodata among 4326 pixels whose centre lies inside the study box."""
    import rasterio
    with rasterio.open(path) as s:
        z = s.read(1).astype("float64")
        t = s.transform
        cols = t.c + (np.arange(s.width) + 0.5) * t.a
        rows = t.f + (np.arange(s.height) + 0.5) * t.e
        inc = (cols >= BOX[0]) & (cols <= BOX[2])
        inr = (rows >= BOX[1]) & (rows <= BOX[3])
        sub = z[np.ix_(inr, inc)]
        bad = (sub == s.nodata) | ~np.isfinite(sub)
        # do the pixels reach the box edges? (centre within half a pixel of each edge)
        reach = {"west": float(cols[inc][0] - BOX[0]), "east": float(BOX[2] - cols[inc][-1]),
                 "south": float(rows[inr][-1] - BOX[1]), "north": float(BOX[3] - rows[inr][0])}
        return {"n_in_box": int(sub.size), "n_nodata_in_box": int(bad.sum()), "pct_nodata_in_box": round(100 * float(bad.mean()), 4),
                "edge_gap_deg_centre_to_box": {k: round(v, 7) for k, v in reach.items()}}


def utm_box_mask(path):
    """(z float64 with NaN nodata, transform, mask of cells whose centre lon/lat is inside the study box, lon, lat)."""
    import rasterio
    from pyproj import Transformer
    with rasterio.open(path) as s:
        z = s.read(1).astype("float64")
        t = s.transform
        h, w = s.height, s.width
        crs = s.crs.to_string()
    xs = t.c + (np.arange(w) + 0.5) * t.a
    ys = t.f + (np.arange(h) + 0.5) * t.e
    X, Y = np.meshgrid(xs, ys)
    inv = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    lon, lat = inv.transform(X, Y)
    m = (lon >= BOX[0]) & (lon <= BOX[2]) & (lat >= BOX[1]) & (lat <= BOX[3])
    return z, t, m, lon, lat


def raw_bilinear(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Bilinear on the raw Copernicus tiles (pixel centres at whole arc-seconds, AREA_OR_POINT=Point handled by GDAL's
    half-pixel origin), windowed reads per tile."""
    import rasterio
    from rasterio.windows import Window
    out = np.full(lon.shape, np.nan)
    rd = paths.raw_dir() / "copernicus_dem_glo30"
    date_dir = sorted(p for p in rd.iterdir() if p.is_dir())[-1]
    for deg, fn in RAW_TILES.items():
        sel = (lon >= deg) & (lon < deg + 1)
        if not sel.any():
            continue
        with rasterio.open(date_dir / fn) as s:
            t = s.transform
            col = (lon[sel] - t.c) / t.a - 0.5
            row = (lat[sel] - t.f) / t.e - 0.5
            c0, r0 = int(np.floor(col.min())) - 1, int(np.floor(row.min())) - 1
            c1, r1 = int(np.ceil(col.max())) + 2, int(np.ceil(row.max())) + 2
            c0, r0 = max(c0, 0), max(r0, 0)
            c1, r1 = min(c1, s.width), min(r1, s.height)
            z = s.read(1, window=Window(c0, r0, c1 - c0, r1 - r0)).astype("float64")
        cc, rr = col - c0, row - r0
        ci = np.clip(np.floor(cc).astype(int), 0, z.shape[1] - 2)
        ri = np.clip(np.floor(rr).astype(int), 0, z.shape[0] - 2)
        fc, fr = np.clip(cc - ci, 0, 1), np.clip(rr - ri, 0, 1)
        v = (z[ri, ci] * (1 - fc) * (1 - fr) + z[ri, ci + 1] * fc * (1 - fr) + z[ri + 1, ci] * (1 - fc) * fr + z[ri + 1, ci + 1] * fc * fr)
        out[sel] = v
    return out


def app_sample(version: str, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """The app's own sampler (terrain.dem.Dem.sample_xy) — scalar loop, used for the random-point check."""
    from terrain.dem import Dem
    d = Dem(paths.derived_version_dir(DS, version))
    x, y = d.fwd.transform(lon, lat)
    return np.array([np.nan if (v := d.sample_xy(a, b)[0]) is None else v for a, b in zip(x, y)])


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n-random", type=int, default=4000)
    a = ap.parse_args(argv)
    res: dict = {"study_box_wgs84": BOX, "versions": {}}
    vdirs = {v: paths.derived_version_dir(DS, v) for v in ("v1", "v2", "v3")}
    for v, d in vdirs.items():
        proc = json.loads((d / "processing.json").read_text())
        res["versions"][v] = {"dir": str(d), "git_commit": proc.get("git_commit"), "run_at": proc.get("run_at"),
                              "inputs": [(i["path"].split("/")[-1], i["sha256"][:12]) for i in proc.get("inputs", [])],
                              "hydro_lib": proc.get("parameters", {}).get("hydro_lib"),
                              "geo": raster_meta(d / GEO), "utm": raster_meta(d / UTM), "geo_box": geo_box_nodata(d / GEO)}
        z, t, m, lon, lat = utm_box_mask(d / UTM)
        bad = ~np.isfinite(z) & m
        res["versions"][v]["utm_box"] = {"n_in_box": int(m.sum()), "n_nodata_in_box": int(bad.sum()),
                                         "pct_nodata_in_box": round(100 * float(bad.sum() / m.sum()), 4),
                                         "n_nodata_outside_box": int((~np.isfinite(z) & ~m).sum())}
    # raw tile metadata
    import rasterio
    rd = paths.raw_dir() / "copernicus_dem_glo30"
    date_dir = sorted(p for p in rd.iterdir() if p.is_dir())[-1]
    res["raw"] = {}
    for fn in RAW_TILES.values():
        with rasterio.open(date_dir / fn) as s:
            res["raw"][fn] = {"crs_wkt_has_vertical": ("VERT" in s.crs.to_wkt()), "tags": s.tags(), "res": list(s.res),
                              "bounds": list(s.bounds), "dtype": s.dtypes[0], "nodata": s.nodata, "units": list(s.units)}
    res["raw"]["manifest"] = {k: v for k, v in json.loads((date_dir / "manifest.json").read_text()).items() if k != "files"}

    # random points vs raw truth, through the app sampler
    rng = np.random.default_rng(42)
    lon = rng.uniform(BOX[0] + 0.002, BOX[2] - 0.002, a.n_random)
    lat = rng.uniform(BOX[1] + 0.002, BOX[3] - 0.002, a.n_random)
    truth = raw_bilinear(lon, lat)
    samp = {v: app_sample(v, lon, lat) for v in vdirs}
    res["random_points_vs_raw"] = {"n": a.n_random, "seed": 42, "method": "terrain.dem.Dem.sample_xy (app path) minus raw-tile bilinear",
                                   **{v: _stats(samp[v] - truth) for v in vdirs}}
    # shift search: at which offset does each version best match raw truth?
    from pyproj import Transformer
    fwd = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
    inv = Transformer.from_crs("EPSG:32643", "EPSG:4326", always_xy=True)
    X, Y = fwd.transform(lon[:1500], lat[:1500])
    best = {}
    for v in ("v1", "v3"):
        from terrain.dem import Dem
        dm = Dem(vdirs[v])
        grid = []
        for dx in (-15, 0, 15):
            for dy in (-15, 0, 15):
                lo, la = inv.transform(X + dx, Y + dy)
                tv = raw_bilinear(np.asarray(lo), np.asarray(la))
                sv = np.array([np.nan if (q := dm.sample_xy(xx, yy)[0]) is None else q for xx, yy in zip(X, Y)])
                d = sv - tv
                grid.append({"dx_m": dx, "dy_m": dy, "rmse": round(float(np.sqrt(np.nanmean(d ** 2))), 3)})
        best[v] = {"grid": grid, "best": min(grid, key=lambda g: g["rmse"])}
    res["offset_search_utm_m"] = best

    # full-grid differences on the common UTM grid (same origin; v1 1239 cols, v3 1238)
    z1, t1, m1, lon1, lat1 = utm_box_mask(vdirs["v1"] / UTM)
    z2, *_ = utm_box_mask(vdirs["v2"] / UTM)
    z3, t3, m3, lon3, lat3 = utm_box_mask(vdirs["v3"] / UTM)
    assert t1 == t3
    w = min(z1.shape[1], z3.shape[1])
    z1c, z2c, z3c, m = z1[:, :w], z2[:, :w], z3[:, :w], m3[:, :w]
    d31 = np.where(m, z3c - z1c, np.nan)
    d21 = np.where(m, z2c - z1c, np.nan)
    res["grid_diff_v3_minus_v1"] = _stats(d31)
    res["grid_diff_v2_minus_v1"] = _stats(d21)
    # where differences cluster
    gy, gx = np.gradient(z3c, 30.0)  # gy per row (southward because row increases south)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    cl = {}
    for lo_, hi_ in ((0, 2), (2, 5), (5, 10), (10, 20), (20, 90)):
        s = m & (slope >= lo_) & (slope < hi_) & np.isfinite(d31)
        cl[f"slope_{lo_}-{hi_}deg"] = {"n": int(s.sum()), "rms": round(float(np.sqrt(np.nanmean(d31[s] ** 2))), 3) if s.any() else None,
                                       "p95_abs": round(float(np.percentile(np.abs(d31[s]), 95)), 3) if s.any() else None}
    # edges: within 2 cells of the box limit
    core = m.copy()
    for _ in range(2):  # 2-cell erosion with numpy (no scipy dependency)
        e = core.copy()
        e[1:, :] &= core[:-1, :]; e[:-1, :] &= core[1:, :]; e[:, 1:] &= core[:, :-1]; e[:, :-1] &= core[:, 1:]
        e[0, :] = e[-1, :] = False; e[:, 0] = e[:, -1] = False
        core = e
    for name, sel in (("box_edge_<=2cells", m & ~core), ("interior_>2cells", core),
                      ("tile_seam_lon_74.000_+-60m", m & (np.abs(lon3[:, :w] - 74.0) < 60 / (111320 * math.cos(math.radians(18.55))))),
                      ("away_from_seam", m & (np.abs(lon3[:, :w] - 74.0) >= 60 / (111320 * math.cos(math.radians(18.55)))))):
        s = sel & np.isfinite(d31)
        cl[name] = {"n": int(s.sum()), "rms": round(float(np.sqrt(np.mean(d31[s] ** 2))), 3) if s.any() else None,
                    "p95_abs": round(float(np.percentile(np.abs(d31[s]), 95)), 3) if s.any() else None}
    # water (JRC GSW occurrence >= 50 %, same UTM grid)
    with rasterio.open(paths.derived_version_dir("surface_water_jrc_gsw", "v1") / "gsw_v1_5_occurrence_epsg32643_30m.tif") as s:
        assert s.transform == t3
        occ = s.read(1)[:, :w]
    water = (occ >= 50) & (occ != 255)
    for name, sel in (("water_gsw_occ>=50%", m & water), ("land", m & ~water)):
        s = sel & np.isfinite(d31)
        cl[name] = {"n": int(s.sum()), "rms": round(float(np.sqrt(np.mean(d31[s] ** 2))), 3) if s.any() else None,
                    "p95_abs": round(float(np.percentile(np.abs(d31[s]), 95)), 3) if s.any() else None}
    # nodata-only cells (valid in one version only)
    cl["valid_v3_nodata_v1_in_box"] = int((m & np.isfinite(z3c) & ~np.isfinite(z1c)).sum())
    cl["valid_v1_nodata_v3_in_box"] = int((m & np.isfinite(z1c) & ~np.isfinite(z3c)).sum())
    # how much of the difference is explained by a pure planimetric shift: regress d31 on gx, gy
    s = m & np.isfinite(d31) & np.isfinite(gx) & np.isfinite(gy)
    A = np.c_[gx[s], gy[s], np.ones(s.sum())]
    coef, *_ = np.linalg.lstsq(A, d31[s], rcond=None)
    pred = A @ coef
    r2 = 1 - np.sum((d31[s] - pred) ** 2) / np.sum((d31[s] - d31[s].mean()) ** 2)
    # z3(x) - z1(x) = z(x) - z(x - s) ~ grad . s  -> s = (coef_x, -coef_y in northing since gy is per row southward)
    cl["shift_regression"] = {"dz ~ a*dz/dx_east + b*dz/drow_south + c": [round(float(c), 3) for c in coef], "r2": round(float(r2), 4),
                              "implied_v1_displacement_m": {"east": round(float(-coef[0]), 2), "north": round(float(coef[1]), 2)}}
    res["grid_diff_clusters"] = cl
    # slope raster changes
    with rasterio.open(vdirs["v1"] / "slope_deg_epsg32643.tif") as s:
        s1 = s.read(1)[:, :w].astype("float64")
    with rasterio.open(vdirs["v3"] / "slope_deg_epsg32643.tif") as s:
        s3 = s.read(1)[:, :w].astype("float64")
    res["slope_diff_v3_minus_v1_deg"] = _stats(np.where(m, s3 - s1, np.nan))
    with open(a.out, "w") as f:
        json.dump(res, f, indent=1, default=str)
    print(json.dumps({k: res[k] for k in ("random_points_vs_raw", "grid_diff_v3_minus_v1", "grid_diff_v2_minus_v1")}, indent=1))


if __name__ == "__main__":
    sys.exit(main())
