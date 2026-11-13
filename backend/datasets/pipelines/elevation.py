"""Copernicus DEM GLO-30 (+ NASADEM comparison) -> clipped DEM, hillshade, slope, hydrology (pysheds).

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

if not hasattr(np, "in1d"):  # pysheds 0.5 still calls np.in1d (removed in NumPy 2.4)
    np.in1d = np.isin  # type: ignore[attr-defined]

from ._common import (DERIVED_DIR, ENGINEERING_EPSG, PUNE_BBOX, download, file_entry, now_ist,
                      one_degree_tiles, raw_dir, today_ist, write_manifest, write_processing)
from ._raster import diff_stats, hillshade, priority_flood_epsilon, raster_check, slope_degrees, write_cog
from .licences import licence_block

COP_URL = ("https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM/"
           "Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif")
NASADEM_URL = "https://nasademeuwest.blob.core.windows.net/nasadem-cog/v001/NASADEM_HGT_n{lat:02d}e{lon:03d}.tif"
NASADEM_TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/nasademeuwest/nasadem-cog"
VERSION = "v1"
STREAM_THRESHOLD_KM2 = 1.0      # contributing area that starts a mapped stream
OUTLET_THRESHOLD_KM2 = 10.0     # edge outlets whose catchments are delineated
UTM_RES = 30.0
EPSILON_M = 1e-3            # gradient imposed per cell across flats during conditioning


def cop_tile_urls(bbox=PUNE_BBOX) -> list[str]:
    return [COP_URL.format(lat=la, lon=lo) for la, lo in one_degree_tiles(bbox)]


def km2_to_cells(km2: float, cell_m: float) -> int:
    return max(1, int(round(km2 * 1e6 / (cell_m * cell_m))))


D8_OFFSETS = {64: (-1, 0), 128: (-1, 1), 1: (0, 1), 2: (1, 1), 4: (1, 0), 8: (1, -1), 16: (0, -1), 32: (-1, -1)}


def drainage_outlets(fdir: np.ndarray, acc: np.ndarray, valid: np.ndarray, min_cells: int) -> list[tuple[int, int]]:
    """Valid cells with acc >= min_cells whose D8 receiver is off-grid / invalid, or that have no direction
    (pysheds marks sinks/flats with 0, -1, -2). Sorted by accumulation, largest first."""
    h, w = fdir.shape
    res = []
    ys, xs = np.where(valid & (acc >= min_cells))
    for y, x in zip(ys.tolist(), xs.tolist()):
        d = int(fdir[y, x])
        if d not in D8_OFFSETS:
            res.append((y, x))
            continue
        dy, dx = D8_OFFSETS[d]
        ny, nx = y + dy, x + dx
        if not (0 <= ny < h and 0 <= nx < w) or not valid[ny, nx]:
            res.append((y, x))
    res.sort(key=lambda p: -acc[p])
    return res


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

    # ---- hydrology (pysheds) ----
    from pysheds.grid import Grid

    # Conditioning: Priority-Flood+epsilon (own implementation, see _raster.py) because pysheds 0.5
    # resolve_flats leaves unresolved flats (-1/-2) on the flattened river surfaces of COP-DEM.
    cond = priority_flood_epsilon(dem, np.isfinite(dem), eps=EPSILON_M)
    pc = prof.copy(); pc.update(dtype="float64", nodata=np.nan)
    fcond = out / "dem_hydro_conditioned_pfeps_epsg32643_float64.tif"
    import rasterio as _rio
    with _rio.open(fcond, "w", **{**pc, "driver": "GTiff"}) as dst:
        dst.write(cond, 1)
    grid = Grid.from_raster(str(fcond))
    infl = grid.read_raster(str(fcond))
    flooded = infl
    dirmap = (64, 128, 1, 2, 4, 8, 16, 32)
    fdir = grid.flowdir(infl, dirmap=dirmap)
    acc = grid.accumulation(fdir, dirmap=dirmap)
    filled = np.asarray(flooded, "float32")
    ffill = write_cog(out / "dem_filled_epsg32643.tif", filled, prof)
    pfd = prof.copy(); pfd.update(dtype="int32", nodata=0)
    ffd = write_cog(out / "flowdir_d8_esri_epsg32643.tif", np.asarray(fdir, "int32"), pfd)
    acc_a = np.asarray(acc, "float32")
    facc = write_cog(out / "flowacc_cells_epsg32643.tif", acc_a, prof)
    thr = km2_to_cells(STREAM_THRESHOLD_KM2, UTM_RES)
    streams = grid.extract_river_network(fdir, acc > thr, dirmap=dirmap)
    fstr = out / "streams_derived_epsg32643.geojson"
    for i, f in enumerate(streams["features"]):
        f["properties"] = {"id": i, "class": "derived", "suitability": "screening",
                           "source": "Copernicus DEM GLO-30 (DSM) via pysheds D8, threshold %s km2" % STREAM_THRESHOLD_KM2}
    streams["crs"] = {"type": "name", "properties": {"name": f"urn:ogc:def:crs:EPSG::{ENGINEERING_EPSG}"}}
    fstr.write_text(json.dumps(streams))
    # catchments for edge outlets with large contributing area
    othr = km2_to_cells(OUTLET_THRESHOLD_KM2, UTM_RES)
    valid = np.isfinite(dem)
    fd_a = np.asarray(fdir)
    labels = np.zeros(acc_a.shape, "int32")
    outlets = []
    for y, x in drainage_outlets(fd_a, acc_a, valid, othr):
        if labels[y, x]:
            continue
        c = np.asarray(grid.catchment(x=x, y=y, fdir=fdir, dirmap=dirmap, xytype="index"), bool)
        new = c & (labels == 0)
        if new.sum() < othr:
            continue
        lid = len(outlets) + 1
        labels[new] = lid
        X, Y = tr * (x + 0.5, y + 0.5)
        outlets.append({"id": lid, "row": y, "col": x, "x": X, "y": Y, "area_km2": round(float(new.sum()) * UTM_RES ** 2 / 1e6, 2)})
    fcat = write_cog(out / "catchments_edge_outlets_epsg32643.tif", labels, pfd)
    (out / "catchment_outlets.json").write_text(json.dumps(outlets, indent=2))

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
    outputs = [f4326, f32643, fhs, fsl, ffill, fcond, ffd, facc, fstr, fcat, out / "catchment_outlets.json"] + ([fdiff] if fdiff else [])
    validation = {"rasters": [raster_check(p) for p in outputs if p.suffix == ".tif"],
                  "stream_features": len(streams["features"]), "catchments": len(outlets),
                  "catchments_area_km2": round(sum(o["area_km2"] for o in outlets), 1),
                  "nasadem_comparison": cmp,
                  "depression_fill_mean_m": float(np.nanmean(filled - demf)),
                  "depression_fill_max_m": float(np.nanmax(filled - demf))}
    write_processing(out, pipeline="datasets.pipelines.elevation", inputs=tiles, parameters={
        "bbox": PUNE_BBOX, "utm_res_m": UTM_RES, "resampling": "bilinear", "hydro_conditioning": "Priority-Flood+epsilon (Barnes 2014), eps=%g m" % EPSILON_M, "hydro_lib": "pysheds 0.5 D8 flowdir/accumulation/catchment/extract_river_network",
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
