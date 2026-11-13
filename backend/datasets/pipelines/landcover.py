"""ESA WorldCover 2021 v200 -> Pune clip (EPSG:4326 native + EPSG:32643 10 m) and class areas per zone.

Zones: study bbox; PMC and PCMC extents = union of DataMeet community-traced electoral wards (INFERRED boundaries,
CC BY-SA 2.5 IN) until an official boundary is ingested.
CLI: python -m datasets.pipelines.landcover [acquire|process|all]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

from ._common import DERIVED_DIR, ENGINEERING_EPSG, PUNE_BBOX, download, raw_dir, write_manifest, write_processing
from ._raster import raster_check, write_cog
from .licences import licence_block

WC_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
WARDS = {
    "pmc": "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Pune/pune-electoral-wards_2022.geojson",
    "pcmc": "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/PCMC/pcmc-electoral-wards.geojson",
}
CLASSES = {10: "Tree cover", 20: "Shrubland", 30: "Grassland", 40: "Cropland", 50: "Built-up",
           60: "Bare / sparse vegetation", 70: "Snow and ice", 80: "Permanent water bodies",
           90: "Herbaceous wetland", 95: "Mangroves", 100: "Moss and lichen"}
VERSION = "v1"


# ---------- pure functions (unit-tested) ----------
def worldcover_tile(lon: float, lat: float) -> str:
    """WorldCover 3x3 degree tile name containing the point (lower-left corner naming)."""
    la = int(math.floor(lat / 3) * 3)
    lo = int(math.floor(lon / 3) * 3)
    return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"


def class_areas(classes: np.ndarray, pixel_area_m2: float, mask: np.ndarray | None = None) -> dict:
    a = classes if mask is None else classes[mask]
    a = a[a > 0]
    vals, cnt = np.unique(a, return_counts=True)
    tot = cnt.sum() if cnt.size else 1
    return {CLASSES.get(int(v), str(int(v))): {"km2": round(float(c) * pixel_area_m2 / 1e6, 3),
                                               "pct": round(100.0 * float(c) / tot, 2)} for v, c in zip(vals, cnt)}


# ---------- acquisition ----------
def acquire() -> list[Path]:
    tiles = sorted({worldcover_tile(x, y) for x in (PUNE_BBOX[0], PUNE_BBOX[2]) for y in (PUNE_BBOX[1], PUNE_BBOX[3])})
    d = raw_dir("esa_worldcover_2021_v200")
    ents = [download(WC_URL.format(tile=t), d, timeout=600, note="whole original 3x3 deg tile") for t in tiles]
    write_manifest(d, {"source_id": "esa_worldcover_2021_v200", "licence": licence_block("esa_worldcover_2021_v200"),
                       "classification": "inferred (ML classifier output on Sentinel-1/2 2021)",
                       "accuracy_note": "publisher validation reports global overall accuracy (see PUM v2.0); "
                                        "no Pune-specific accuracy available"}, ents)
    w = raw_dir("datameet_municipal_wards")
    went = [download(u, w, note=f"{k.upper()} electoral wards, community traced") for k, u in WARDS.items()]
    write_manifest(w, {"source_id": "datameet_municipal_wards",
                       "classification": "inferred (PMC 2022: manually traced from PMC PDF ward maps; PCMC: scraped from shelter-associates.org)",
                       "licence": {"licence_name": "CC BY-SA 2.5 India",
                                   "quote": "shared under Creative Commons Attribution-ShareAlike 2.5 India license.",
                                   "url": "https://github.com/datameet/Municipal_Spatial_Data/blob/master/Pune/Readme.md",
                                   "url_pcmc": "https://github.com/datameet/Municipal_Spatial_Data/blob/master/PCMC/Readme.md",
                                   "verified_at": "2026-11-13T21:45+05:30"}}, went)
    return [d, w]


def _latest(source_id: str) -> Path:
    base = raw_dir(source_id).parent
    return sorted(p for p in base.iterdir() if (p / "manifest.json").exists())[-1]


# ---------- processing ----------
def process() -> Path:
    import geopandas as gpd
    import rasterio
    from rasterio.features import geometry_mask
    from rasterio.merge import merge
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    raw = _latest("esa_worldcover_2021_v200")
    tiles = sorted(raw.glob("ESA_WorldCover_*_Map.tif"))
    out = DERIVED_DIR / "landcover_worldcover2021" / VERSION
    out.mkdir(parents=True, exist_ok=True)
    srcs = [rasterio.open(t) for t in tiles]
    m, mtr = merge(srcs, bounds=PUNE_BBOX)
    prof = srcs[0].profile.copy()
    try:
        cmap = srcs[0].colormap(1)
    except ValueError:
        cmap = None
    for s in srcs:
        s.close()
    wc = m[0]
    prof.update(height=wc.shape[0], width=wc.shape[1], transform=mtr, nodata=0)
    f4326 = write_cog(out / "worldcover2021_epsg4326.tif", wc, prof, colormap=cmap)
    dst = f"EPSG:{ENGINEERING_EPSG}"
    tr, w, h = calculate_default_transform("EPSG:4326", dst, wc.shape[1], wc.shape[0], *PUNE_BBOX, resolution=10.0)
    wu = np.zeros((h, w), "uint8")
    reproject(wc, wu, src_transform=mtr, src_crs="EPSG:4326", src_nodata=0, dst_transform=tr, dst_crs=dst,
              dst_nodata=0, resampling=Resampling.nearest)
    p2 = prof.copy()
    p2.update(crs=dst, transform=tr, width=w, height=h)
    f32643 = write_cog(out / "worldcover2021_epsg32643_10m.tif", wu, p2, colormap=cmap)

    zones: dict = {"study_bbox": None}
    zone_meta = {}
    wraw = _latest("datameet_municipal_wards")
    for k in ("pmc", "pcmc"):
        fn = Path(WARDS[k]).name
        g = gpd.read_file(wraw / fn)
        if g.crs is None:
            g = g.set_crs(4326)
        g = g.to_crs(ENGINEERING_EPSG)
        g["geometry"] = g.geometry.make_valid()
        u = g.union_all()
        zones[k] = u
        b = gpd.GeoSeries([u], crs=ENGINEERING_EPSG).to_crs(4326).total_bounds
        zone_meta[k] = {"wards": int(len(g)), "area_km2": round(u.area / 1e6, 2), "source_file": fn,
                        "bounds_4326": [round(float(x), 4) for x in b],
                        "inside_study_bbox": bool(b[0] >= PUNE_BBOX[0] and b[1] >= PUNE_BBOX[1] and b[2] <= PUNE_BBOX[2] and b[3] <= PUNE_BBOX[3]),
                        "classification": "inferred boundary (union of community-traced wards)"}
    areas = {}
    for k, geom in zones.items():
        mask = np.ones(wu.shape, bool) if geom is None else ~geometry_mask([geom], out_shape=wu.shape, transform=tr)
        mask &= wu > 0
        areas[k] = {"pixels": int(mask.sum()), "area_km2": round(mask.sum() * 100 / 1e6, 2),
                    "classes": class_areas(wu, 100.0, mask)}
    (out / "class_areas.json").write_text(json.dumps({"zones": zone_meta, "areas": areas}, indent=2))
    validation = {"rasters": [raster_check(f4326), raster_check(f32643)], "zones": zone_meta,
                  "classes_present": sorted(int(v) for v in np.unique(wc) if v),
                  "built_up_pct": {k: v["classes"].get("Built-up", {}).get("pct") for k, v in areas.items()}}
    write_processing(out, pipeline="datasets.pipelines.landcover", inputs=tiles + sorted(wraw.glob("*.geojson")),
                     parameters={"bbox": PUNE_BBOX, "utm_resampling": "nearest 10 m",
                                 "area_method": "pixel count x 100 m2 in EPSG:32643"},
                     outputs=[f4326, f32643, out / "class_areas.json"], validation=validation, classification="inferred",
                     suitability="screening",
                     notes="Classes are ML classifier output (inferred; a nearest-neighbour clip/reprojection keeps them inferred). PMC/PCMC zones are INFERRED from community-traced ward maps, "
                           "not official municipal limits; parts outside the study bbox are not counted. "
                           "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium.")
    return out


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("acquire", "all"):
        print("raw:", acquire())
    if step in ("process", "all"):
        print("derived:", process())
