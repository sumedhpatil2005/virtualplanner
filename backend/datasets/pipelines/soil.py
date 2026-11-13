"""SoilGrids 250 m v2.0 (ISRIC WCS, native Homolosine grid, no server-side resampling) -> Pune screening layers.

CLI: python -m datasets.pipelines.soil [acquire|process|all]
SoilGrids is a global machine-learning prediction (publisher: 30-70% variance explained) with URBAN AREAS
MASKED OUT (ESA CCI LC 2015 urban class): it carries NO information for most of the Pune core. SCREENING only;
never a substitute for site investigation (boreholes, SPT, lab tests).
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import numpy as np

from ._common import DERIVED_DIR, ENGINEERING_EPSG, PUNE_BBOX, download, raw_dir, write_manifest, write_processing
from ._raster import write_cog
from .licences import licence_block

WCS = ("https://maps.isric.org/mapserv?map=/map/{prop}.map&SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage"
       "&COVERAGEID={prop}_{depth}_mean&FORMAT=image/tiff&SUBSET=x({x0},{x1})&SUBSET=y({y0},{y1})")
IGH = "+proj=igh +datum=WGS84 +no_defs"
PROPS = {  # name: (conversion factor to conventional unit, conventional unit) per SoilGrids_faqs_01
    "clay": (10, "%"), "sand": (10, "%"), "silt": (10, "%"), "bdod": (100, "kg/dm3"), "soc": (10, "g/kg"),
    "cfvo": (10, "vol%"), "wv0033": (10, "vol%"), "wv1500": (10, "vol%"),
}
DEPTHS = ("0-5cm", "5-15cm", "15-30cm", "30-60cm")
VERSION = "v1"


# ---------- pure functions (unit-tested) ----------
def igh_window(bbox=PUNE_BBOX, cell: float = 250.0) -> tuple[float, float, float, float]:
    """bbox (lon/lat) -> snapped Homolosine window (x0, y0, x1, y1) on the 250 m SoilGrids grid."""
    from pyproj import Transformer

    t = Transformer.from_crs("EPSG:4326", IGH, always_xy=True)
    xs, ys = [], []
    for i in range(5):
        for j in range(5):
            x, y = t.transform(bbox[0] + (bbox[2] - bbox[0]) * i / 4, bbox[1] + (bbox[3] - bbox[1]) * j / 4)
            xs.append(x); ys.append(y)
    return (math.floor(min(xs) / cell) * cell, math.floor(min(ys) / cell) * cell,
            math.ceil(max(xs) / cell) * cell, math.ceil(max(ys) / cell) * cell)


def depth_weighted_mean(layers: list[np.ndarray], thickness_cm: list[float]) -> np.ndarray:
    """Thickness-weighted mean of depth layers; NaN propagates (masked cells stay NaN)."""
    w = np.asarray(thickness_cm, "float64")
    st = np.stack([a.astype("float64") for a in layers])
    return (np.tensordot(w, st, axes=1) / w.sum()).astype("float32")


def usda_texture(sand: float, silt: float, clay: float) -> str:
    """USDA soil texture class from % sand/silt/clay (standard NRCS triangle rules). '' if input invalid."""
    if any(np.isnan(v) for v in (sand, silt, clay)):
        return ""
    if silt + 1.5 * clay < 15:
        return "sand"
    if silt + 1.5 * clay >= 15 and silt + 2 * clay < 30:
        return "loamy sand"
    if (7 <= clay < 20 and sand > 52 and silt + 2 * clay >= 30) or (clay < 7 and silt < 50 and silt + 2 * clay >= 30):
        return "sandy loam"
    if 7 <= clay < 27 and 28 <= silt < 50 and sand <= 52:
        return "loam"
    if (silt >= 50 and 12 <= clay < 27) or (50 <= silt < 80 and clay < 12):
        return "silt loam"
    if silt >= 80 and clay < 12:
        return "silt"
    if 20 <= clay < 35 and silt < 28 and sand > 45:
        return "sandy clay loam"
    if 27 <= clay < 40 and 20 < sand <= 45:
        return "clay loam"
    if 27 <= clay < 40 and sand <= 20:
        return "silty clay loam"
    if clay >= 35 and sand > 45:
        return "sandy clay"
    if clay >= 40 and silt >= 40:
        return "silty clay"
    if clay >= 40 and sand <= 45 and silt < 40:
        return "clay"
    return "unclassified"


# ---------- acquisition ----------
def acquire() -> Path:
    d = raw_dir("soilgrids_250m_v2")
    x0, y0, x1, y1 = igh_window()
    ents, failed = [], []
    for prop in PROPS:
        for depth in DEPTHS:
            url = WCS.format(prop=prop, depth=depth, x0=int(x0), x1=int(x1), y0=int(y0), y1=int(y1))
            try:
                ents.append(download(url, d, f"{prop}_{depth}_mean_pune_igh.tif", timeout=120,
                                     note="WCS GetCoverage subset on native IGH 250 m grid (no resampling); "
                                          "server writes masked cells as 0 (no nodata tag)"))
            except Exception as e:  # pragma: no cover - network
                failed.append({"prop": prop, "depth": depth, "error": repr(e)[:200]})
            time.sleep(1.0)  # be polite to the public WCS
    write_manifest(d, {"source_id": "soilgrids_250m_v2", "licence": licence_block("soilgrids_250m_v2"),
                       "classification": "estimated (Quantile Random Forest predictions)",
                       "crs": IGH, "window_igh": [x0, y0, x1, y1], "failed": failed,
                       "units_reference": "https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_01.html"}, ents)
    return d


def _latest() -> Path:
    base = raw_dir("soilgrids_250m_v2").parent
    return sorted(p for p in base.iterdir() if (p / "manifest.json").exists())[-1]


# ---------- processing ----------
def process() -> Path:
    import rasterio
    from rasterio.crs import CRS
    from rasterio.warp import Resampling, calculate_default_transform, reproject

    raw = _latest()
    out = DERIVED_DIR / "soil_soilgrids250" / VERSION
    out.mkdir(parents=True, exist_ok=True)
    inputs, outputs = [], []
    conv: dict[str, list[np.ndarray]] = {}
    src_prof = None
    for prop, (fac, unit) in PROPS.items():
        layers = []
        for depth in DEPTHS:
            p = raw / f"{prop}_{depth}_mean_pune_igh.tif"
            if not p.exists():
                break
            inputs.append(p)
            with rasterio.open(p) as s:
                a = s.read(1).astype("float32")
                src_prof = s.profile.copy()
            a[a <= 0] = np.nan  # 0 = masked (urban/water/bare) -> nodata; no physical 0 expected for these props
            layers.append(a / fac)
        if len(layers) == len(DEPTHS):
            conv[prop] = layers
    thick = [5, 10, 15]  # 0-5, 5-15, 15-30
    top30 = {p: depth_weighted_mean(v[:3], thick) for p, v in conv.items()}
    if "wv0033" in top30 and "wv1500" in top30:
        top30["awc_proxy"] = (top30["wv0033"] - top30["wv1500"]).astype("float32")  # vol%: FC(33 kPa) - PWP(1500 kPa)
    dst = f"EPSG:{ENGINEERING_EPSG}"
    src_crs = CRS.from_proj4(IGH)
    h0, w0 = next(iter(top30.values())).shape
    left, top = src_prof["transform"].c, src_prof["transform"].f
    from rasterio.transform import array_bounds
    sb = array_bounds(h0, w0, src_prof["transform"])
    tr, w, h = calculate_default_transform(src_crs, dst, w0, h0, sb[0], sb[1], sb[2], sb[3], resolution=250.0)
    stats = {}
    for name, a in top30.items():
        u = np.full((h, w), np.nan, "float32")
        reproject(a, u, src_transform=src_prof["transform"], src_crs=src_crs, src_nodata=np.nan, dst_transform=tr,
                  dst_crs=dst, dst_nodata=np.nan, resampling=Resampling.nearest)
        prof = src_prof.copy(); prof.update(crs=dst, transform=tr, width=w, height=h, dtype="float32", nodata=np.nan)
        outputs.append(write_cog(out / f"soil_{name}_0-30cm_epsg32643_250m.tif", u, prof))
        fin = a[np.isfinite(a)]
        stats[name] = {"unit": PROPS.get(name, (None, "vol%"))[1], "masked_fraction": round(float(np.isnan(a).mean()), 3),
                       **({"p5": round(float(np.percentile(fin, 5)), 2), "median": round(float(np.median(fin)), 2),
                           "p95": round(float(np.percentile(fin, 95)), 2)} if fin.size else {})}
    if {"sand", "silt", "clay"} <= top30.keys():
        tex = np.vectorize(usda_texture, otypes=[object])(top30["sand"], top30["silt"], top30["clay"])
        vals, cnt = np.unique(tex[tex != ""], return_counts=True)
        stats["usda_texture_0-30cm_cells"] = {str(v): int(c) for v, c in zip(vals, cnt)}
        s = top30["sand"] + top30["silt"] + top30["clay"]
        stats["sand+silt+clay_pct"] = {"median": round(float(np.nanmedian(s)), 1), "min": round(float(np.nanmin(s)), 1),
                                      "max": round(float(np.nanmax(s)), 1)}
    # Masking vs WorldCover built-up (does the mask remove the city?)
    wcp = DERIVED_DIR / "landcover_worldcover2021" / "v1" / "worldcover2021_epsg32643_10m.tif"
    if wcp.exists() and "clay" in top30:
        with rasterio.open(outputs[0]) as g, rasterio.open(wcp) as wc:
            ref = np.zeros((g.height, g.width), "uint8")
            reproject(wc.read(1), ref, src_transform=wc.transform, src_crs=wc.crs, dst_transform=g.transform,
                      dst_crs=g.crs, resampling=Resampling.mode)
            clay = g.read(1)
        built = ref == 50
        stats["masked_fraction_where_worldcover_builtup"] = round(float(np.isnan(clay[built]).mean()), 3) if built.any() else None
        stats["masked_fraction_elsewhere"] = round(float(np.isnan(clay[(~built) & (ref > 0)]).mean()), 3)
    write_processing(out, pipeline="datasets.pipelines.soil", inputs=inputs,
                     parameters={"depths": DEPTHS, "top30_weights_cm": thick, "zero_as_nodata": True,
                                 "utm": "nearest 250 m", "awc_proxy": "wv0033 - wv1500 (vol%)",
                                 "texture": "USDA triangle on 0-30 cm weighted sand/silt/clay (SoilGrids silt definition is mixed USDA/ISO)"},
                     outputs=outputs, validation=stats, classification="estimated", suitability="screening",
                     notes="SoilGrids 2.0, ISRIC (CC BY 4.0). Global ML predictions; urban areas masked; NOT for foundation "
                           "design, bearing capacity, or infiltration design. Hydrologic soil group NOT assigned (needs a "
                           "verified NRCS table and local data).")
    return out


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("acquire", "all"):
        print("raw:", acquire())
    if step in ("process", "all"):
        print("derived:", process())
