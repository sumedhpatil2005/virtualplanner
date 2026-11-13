"""Sentinel-2 L2A (Element84 Earth Search STAC, no auth) -> NDVI / NDWI / MNDWI / NDBI + simple built-up change.

CLI:  python -m datasets.pipelines.sentinel2 [acquire|process|all]
Classification: DERIVED, suitability SCREENING (single-date spectral indices; not a land-use survey).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from ._common import (DERIVED_DIR, ENGINEERING_EPSG, PUNE_BBOX, file_entry, now_ist, raw_dir,
                      today_ist, write_manifest, write_processing)
from .licences import licence_block

STAC = "https://earth-search.aws.element84.com/v1"
COLLECTION = "sentinel-2-l2a"
# Chosen 2026-11-13: lowest-cloud post-monsoon scenes of MGRS 43QCA (tile fully contains the bbox), seasonally matched (November).
SCENES = {"recent": "S2C_43QCA_20251114_0_L2A", "baseline": "S2A_43QCA_20191126_1_L2A"}
BANDS = {"green": "B03", "red": "B04", "nir": "B08", "swir16": "B11", "scl": "SCL"}
SOURCE_ID = "sentinel2_l2a_earthsearch"
VERSION = "v1"
# SCL classes treated as valid surface: 4 vegetation, 5 not-vegetated, 6 water, 7 unclassified, 11 snow
SCL_VALID = (4, 5, 6, 7, 11)


# ---------- pure functions (unit-tested) ----------
def norm_diff(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(a-b)/(a+b) in float32; NaN where a+b <= 0 or either input is NaN. Inputs must be >= 0."""
    a = a.astype("float32")
    b = b.astype("float32")
    s = a + b
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(s > 0, (a - b) / s, np.nan)
    return out.astype("float32")


def to_reflectance(dn: np.ndarray, scale: float, offset: float, nodata: int = 0) -> np.ndarray:
    """DN -> surface reflectance; negative values (dark targets after the -0.1 offset of baseline >= 04.00)
    are clipped to 0 so normalised differences stay within [-1, 1]."""
    r = np.clip(dn.astype("float32") * scale + offset, 0.0, None)
    r[dn == nodata] = np.nan
    return r


def effective_offset(dn: np.ndarray, scale: float, declared_offset: float, nodata: int = 0) -> float:
    """Earth Search v1 declares offset -0.1 (BOA_ADD_OFFSET of baseline >= 04.00) but some COGs are already
    harmonised (no +1000 in DN). If >= 1% of valid DNs are below the offset magnitude, the offset cannot be
    present (reflectance would be negative), so return 0.0; otherwise the declared offset."""
    v = dn[dn != nodata]
    if declared_offset >= 0 or v.size == 0:
        return declared_offset
    return 0.0 if np.percentile(v, 1) < (-declared_offset / scale) else declared_offset


def agreement(pred: np.ndarray, ref: np.ndarray, valid: np.ndarray) -> dict:
    """Binary agreement of pred vs ref (both bool) over valid pixels: precision, recall, F1, IoU."""
    p, r = pred[valid], ref[valid]
    tp = float((p & r).sum()); fp = float((p & ~r).sum()); fn = float((~p & r).sum())
    prec = tp / (tp + fp) if tp + fp else float("nan")
    rec = tp / (tp + fn) if tp + fn else float("nan")
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else float("nan")
    return {"precision": round(prec, 3), "recall": round(rec, 3), "f1": round(f1, 3),
            "iou": round(tp / (tp + fp + fn), 3) if tp + fp + fn else float("nan")}


def valid_mask_from_scl(scl: np.ndarray, valid=SCL_VALID) -> np.ndarray:
    return np.isin(scl, valid)


def builtup_mask(ndbi: np.ndarray, ndvi: np.ndarray, mndwi: np.ndarray,
                 ndbi_thr: float = 0.0, ndvi_thr: float = 0.25, mndwi_thr: float = 0.0) -> np.ndarray:
    """Very simple built-up/bare screening rule (documented thresholds, NOT a classifier)."""
    return (ndbi > ndbi_thr) & (ndvi < ndvi_thr) & (mndwi < mndwi_thr)


def change_classes(before: np.ndarray, after: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """uint8: 0 nodata, 1 stable non-built, 2 stable built, 3 new built (gain), 4 lost built."""
    out = np.zeros(before.shape, "uint8")
    out[valid & ~before & ~after] = 1
    out[valid & before & after] = 2
    out[valid & ~before & after] = 3
    out[valid & before & ~after] = 4
    return out


# ---------- acquisition ----------
def _item(item_id: str):
    from pystac_client import Client

    return Client.open(STAC).get_collection(COLLECTION).get_item(item_id)


def acquire() -> Path:
    """Windowed (bbox) reads of each band via /vsicurl; pixel values are copied unmodified (no resampling)."""
    import rasterio
    from rasterio.warp import transform_bounds
    from rasterio.windows import from_bounds

    d = raw_dir(SOURCE_ID, today_ist())
    entries = []
    for label, item_id in SCENES.items():
        it = _item(item_id)
        ij = d / f"{item_id}.stac-item.json"
        ij.write_text(json.dumps(it.to_dict(), indent=2))
        entries.append(file_entry(ij, url=f"{STAC}/collections/{COLLECTION}/items/{item_id}",
                                  retrieved_at=now_ist(), notes=f"STAC item ({label})"))
        for key, bname in BANDS.items():
            href = it.assets[key].href
            with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"):
                with rasterio.open(href) as src:
                    b = transform_bounds("EPSG:4326", src.crs, *PUNE_BBOX, densify_pts=21)
                    win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
                    arr = src.read(1, window=win, boundless=False)
                    prof = src.profile.copy()
                    prof.update(width=arr.shape[1], height=arr.shape[0], transform=src.window_transform(win),
                                compress="deflate", tiled=True, blockxsize=512, blockysize=512, driver="GTiff")
                    out = d / f"{item_id}_{bname}_pune_window.tif"
                    with rasterio.open(out, "w", **prof) as dst:
                        dst.write(arr, 1)
            rb = (it.assets[key].extra_fields.get("raster:bands") or [{}])[0]
            entries.append(file_entry(out, url=href, retrieved_at=now_ist(), source_crs=str(src.crs),
                                      window=[int(win.col_off), int(win.row_off), int(win.width), int(win.height)],
                                      raster_band_meta=rb,
                                      notes=f"{label} scene {item_id} band {bname}: windowed extract of the source COG "
                                            "(bbox in source CRS, values unmodified)"))
    write_manifest(d, {"source_id": SOURCE_ID, "dataset": "Sentinel-2 L2A COGs (Earth Search v1)",
                       "stac_api": STAC, "licence": licence_block("sentinel2_l2a"),
                       "classification": "observed (surface reflectance, ESA L2A processor)",
                       "notes": "Raw originals are windowed extracts, not whole 110x110 km granules (size budget)."},
                   entries)
    return d


# ---------- processing ----------
def _latest_raw() -> Path:
    base = Path(raw_dir(SOURCE_ID)).parent
    return sorted(p for p in base.iterdir() if (p / "manifest.json").exists())[-1]


def process(raw: Path | None = None) -> Path:
    import rasterio
    from rasterio.enums import Resampling

    raw = raw or _latest_raw()
    man = json.loads((raw / "manifest.json").read_text())
    meta = {f["filename"]: f for f in man["files"]}
    out = DERIVED_DIR / "sentinel2_indices" / VERSION
    out.mkdir(parents=True, exist_ok=True)
    inputs, outputs, validation = [], [], {}
    masks = {}
    offsets_used: dict = {}
    ref_profile = None
    for label, item_id in SCENES.items():
        bands = {}
        for key, bname in BANDS.items():
            p = raw / f"{item_id}_{bname}_pune_window.tif"
            inputs.append(p)
            with rasterio.open(p) as src:
                if ref_profile is None and bname == "B04":
                    ref_profile = src.profile.copy()
                    ref_shape = (src.height, src.width)
                if (src.height, src.width) != (ref_profile["height"], ref_profile["width"]) if ref_profile else False:
                    arr = src.read(1, out_shape=(ref_profile["height"], ref_profile["width"]), resampling=Resampling.nearest)
                else:
                    arr = src.read(1)
            rb = meta[p.name].get("raster_band_meta", {})
            if key != "scl":
                sc = rb.get("scale", 1e-4)
                off = effective_offset(arr, sc, rb.get("offset", 0.0))
                offsets_used[f"{item_id}:{bname}"] = {"declared": rb.get("offset"), "applied": off}
                bands[key] = to_reflectance(arr, sc, off)
            else:
                bands[key] = arr
        valid = valid_mask_from_scl(bands["scl"]) & np.isfinite(bands["red"])
        idx = {
            "ndvi": norm_diff(bands["nir"], bands["red"]),
            "ndwi": norm_diff(bands["green"], bands["nir"]),
            "mndwi": norm_diff(bands["green"], bands["swir16"]),
            "ndbi": norm_diff(bands["swir16"], bands["nir"]),
        }
        prof = ref_profile.copy()
        prof.update(dtype="float32", nodata=np.nan, compress="deflate", predictor=3, tiled=True,
                    blockxsize=512, blockysize=512)
        stats = {"valid_fraction": float(valid.mean())}
        for name, a in idx.items():
            a = np.where(valid, a, np.nan).astype("float32")
            fp = out / f"{name}_{label}_{item_id[4:9]}_{item_id[10:18]}.tif"
            with rasterio.open(fp, "w", **prof) as dst:
                dst.write(a, 1)
            outputs.append(fp)
            stats[name] = {"mean": float(np.nanmean(a)), "p5": float(np.nanpercentile(a, 5)),
                           "p95": float(np.nanpercentile(a, 95)), "in_range_-1_1": bool(np.nanmin(a) >= -1 and np.nanmax(a) <= 1)}
        bu = builtup_mask(idx["ndbi"], idx["ndvi"], idx["mndwi"]) & valid
        masks[label] = (bu, valid)
        stats["builtup_fraction_of_valid"] = float(bu.sum() / max(valid.sum(), 1))
        validation[label] = {"scene": item_id, **stats}
    (b0, v0), (b1, v1) = masks["baseline"], masks["recent"]
    ch = change_classes(b0, b1, v0 & v1)
    prof = ref_profile.copy()
    prof.update(dtype="uint8", nodata=0, compress="deflate", tiled=True, blockxsize=512, blockysize=512)
    fp = out / "builtup_change_2019-11-26_to_2025-11-14.tif"
    with rasterio.open(fp, "w", **prof) as dst:
        dst.write(ch, 1)
        dst.write_colormap(1, {0: (0, 0, 0, 0), 1: (220, 220, 220, 255), 2: (120, 120, 120, 255),
                               3: (220, 30, 30, 255), 4: (30, 120, 220, 255)})
    outputs.append(fp)
    px_ha = abs(prof["transform"].a * prof["transform"].e) / 1e4
    validation["change"] = {k: round(float((ch == v).sum()) * px_ha, 1) for k, v in
                            {"stable_nonbuilt_ha": 1, "stable_built_ha": 2, "gain_ha": 3, "loss_ha": 4}.items()}
    # Measurable check: 2025 rule vs ESA WorldCover 2021 built-up (also a model output -> agreement, not accuracy)
    wcp = DERIVED_DIR / "landcover_worldcover2021" / "v1" / "worldcover2021_epsg32643_10m.tif"
    if wcp.exists():
        from rasterio.warp import Resampling as _R, reproject as _rp
        wc = np.zeros(b1.shape, "uint8")
        with rasterio.open(wcp) as w:
            _rp(w.read(1), wc, src_transform=w.transform, src_crs=w.crs, dst_transform=ref_profile["transform"],
                dst_crs=ref_profile["crs"], resampling=_R.nearest)
        vv = v1 & (wc > 0)
        validation["rule_vs_worldcover2021_builtup"] = {"recent_2025": agreement(b1, wc == 50, vv),
                                                        "baseline_2019": agreement(b0, wc == 50, v0 & (wc > 0))}
    validation["crs"] = str(ref_profile["crs"])
    validation["offsets"] = offsets_used
    validation["pixel_m"] = prof["transform"].a
    write_processing(out, pipeline="datasets.pipelines.sentinel2", inputs=inputs,
                     parameters={"scenes": SCENES, "scl_valid": SCL_VALID,
                                 "builtup_rule": "NDBI>0 & NDVI<0.25 & MNDWI<0 (screening rule, not validated)",
                                 "swir16_resampling": "nearest 20m->10m", "negative_reflectance": "clipped to 0"},
                     outputs=outputs, validation=validation, suitability="screening",
                     notes="Indices are DERIVED single-date values; built-up change mixes real change with "
                           "phenology/soil-moisture differences and has NOT been accuracy-assessed. "
                           "Attribution: Contains modified Copernicus Sentinel data 2019, 2025.")
    return out


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("acquire", "all"):
        print("raw:", acquire())
    if step in ("process", "all"):
        print("derived:", process())
