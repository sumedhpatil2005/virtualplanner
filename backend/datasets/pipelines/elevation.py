"""Copernicus DEM GLO-30 (+ NASADEM comparison) -> clipped DEM, hillshade, slope, hydrology (own numpy D8),
web overlays (hillshade / slope PNG in EPSG:4326 with bounds + legend).

CLI: python -m datasets.pipelines.elevation [acquire|process|all]
Copernicus DEM is a DSM (includes buildings and trees): every hydrology output is DERIVED, SCREENING only.
Spec (publisher): absolute vertical accuracy < 4 m LE90; relative < 2 m (slopes <= 20%) / < 4 m (> 20%) LE90;
absolute horizontal < 6 m CE90; vertical datum EGM2008.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from ._common import (DERIVED_DIR, ENGINEERING_EPSG, PUNE_BBOX, download, file_entry, now_ist,
                      one_degree_tiles, raw_dir, today_ist, write_manifest, write_processing)
from . import _hydro as H
from ._raster import diff_stats, hillshade, priority_flood_epsilon, raster_check, slope_degrees, write_cog
from .licences import licence_block

COP_URL = ("https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM/"
           "Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif")
NASADEM_URL = "https://nasademeuwest.blob.core.windows.net/nasadem-cog/v001/NASADEM_HGT_n{lat:02d}e{lon:03d}.tif"
NASADEM_TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/nasademeuwest/nasadem-cog"
VERSION = "v2"              # v2: own numpy D8 hydrology (pysheds removed); v1 kept on disk (pysheds 0.5)
PYSHEDS_VERSION = "v1"
STREAM_THRESHOLD_KM2 = 1.0      # contributing area that starts a mapped stream
OUTLET_THRESHOLD_KM2 = 10.0     # edge outlets whose catchments are delineated
UTM_RES = 30.0
EPSILON_M = 1e-3            # gradient imposed per cell across flats during conditioning


def cop_tile_urls(bbox=PUNE_BBOX) -> list[str]:
    return [COP_URL.format(lat=la, lon=lo) for la, lo in one_degree_tiles(bbox)]


def km2_to_cells(km2: float, cell_m: float) -> int:
    return max(1, int(round(km2 * 1e6 / (cell_m * cell_m))))


D8_OFFSETS = H.OFFSETS
drainage_outlets = H.drainage_outlets  # re-export (tests, older callers)

SLOPE_CLASSES = [  # (upper bound deg, RGBA, label) - display classes only, not a design criterion
    (2.0, (26, 152, 80, 150), "0-2 deg"), (5.0, (145, 207, 96, 150), "2-5 deg"), (10.0, (254, 224, 139, 160), "5-10 deg"),
    (20.0, (252, 141, 89, 170), "10-20 deg"), (90.1, (215, 48, 39, 180), "> 20 deg")]


def compare_with_version(old_dir: Path, fd_a, acc_a, labels, valid, thr, n_streams) -> dict:
    """Agreement of this run with an archived version (v1 = pysheds) on the same grid."""
    import rasterio
    try:
        with rasterio.open(old_dir / "flowdir_d8_esri_epsg32643.tif") as s1:
            ofd = s1.read(1)
        with rasterio.open(old_dir / "flowacc_cells_epsg32643.tif") as s2:
            oacc = s2.read(1)
        with rasterio.open(old_dir / "catchments_edge_outlets_epsg32643.tif") as s3:
            ocat = s3.read(1)
        if ofd.shape != fd_a.shape:
            return {"skipped": f"grid mismatch {ofd.shape} vs {fd_a.shape}"}
        res = H.compare(fd_a, ofd, acc_a, oacc, valid, thr, labels, ocat)
        res["stream_features"] = {"this": n_streams,
                                  "old": len(json.loads((old_dir / "streams_derived_epsg32643.geojson").read_text())["features"])}
        res["old_version"] = old_dir.name
        res["a_is"] = "this version (numpy D8)"
        res["b_is"] = f"{old_dir.name} (pysheds 0.5; -1/-2 = unresolved-flat codes, counted as no-receiver)"
        return res
    except Exception as e:  # pragma: no cover
        return {"skipped": repr(e)}


def render_overlays(out: Path, hs, sl, valid, prof_utm, tr4326, shape4326) -> list[Path]:
    """Hillshade + slope PNG on the EPSG:4326 DEM grid (study bbox) for Cesium SingleTileImageryProvider."""
    import rasterio
    from PIL import Image
    from rasterio.warp import Resampling, reproject

    h, w = shape4326
    west, north = tr4326.c, tr4326.f
    east, south = west + w * tr4326.a, north + h * tr4326.e
    def warp(a, dtype, resamp):
        dst = np.full((h, w), np.nan, "float32")
        reproject(np.where(valid, a, np.nan).astype("float32"), dst, src_transform=prof_utm["transform"],
                  src_crs=prof_utm["crs"], src_nodata=np.nan, dst_transform=tr4326, dst_crs="EPSG:4326",
                  dst_nodata=np.nan, resampling=resamp)
        return dst
    # gradients next to nodata are artefacts of the fill value: drop a 1-cell rim before warping
    pv = np.pad(valid, 1, constant_values=False)
    inner = valid.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            inner &= pv[1 + dy:1 + dy + valid.shape[0], 1 + dx:1 + dx + valid.shape[1]]
    valid = inner
    hs4 = warp(hs.astype("float32"), "float32", Resampling.bilinear)
    sl4 = warp(sl, "float32", Resampling.bilinear)
    ok = np.isfinite(hs4)
    rgba = np.zeros((h, w, 4), "uint8")
    g = np.nan_to_num(hs4).clip(0, 255).astype("uint8")
    rgba[..., 0] = rgba[..., 1] = rgba[..., 2] = g
    rgba[..., 3] = np.where(ok, 170, 0)
    fh = out / "overlay_hillshade_epsg4326.png"
    Image.fromarray(rgba, "RGBA").save(fh, optimize=True)
    rgba = np.zeros((h, w, 4), "uint8")
    lo = -1.0
    for hi, col, _ in SLOPE_CLASSES:
        m = np.isfinite(sl4) & (sl4 > lo) & (sl4 <= hi)
        rgba[m] = col
        lo = hi
    fs = out / "overlay_slope_epsg4326.png"
    Image.fromarray(rgba, "RGBA").save(fs, optimize=True)
    meta = {"bounds_wgs84": {"west": west, "south": south, "east": east, "north": north},
            "crs": "EPSG:4326 (equirectangular PNG, row 0 = north)", "size_px": [w, h],
            "source": "Copernicus DEM GLO-30 (DSM, 2021 release; TanDEM-X acquisitions 2011-2015)",
            "classification": "derived", "suitability": "visualisation",
            "overlays": {
                "hillshade": {"file": fh.name, "legend": "Hillshade, sun azimuth 315 deg, altitude 45 deg (relief shading, no units)"},
                "slope": {"file": fs.name, "legend": [{"label": lab, "rgba": list(col)} for _, col, lab in SLOPE_CLASSES],
                          "units": "degrees, central differences on 30 m UTM grid; DSM: building/tree edges show as steep"}},
            "attribution": "produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space "
                           "GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"}
    fm = out / "overlays.json"
    fm.write_text(json.dumps(meta, indent=2))
    return [fh, fs, fm]


def acquire() -> Path:
    d = raw_dir("copernicus_dem_glo30")
    ents = [download(u, d, timeout=300, note="whole original 1x1 deg COG tile") for u in cop_tile_urls()]
    write_manifest(d, {"source_id": "copernicus_dem_glo30", "dataset": "Copernicus DEM GLO-30 Public (2021 release, AWS)",
                       "licence": licence_block("copernicus_dem_glo30"), "classification": "observed (DSM)",
                       "vertical_datum": "EGM2008 (EPSG:3855)", "spec_accuracy":
                       "abs vertical <4 m LE90; rel vertical <2 m (slope<=20%) / <4 m (>20%); abs horizontal <6 m CE90"},
                   ents)
    # NASADEM comparison (Planetary Computer anonymous SAS token; windowed extract only)
    try:
        import rasterio
        import requests
        from rasterio.windows import from_bounds

        tok = requests.get(NASADEM_TOKEN, timeout=30).json()["token"]
        nd = raw_dir("nasadem_pc")
        nents = []
        for la, lo in one_degree_tiles(PUNE_BBOX):
            url = NASADEM_URL.format(lat=la, lon=lo)
            with rasterio.open(f"{url}?{tok}") as src:
                win = from_bounds(*PUNE_BBOX, transform=src.transform).intersection(
                    rasterio.windows.Window(0, 0, src.width, src.height)).round_offsets().round_lengths()
                arr = src.read(1, window=win)
                prof = src.profile.copy()
                prof.update(driver="GTiff", width=arr.shape[1], height=arr.shape[0], transform=src.window_transform(win),
                            compress="deflate")
                out = nd / f"NASADEM_HGT_n{la:02d}e{lo:03d}_pune_window.tif"
                with rasterio.open(out, "w", **prof) as dst:
                    dst.write(arr, 1)
            nents.append(file_entry(out, url=url, retrieved_at=now_ist(),
                                    notes="windowed extract (bbox) of NASADEM COG; values unmodified; SAS token not stored"))
        write_manifest(nd, {"source_id": "nasadem_pc", "dataset": "NASADEM HGT v001 (Microsoft Planetary Computer mirror)",
                            "licence": {"licence_name": "UNKNOWN (PC STAC says 'proprietary'; NASA LP DAAC states no restrictions - see catalogue)",
                                        "url": "https://planetarycomputer.microsoft.com/dataset/nasadem"},
                            "vertical_datum": "EGM96", "classification": "observed (SRTM C-band, Feb 2000; surface model)"},
                       nents)
    except Exception as e:  # pragma: no cover - optional comparison
        print("NASADEM comparison skipped:", e)
    return d


def _latest(source_id: str) -> Path:
    base = raw_dir(source_id).parent
    return sorted(p for p in base.iterdir() if (p / "manifest.json").exists())[-1]


def process() -> Path:
    import rasterio
    from rasterio.merge import merge
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    raw = _latest("copernicus_dem_glo30")
    tiles = sorted(raw.glob("Copernicus_DSM_COG_*.tif"))
    out = DERIVED_DIR / "elevation_copdem30" / VERSION
    out.mkdir(parents=True, exist_ok=True)
    srcs = [rasterio.open(t) for t in tiles]
    mosaic, mtr = merge(srcs, bounds=PUNE_BBOX, nodata=-32767.0)
    prof4326 = srcs[0].profile.copy()
    for s in srcs:
        s.close()
    dem4326 = mosaic[0].astype("float32")
    prof4326.update(height=dem4326.shape[0], width=dem4326.shape[1], transform=mtr, nodata=-32767.0, dtype="float32")
    f4326 = write_cog(out / "dem_copglo30_epsg4326.tif", dem4326, prof4326)

    dst_crs = f"EPSG:{ENGINEERING_EPSG}"
    tr, w, h = calculate_default_transform("EPSG:4326", dst_crs, dem4326.shape[1], dem4326.shape[0],
                                           *PUNE_BBOX, resolution=UTM_RES)
    dem = np.full((h, w), np.nan, "float32")
    reproject(dem4326, dem, src_transform=mtr, src_crs="EPSG:4326", src_nodata=-32767.0,
              dst_transform=tr, dst_crs=dst_crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
    prof = prof4326.copy()
    prof.update(crs=dst_crs, transform=tr, width=w, height=h, nodata=np.nan, dtype="float32")
    f32643 = write_cog(out / "dem_copglo30_epsg32643_30m.tif", dem, prof)
    fill_val = np.nanmin(dem)
    demf = np.where(np.isfinite(dem), dem, fill_val)
    hs = hillshade(demf, UTM_RES, UTM_RES)
    hs[~np.isfinite(dem)] = 0
    p8 = prof.copy(); p8.update(dtype="uint8", nodata=0)
    fhs = write_cog(out / "hillshade_epsg32643.tif", np.where(np.isfinite(dem), np.maximum(hs, 1), 0).astype("uint8"), p8)
    sl = slope_degrees(demf, UTM_RES, UTM_RES)
    sl[~np.isfinite(dem)] = np.nan
    fsl = write_cog(out / "slope_deg_epsg32643.tif", sl, prof)

    # ---- hydrology (own numpy D8; pysheds/GPL removed in v2) ----
    # Conditioning: Priority-Flood+epsilon (Barnes 2014, _raster.py); D8 / accumulation / catchments / streams:
    # _hydro.py. v1 (pysheds 0.5 on the same conditioned DEM) is kept on disk for comparison.
    valid = np.isfinite(dem)
    cond = priority_flood_epsilon(dem, valid, eps=EPSILON_M)
    pc = prof.copy(); pc.update(dtype="float64", nodata=np.nan)
    fcond = out / "dem_hydro_conditioned_pfeps_epsg32643_float64.tif"
    import rasterio as _rio
    with _rio.open(fcond, "w", **{**pc, "driver": "GTiff"}) as dst:
        dst.write(cond, 1)
    fd_a = H.flow_direction(cond, valid, UTM_RES)
    acc_a = H.accumulation(fd_a, cond, valid).astype("float32")
    filled = np.where(valid, cond, np.nan).astype("float32")
    ffill = write_cog(out / "dem_filled_epsg32643.tif", filled, prof)
    pfd = prof.copy(); pfd.update(dtype="int32", nodata=0)
    ffd = write_cog(out / "flowdir_d8_esri_epsg32643.tif", fd_a, pfd)
    facc = write_cog(out / "flowacc_cells_epsg32643.tif", acc_a, prof)
    thr = km2_to_cells(STREAM_THRESHOLD_KM2, UTM_RES)
    feats = []
    for i, seg in enumerate(H.stream_segments(fd_a, acc_a, thr)):
        coords = [list(tr * (x + 0.5, y + 0.5)) for y, x in seg]
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
                      "properties": {"id": i, "class": "derived", "suitability": "screening",
                                     "max_acc_cells": float(max(acc_a[y, x] for y, x in seg)),
                                     "source": "Copernicus DEM GLO-30 (DSM), Priority-Flood+eps + own numpy D8 "
                                               "(datasets/pipelines/_hydro.py), threshold %s km2" % STREAM_THRESHOLD_KM2}})
    streams = {"type": "FeatureCollection", "features": feats,
               "crs": {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{ENGINEERING_EPSG}"}}}
    fstr = out / "streams_derived_epsg32643.geojson"
    fstr.write_text(json.dumps(streams))
    # catchments for edge outlets with large contributing area (disjoint by construction)
    othr = km2_to_cells(OUTLET_THRESHOLD_KM2, UTM_RES)
    cand = H.drainage_outlets(fd_a, acc_a, valid, othr)
    lab0 = H.label_catchments(fd_a, cond, cand, valid)
    labels = np.zeros(acc_a.shape, "int32")
    outlets = []
    for k, (y, x) in enumerate(cand):
        m = lab0 == k + 1
        if m.sum() < othr:
            continue
        lid = len(outlets) + 1
        labels[m] = lid
        X, Y = tr * (x + 0.5, y + 0.5)
        outlets.append({"id": lid, "row": y, "col": x, "x": X, "y": Y, "area_km2": round(float(m.sum()) * UTM_RES ** 2 / 1e6, 2)})
    fcat = write_cog(out / "catchments_edge_outlets_epsg32643.tif", labels, pfd)
    (out / "catchment_outlets.json").write_text(json.dumps(outlets, indent=2))
    pysheds_cmp = compare_with_version(out.parent / PYSHEDS_VERSION, fd_a, acc_a, labels, valid, thr, len(feats))

    # ---- web overlays (EPSG:4326 PNG + bounds, for Explore) ----
    overlays = render_overlays(out, hs, sl, valid, prof, mtr, dem4326.shape)

    # ---- NASADEM comparison ----
    cmp = {}
    try:
        nraw = _latest("nasadem_pc")
        nd_tiles = sorted(nraw.glob("NASADEM_*.tif"))
        nsrcs = [rasterio.open(t) for t in nd_tiles]
        nm, ntr = merge(nsrcs, bounds=PUNE_BBOX)
        nnod = nsrcs[0].nodata
        for s in nsrcs:
            s.close()
        nd = np.full(dem.shape, np.nan, "float32")
        reproject(nm[0].astype("float32"), nd, src_transform=ntr, src_crs="EPSG:4326", src_nodata=nnod,
                  dst_transform=tr, dst_crs=dst_crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
        cmp = {"cop_minus_nasadem_m": diff_stats(dem, nd),
               "note": "COP (TanDEM-X 2011-2015, EGM2008) minus NASADEM (SRTM Feb-2000, EGM96); both surface models; "
                       "positive tail expected where buildings/trees appeared after 2000; datum difference not corrected."}
        fdiff = write_cog(out / "diff_cop_minus_nasadem_epsg32643.tif", (dem - nd).astype("float32"), prof)
    except Exception as e:  # pragma: no cover
        cmp = {"skipped": repr(e)}
        fdiff = None
    outputs = [f4326, f32643, fhs, fsl, ffill, fcond, ffd, facc, fstr, fcat, out / "catchment_outlets.json"] + \
        ([fdiff] if fdiff else []) + overlays
    validation = {"rasters": [raster_check(p) for p in outputs if p.suffix == ".tif"],
                  "stream_features": len(streams["features"]), "catchments": len(outlets),
                  "catchments_area_km2": round(sum(o["area_km2"] for o in outlets), 1),
                  "nasadem_comparison": cmp,
                  "comparison_with_pysheds_v1": pysheds_cmp,
                  "depression_fill_mean_m": float(np.nanmean(filled - demf)),
                  "depression_fill_max_m": float(np.nanmax(filled - demf))}
    write_processing(out, pipeline="datasets.pipelines.elevation", inputs=tiles, parameters={
        "bbox": PUNE_BBOX, "utm_res_m": UTM_RES, "resampling": "bilinear", "hydro_conditioning": "Priority-Flood+epsilon (Barnes 2014), eps=%g m" % EPSILON_M, "hydro_lib": "own numpy D8 (datasets/pipelines/_hydro.py; replaces GPL pysheds used in v1)",
        "supersedes_for_hydrology": PYSHEDS_VERSION,
        "stream_threshold_km2": STREAM_THRESHOLD_KM2, "outlet_threshold_km2": OUTLET_THRESHOLD_KM2},
        outputs=outputs, validation=validation, suitability="screening",
        notes="DSM (buildings/trees included): flow paths in dense urban fabric follow rooftops/tree canopy, not drains. "
              "Catchments clipped to the study box are partial for rivers entering from outside (Mula/Mutha headwaters). "
              "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 "
              "provided under COPERNICUS by the European Union and ESA; all rights reserved")
    return out


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("acquire", "all"):
        print("raw:", acquire())
    if step in ("process", "all"):
        print("derived:", process())
