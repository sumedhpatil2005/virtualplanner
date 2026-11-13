"""Small raster helpers shared by pipelines (pure numpy where possible, unit-tested)."""
from __future__ import annotations

from pathlib import Path

import numpy as np


def slope_degrees(dem: np.ndarray, xres: float, yres: float) -> np.ndarray:
    """Horn-free simple central-difference slope in degrees (edges via np.gradient)."""
    dzdy, dzdx = np.gradient(dem.astype("float64"), abs(yres), abs(xres))
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype("float32")


def hillshade(dem: np.ndarray, xres: float, yres: float, azimuth: float = 315.0, altitude: float = 45.0) -> np.ndarray:
    """Standard illumination model; returns uint8 0..255. Row 0 is north (GeoTIFF north-up)."""
    dzdy, dzdx = np.gradient(dem.astype("float64"), abs(yres), abs(xres))
    dzdy = -dzdy  # rows increase southward; convert to northward gradient
    slope = np.arctan(np.hypot(dzdx, dzdy))
    aspect = np.arctan2(-dzdx, dzdy)
    az = np.radians(360.0 - azimuth + 90.0)
    alt = np.radians(altitude)
    hs = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(hs * 255.0, 0, 255).astype("uint8")


def diff_stats(a: np.ndarray, b: np.ndarray) -> dict:
    m = np.isfinite(a) & np.isfinite(b)
    d = (a[m] - b[m]).astype("float64")
    if d.size == 0:
        return {"n": 0}
    return {"n": int(d.size), "mean": float(d.mean()), "std": float(d.std()), "rmse": float(np.sqrt((d ** 2).mean())),
            "p5": float(np.percentile(d, 5)), "p95": float(np.percentile(d, 95)), "le90_abs": float(np.percentile(np.abs(d), 90))}


def write_cog(path: Path, arr: np.ndarray, profile: dict, colormap: dict | None = None) -> Path:
    """Write a GeoTIFF then translate to COG using GDAL's COG driver (rasterio bundled GDAL)."""
    import rasterio
    from rasterio.shutil import copy as rio_copy

    tmp = Path(str(path) + ".tmp.tif")
    prof = profile.copy()
    prof.update(driver="GTiff", dtype=str(arr.dtype), count=1, tiled=True, blockxsize=256, blockysize=256,
                compress="deflate")
    with rasterio.open(tmp, "w", **prof) as dst:
        dst.write(arr, 1)
        if colormap:
            dst.write_colormap(1, colormap)
    rio_copy(tmp, path, driver="COG", compress="DEFLATE", overview_resampling="average"
             if arr.dtype.kind == "f" else "nearest")
    tmp.unlink()
    return path


def raster_check(path: Path, bbox4326=None) -> dict:
    """CRS / resolution / nodata / validity / bbox coverage summary for processing.json."""
    import rasterio
    from rasterio.warp import transform_bounds

    from ._common import PUNE_BBOX, bbox_coverage_fraction

    with rasterio.open(path) as src:
        a = src.read(1, masked=True)
        b = transform_bounds(src.crs, "EPSG:4326", *src.bounds) if src.crs.to_epsg() != 4326 else tuple(src.bounds)
        return {"file": Path(path).name, "crs": str(src.crs), "res": [abs(src.res[0]), abs(src.res[1])],
                "shape": [src.height, src.width], "dtype": src.dtypes[0], "nodata": src.nodata,
                "valid_fraction": float(1 - np.ma.getmaskarray(a).mean()),
                "min": float(a.min()) if a.count() else None, "max": float(a.max()) if a.count() else None,
                "bbox_coverage": round(bbox_coverage_fraction(b, bbox4326 or PUNE_BBOX), 4),
                "is_cog": src.profile.get("tiled", False) and bool(src.overviews(1))}


def priority_flood_epsilon(dem: np.ndarray, valid: np.ndarray | None = None, eps: float = 1e-3) -> np.ndarray:
    """Barnes et al. (2014) Priority-Flood + epsilon: fills depressions AND imposes a tiny gradient on flats so
    every valid cell drains to the domain boundary (grid edge or invalid/nodata neighbour). Returns float64."""
    import heapq

    z = dem.astype("float64").copy()
    if valid is None:
        valid = np.isfinite(z)
    h, w = z.shape
    seen = ~valid.copy()
    heap = []
    pad = np.pad(valid, 1, constant_values=False)
    interior = pad[1:-1, 1:-1] & pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:] \
        & pad[:-2, :-2] & pad[:-2, 2:] & pad[2:, :-2] & pad[2:, 2:]
    for y, x in zip(*np.where(valid & ~interior)):
        heapq.heappush(heap, (z[y, x], int(y), int(x)))
        seen[y, x] = True
    nb = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
    while heap:
        c, y, x = heapq.heappop(heap)
        for dy, dx in nb:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx]:
                seen[ny, nx] = True
                if z[ny, nx] <= c:
                    z[ny, nx] = c + eps
                heapq.heappush(heap, (z[ny, nx], ny, nx))
    return z
