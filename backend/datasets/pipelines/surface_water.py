"""JRC Global Surface Water (v1.5 1984-2024 primary, v1.4 1984-2021 for comparison) -> Pune clips + stats.

CLI: python -m datasets.pipelines.surface_water [acquire|process|all]
Landsat-derived 30 m water history: DERIVED, SCREENING (cannot see channels narrower than ~30 m, nor
water under bridges/canopy; not a flood-extent or flood-hazard map).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from ._common import DERIVED_DIR, ENGINEERING_EPSG, PUNE_BBOX, download, raw_dir, write_manifest, write_processing
from ._raster import raster_check, write_cog
from .licences import licence_block

V15 = "https://s3.waw4-1.cloudferro.com/swift/v1/global-surface-water/download2024/Aggregated/VER1-5/{layer}/{layer}_{tile}_v1_5_2024.tif"
V14 = "https://storage.googleapis.com/global-surface-water/downloads2021/{layer}/{layer}_{tile}v1_4_2021.tif"
LAYERS_V15 = ("occurrence", "extent", "seasonality")
LAYERS_V14 = ("occurrence", "extent")
VERSION = "v1"


def gsw_tile(lon: float, lat: float) -> str:
    """GSW 10x10 degree tile id, named by its west edge and NORTH edge (e.g. 70E_20N covers 70-80E, 10-20N)."""
    import math

    lo = int(math.floor(lon / 10) * 10)
    la = int(math.ceil(lat / 10) * 10)
    return f"{abs(lo)}{'E' if lo >= 0 else 'W'}_{abs(la)}{'N' if la >= 0 else 'S'}"


def occurrence_summary(occ: np.ndarray, pixel_area_m2: float) -> dict:
    """occ: 0-100 (% of valid observations with water), 255 = nodata (per GSW users guide)."""
    v = occ[(occ <= 100)]
    return {"ever_water_km2": round(float((v > 0).sum()) * pixel_area_m2 / 1e6, 3),
            "occ_ge_50_km2": round(float((v >= 50).sum()) * pixel_area_m2 / 1e6, 3),
            "occ_ge_90_km2": round(float((v >= 90).sum()) * pixel_area_m2 / 1e6, 3),
            "nodata_fraction": round(float((occ > 100).mean()), 4)}


def acquire() -> Path:
    tiles = sorted({gsw_tile(x, y) for x in (PUNE_BBOX[0], PUNE_BBOX[2]) for y in (PUNE_BBOX[1], PUNE_BBOX[3])})
    d = raw_dir("jrc_gsw")
    ents = []
    for t in tiles:
        ents += [download(V15.format(layer=lyr, tile=t), d, timeout=600, note="v1.5 (1984-2024) whole 10x10 deg tile")
                 for lyr in LAYERS_V15]
        ents += [download(V14.format(layer=lyr, tile=t), d, timeout=600, note="v1.4 (1984-2021, deprecated) whole tile")
                 for lyr in LAYERS_V14]
    write_manifest(d, {"source_id": "jrc_gsw", "licence": licence_block("jrc_gsw"),
                       "classification": "derived (Landsat water classification 1984-2024)",
                       "notes": "Publisher notes v1.5 corrected occurrence consistency and (2026-11-10) out-of-range values; "
                                "Collection-1/2 co-registration offset can reach ~1 pixel (30 m)."}, ents)
    return d


def _latest() -> Path:
    base = raw_dir("jrc_gsw").parent
    return sorted(p for p in base.iterdir() if (p / "manifest.json").exists())[-1]


def _clip(path: Path):
    import rasterio
    from rasterio.windows import from_bounds

    with rasterio.open(path) as src:
        win = from_bounds(*PUNE_BBOX, transform=src.transform).round_offsets().round_lengths()
        a = src.read(1, window=win)
        prof = src.profile.copy()
        prof.update(width=a.shape[1], height=a.shape[0], transform=src.window_transform(win))
        try:
            cmap = src.colormap(1)
        except ValueError:
            cmap = None
    return a, prof, cmap


def process() -> Path:
    import rasterio
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    raw = _latest()
    out = DERIVED_DIR / "surface_water_jrc_gsw" / VERSION
    out.mkdir(parents=True, exist_ok=True)
    tile = gsw_tile(PUNE_BBOX[0], PUNE_BBOX[1])
    inputs, outputs, stats = [], [], {}
    arrays = {}
    for ver, layers, pat in (("v1_5", LAYERS_V15, "{layer}_{tile}_v1_5_2024.tif"), ("v1_4", LAYERS_V14, "{layer}_{tile}v1_4_2021.tif")):
        for lyr in layers:
            p = raw / pat.format(layer=lyr, tile=tile)
            inputs.append(p)
            a, prof, cmap = _clip(p)
            arrays[(ver, lyr)] = a
            prof.update(nodata=255)
            f = write_cog(out / f"gsw_{ver}_{lyr}_epsg4326.tif", a, prof, colormap=cmap)
            outputs.append(f)
            if lyr == "occurrence":
                # pixel area at this latitude for a 0.00025 deg grid
                lat0 = (PUNE_BBOX[1] + PUNE_BBOX[3]) / 2
                px = (abs(prof["transform"].a) * 111320 * np.cos(np.radians(lat0))) * (abs(prof["transform"].e) * 110574)
                stats[f"{ver}_occurrence"] = occurrence_summary(a, px)
                stats[f"{ver}_pixel_area_m2"] = round(float(px), 1)
                if ver == "v1_5":
                    dst = f"EPSG:{ENGINEERING_EPSG}"
                    tr, w, h = calculate_default_transform("EPSG:4326", dst, a.shape[1], a.shape[0], *PUNE_BBOX, resolution=30.0)
                    u = np.full((h, w), 255, "uint8")
                    reproject(a, u, src_transform=prof["transform"], src_crs="EPSG:4326", src_nodata=255,
                              dst_transform=tr, dst_crs=dst, dst_nodata=255, resampling=Resampling.nearest)
                    pu = prof.copy(); pu.update(crs=dst, transform=tr, width=w, height=h)
                    outputs.append(write_cog(out / "gsw_v1_5_occurrence_epsg32643_30m.tif", u, pu, colormap=cmap))
    o15, o14 = arrays[("v1_5", "occurrence")], arrays[("v1_4", "occurrence")]
    if o15.shape == o14.shape:
        m = (o15 <= 100) & (o14 <= 100)
        d = o15[m].astype(int) - o14[m].astype(int)
        stats["occurrence_v15_minus_v14"] = {"mean": round(float(d.mean()), 3), "abs_gt_10_fraction_of_ever_water":
                                             round(float((np.abs(d) > 10).sum()) / max(int(((o15[m] > 0) | (o14[m] > 0)).sum()), 1), 3)}
    stats["out_of_range_v15_occurrence_pixels"] = int(((o15 > 100) & (o15 != 255)).sum())
    stats["rasters"] = [raster_check(p) for p in outputs]
    write_processing(out, pipeline="datasets.pipelines.surface_water", inputs=inputs,
                     parameters={"bbox": PUNE_BBOX, "tile": tile, "clip": "window read on native 0.00025 deg grid, no resampling",
                                 "utm": "nearest 30 m (occurrence v1.5 only)"},
                     outputs=outputs, validation=stats, suitability="screening",
                     notes="Source: EC JRC/Google. Pekel et al. 2016, Nature 540, 418-422. Occurrence = % of valid Landsat "
                           "observations classified as water; it is NOT a flood return period or inundation depth.")
    return out


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("acquire", "all"):
        print("raw:", acquire())
    if step in ("process", "all"):
        print("derived:", process())
