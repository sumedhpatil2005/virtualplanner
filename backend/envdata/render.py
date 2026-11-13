"""Server-side raster rendering for the current view: reproject a window of a derived GeoTIFF onto an EPSG:4326 grid for
the requested bbox (GDAL warper via rasterio.warp.reproject: only the source blocks the window needs are read), colour it
with the layer's legend, return a PNG. Cached on disk by (file sha256/mtime, variant, bbox, size). Values outside the
data, nodata and NaN are transparent. Class-area statistics read the EPSG:32643 copies (equal-area-enough at 10 m).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from typing import Sequence

import numpy as np

from . import paths
from .catalogue import Layer, WORLDCOVER_CLASSES, file_path

MAX_PX = 1600


def _hex(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def parse_bbox(s: str) -> list[float]:
    try:
        b = [float(v) for v in s.split(",")]
    except ValueError as e:
        raise ValueError("bbox must be minLon,minLat,maxLon,maxLat") from e
    if len(b) != 4 or not (b[0] < b[2] and b[1] < b[3]) or not (-180 <= b[0] <= 180 and -90 <= b[1] <= 90):
        raise ValueError("bbox must be minLon,minLat,maxLon,maxLat with min < max")
    return b


def out_size(bbox: Sequence[float], width: int) -> tuple[int, int]:
    w = max(16, min(MAX_PX, int(width)))
    h = int(round(w * (bbox[3] - bbox[1]) / (bbox[2] - bbox[0])))
    if h > MAX_PX:
        w, h = max(16, int(w * MAX_PX / h)), MAX_PX
    return w, max(16, h)


def colourise(arr: np.ndarray, spec: dict, nodata) -> np.ndarray:
    """arr (h, w) float/int → RGBA uint8. Pure, unit-tested."""
    h, w = arr.shape
    out = np.zeros((h, w, 4), dtype=np.uint8)
    a = arr.astype("float64")
    valid = np.isfinite(a)
    if nodata is not None and not (isinstance(nodata, float) and np.isnan(nodata)):
        valid &= a != nodata
    alpha = int(spec.get("alpha", 240))
    if spec["mode"] == "categorical":
        for v, c in spec["palette"].items():
            m = valid & (a == v)
            out[m, 0], out[m, 1], out[m, 2] = _hex(c)
            out[m, 3] = alpha
        return out
    stops = spec["stops"]
    tb = spec.get("transparent_below")
    if tb is not None:
        valid &= a >= tb
    xs = np.array([s[0] for s in stops], dtype="float64")
    cols = np.array([_hex(s[1]) for s in stops], dtype="float64")
    v = np.clip(np.nan_to_num(a, nan=xs[0]), xs[0], xs[-1])
    for ch in range(3):
        out[..., ch] = np.interp(v, xs, cols[:, ch]).astype(np.uint8)
    out[..., 3] = np.where(valid, alpha, 0).astype(np.uint8)
    out[~valid, :3] = 0
    return out


def _read_view(path, bbox, w, h, categorical: bool) -> tuple[np.ndarray, object]:
    import rasterio
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject
    with rasterio.open(path) as src:
        nodata = src.nodata
        dst = np.full((h, w), np.nan if np.issubdtype(np.dtype(src.dtypes[0]), np.floating) else (nodata if nodata is not None else 0),
                      dtype=src.dtypes[0])
        fill = np.nan if np.issubdtype(dst.dtype, np.floating) else (nodata if nodata is not None else 0)
        reproject(rasterio.band(src, 1), dst, dst_transform=from_bounds(*bbox, w, h), dst_crs="EPSG:4326",
                  dst_nodata=fill, resampling=Resampling.nearest if categorical else Resampling.bilinear)
        return dst, nodata if nodata is not None else fill


def _png(rgba: np.ndarray) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def render_png(layer: Layer, bbox: Sequence[float], width: int, variant: str | None) -> tuple[bytes, dict]:
    if layer.render is None:
        raise ValueError(f"{layer.id} has no raster renderer")
    p = file_path(layer, variant or (layer.variants[0]["id"] if layer.variants else None))
    if p is None or not p.exists():
        raise FileNotFoundError(f"{layer.id}: file not on disk")
    spec = dict(layer.render)
    if variant and layer.variants:
        v = next(x for x in layer.variants if x["id"] == variant)
        if v.get("legend"):
            spec["stops"] = [(s["value"], s["color"]) for s in v["legend"]["stops"]]
    w, h = out_size(bbox, width)
    st = p.stat()
    key = hashlib.sha256(json.dumps([str(p), st.st_mtime, st.st_size, variant, [round(x, 6) for x in bbox], w, h,
                                     json.dumps(spec, sort_keys=True, default=str)]).encode()).hexdigest()[:32]
    cp = paths.cache_dir() / f"{layer.id}_{key}.png"
    meta = {"bounds": [round(x, 6) for x in bbox], "width": w, "height": h, "file": p.name, "variant": variant}
    if cp.exists():
        return cp.read_bytes(), {**meta, "cache": "hit"}
    arr, nodata = _read_view(p, bbox, w, h, spec["mode"] == "categorical")
    data = _png(colourise(arr, spec, nodata))
    tmp = cp.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, cp)
    return data, {**meta, "cache": "miss"}


# ── statistics ────────────────────────────────────────────────────────────────

def _utm_geom(geom_4326: dict):
    from pyproj import Transformer
    from shapely.geometry import shape

    from coordination.geometry import reproject
    t = Transformer.from_crs("EPSG:4326", "EPSG:32643", always_xy=True)
    return reproject(shape(geom_4326), t)


def landcover_areas(layer: Layer, geom_4326: dict) -> dict:
    """Class areas inside a WGS84 polygon from the 10 m EPSG:32643 copy (pixel centre inside → counted)."""
    import rasterio
    from rasterio.features import geometry_mask
    from rasterio.windows import from_bounds
    p = paths.derived(layer.dataset, layer.version, "worldcover2021_epsg32643_10m.tif")
    g = _utm_geom(geom_4326)
    if g.is_empty or g.area <= 0:
        raise ValueError("area is empty")
    if g.area > 2.0e9:
        raise ValueError("area larger than 2,000 km²; zoom in")
    with rasterio.open(p) as src:
        px_area = abs(src.transform.a * src.transform.e)
        from shapely.geometry import box as _box
        if not g.intersects(_box(*src.bounds)):
            return {"area_km2": round(g.area / 1e6, 4), "pixels": 0, "nodata_pixels": 0, "pixel_m2": px_area, "classes": [],
                    "out_of_coverage": True, "method": "no overlap with the land-cover raster (outside the Pune study box): UNKNOWN",
                    "data_class": "derived", "suitability": "screening"}
        win = from_bounds(*g.bounds, src.transform).round_offsets().round_lengths()
        win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        arr = src.read(1, window=win)
        tr = src.window_transform(win)
    inside = ~geometry_mask([g.__geo_interface__], out_shape=arr.shape, transform=tr, all_touched=False)
    vals = arr[inside]
    total_px = int(vals.size)
    nod = int((vals == 0).sum())
    if total_px == 0:
        return {"area_km2": round(g.area / 1e6, 4), "pixels": 0, "nodata_pixels": 0, "pixel_m2": px_area, "classes": [], "out_of_coverage": True,
                "method": "area smaller than one 10 m pixel centre", "data_class": "derived", "suitability": "screening"}
    names = {v: (n, c) for v, n, c in WORLDCOVER_CLASSES}
    classes = []
    valid_px = total_px - nod
    for v in sorted(set(np.unique(vals).tolist()) - {0}):
        n = int((vals == v).sum())
        classes.append({"value": v, "label": names.get(v, (f"class {v}", "#888"))[0], "color": names.get(v, ("", "#888888"))[1],
                        "km2": round(n * px_area / 1e6, 4), "pct": round(100.0 * n / valid_px, 2) if valid_px else None})
    classes.sort(key=lambda c: -c["km2"])
    return {"area_km2": round(g.area / 1e6, 4), "pixels": total_px, "nodata_pixels": nod, "pixel_m2": px_area,
            "classes": classes, "method": "pixel-centre-in-polygon count × 100 m² on worldcover2021_epsg32643_10m.tif (nearest-resampled copy)",
            "data_class": "derived", "suitability": "screening"}


def landcover_city_areas(layer: Layer) -> dict | None:
    p = paths.derived(layer.dataset, layer.version, "class_areas.json")
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None
