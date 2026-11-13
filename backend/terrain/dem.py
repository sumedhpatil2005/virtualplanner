"""Copernicus DEM GLO-30 sampling (point / polyline) from the derived UTM COG.

Data: $URBANOS_DATA_DIR/derived/elevation_copdem30/<version>/dem_copglo30_epsg32643_30m.tif (EPSG:32643, 30 m, float32,
nodata NaN), produced by datasets.pipelines.elevation. Version pinned by env URBANOS_DEM_VERSION (default v2; falls back to
the latest version on disk). Bilinear interpolation of the four surrounding cell centres; a sample whose four cells are
not all valid is reported as nodata (never filled), a sample outside the raster as outside_coverage.

The product is a DSM (TanDEM-X X-band surface: buildings and trees included). Every value served is screening-grade.
"""
from __future__ import annotations

import json
import math
import os
import threading
from pathlib import Path

import numpy as np

from datasets import paths

DATASET_ID = "elevation_copdem30"
DEM_FILE = "dem_copglo30_epsg32643_30m.tif"
DEFAULT_VERSION = "v2"
RAW_SOURCE = "copernicus_dem_glo30"
DSM_WARNING = "DSM: includes buildings/trees — screening only"
VERTICAL_DATUM = "EGM2008 geoid (EPSG:3855), metres — as the product states"
# Publisher specification (Copernicus DEM Product Handbook / ESA; also recorded in the raw manifest's spec_accuracy).
SPEC_ACCURACY_FALLBACK = ("abs vertical <4 m LE90; rel vertical <2 m (slope<=20%) / <4 m (>20%); abs horizontal <6 m CE90")
ATTRIBUTION = ("produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 "
               "provided under COPERNICUS by the European Union and ESA; all rights reserved")
MAX_SAMPLES = 5000

_lock = threading.Lock()
_cache: dict[str, "Dem"] = {}


class DemUnavailable(RuntimeError):
    pass


class Dem:
    def __init__(self, vdir: Path):
        import rasterio
        from pyproj import Transformer

        self.dir = vdir
        self.version = vdir.name
        self.path = vdir / DEM_FILE
        with rasterio.open(self.path) as src:
            self.z = src.read(1).astype("float32")
            self.tr = src.transform
            self.crs = src.crs.to_string()
            self.res = (abs(src.res[0]), abs(src.res[1]))
            self.bounds = tuple(src.bounds)
            nod = src.nodata
        if nod is not None and not (isinstance(nod, float) and math.isnan(nod)):
            self.z[self.z == nod] = np.nan
        self.h, self.w = self.z.shape
        self.fwd = Transformer.from_crs("EPSG:4326", self.crs, always_xy=True)
        self.inv = Transformer.from_crs(self.crs, "EPSG:4326", always_xy=True)
        proc = json.loads((vdir / "processing.json").read_text()) if (vdir / "processing.json").exists() else {}
        self.processing = proc
        self.file_sha256 = next((o.get("sha256") for o in proc.get("outputs", []) if o.get("path") == DEM_FILE), None)
        self.spec_accuracy = _spec_accuracy()

    # ---- sampling ----
    def sample_xy(self, x: float, y: float) -> tuple[float | None, str]:
        """Bilinear at UTM (x, y). Returns (value | None, status) with status ok | nodata | outside_coverage."""
        col = (x - self.tr.c) / self.tr.a - 0.5
        row = (y - self.tr.f) / self.tr.e - 0.5
        if not (-0.5 <= col <= self.w - 0.5 and -0.5 <= row <= self.h - 0.5):
            return None, "outside_coverage"
        c0 = min(max(int(math.floor(col)), 0), self.w - 2)
        r0 = min(max(int(math.floor(row)), 0), self.h - 2)
        fc = min(max(col - c0, 0.0), 1.0)
        fr = min(max(row - r0, 0.0), 1.0)
        q = self.z[r0:r0 + 2, c0:c0 + 2].astype("float64")
        if not np.isfinite(q).all():
            # inside the raster but a neighbouring cell is nodata (study-box rim, voids): do not fill
            return None, "nodata"
        v = (q[0, 0] * (1 - fc) * (1 - fr) + q[0, 1] * fc * (1 - fr) + q[1, 0] * (1 - fc) * fr + q[1, 1] * fc * fr)
        return float(v), "ok"

    def sample_lonlat(self, lon: float, lat: float) -> dict:
        x, y = self.fwd.transform(lon, lat)
        v, st = self.sample_xy(x, y)
        return {"lon": lon, "lat": lat, "elevation_m": None if v is None else round(v, 2), "status": st}

    def profile(self, coords: list[list[float]], step_m: float = 30.0) -> dict:
        if len(coords) < 2:
            raise ValueError("a polyline needs at least 2 vertices")
        xy = [self.fwd.transform(float(c[0]), float(c[1])) for c in coords]
        seg_len = [math.dist(xy[i], xy[i + 1]) for i in range(len(xy) - 1)]
        total = sum(seg_len)
        step = max(float(step_m), 1.0)
        if total / step > MAX_SAMPLES:
            step = total / MAX_SAMPLES
        samples = []
        ch0 = 0.0
        for i, L in enumerate(seg_len):
            n = max(1, int(math.ceil(L / step)))
            last = i == len(seg_len) - 1
            for k in range(n + (1 if last else 0)):
                t = k / n
                x = xy[i][0] + t * (xy[i + 1][0] - xy[i][0])
                y = xy[i][1] + t * (xy[i + 1][1] - xy[i][1])
                v, st = self.sample_xy(x, y)
                lon, lat = self.inv.transform(x, y)
                samples.append({"chainage_m": round(ch0 + t * L, 2), "segment": i, "t": round(t, 6),
                                "lon": round(lon, 7), "lat": round(lat, 7),
                                "elevation_m": None if v is None else round(v, 2), "status": st})
            ch0 += L
        vals = [s["elevation_m"] for s in samples if s["elevation_m"] is not None]
        return {"samples": samples, "step_m": round(step, 2), "length_m_utm": round(total, 2),
                "vertex_chainage_m_utm": [round(sum(seg_len[:i]), 2) for i in range(len(xy))],
                "summary": {"n": len(samples), "n_ok": len(vals), "n_nodata": sum(s["status"] == "nodata" for s in samples),
                            "n_outside": sum(s["status"] == "outside_coverage" for s in samples),
                            "min_m": min(vals) if vals else None, "max_m": max(vals) if vals else None,
                            "coverage_fraction": round(len(vals) / len(samples), 4) if samples else 0.0}}

    def describe(self, registry_version: dict | None = None) -> dict:
        b = self.bounds
        lon0, lat0 = self.inv.transform(b[0], b[1])
        lon1, lat1 = self.inv.transform(b[2], b[3])
        return {
            "dataset_id": DATASET_ID, "version": self.version,
            "dataset_version_id": (registry_version or {}).get("id"),
            "registry_review_status": (registry_version or {}).get("review_status"),
            "file": f"derived/{DATASET_ID}/{self.version}/{DEM_FILE}", "file_sha256": self.file_sha256,
            "crs": self.crs, "resolution_m": self.res[0], "coverage_bbox_wgs84": [round(lon0, 4), round(lat0, 4), round(lon1, 4), round(lat1, 4)],
            "product": "Copernicus DEM GLO-30 Public (2021 release; TanDEM-X acquisitions 2011-2015)",
            "surface": "DSM", "warning": DSM_WARNING, "vertical_datum": VERTICAL_DATUM,
            "vertical_accuracy": f"Publisher specification: {self.spec_accuracy}. Not validated locally against Pune survey control.",
            "classification": "derived (bilinear sample of an observed DSM)", "suitability": "screening",
            "interpolation": "bilinear between the 4 surrounding 30 m cell centres (EPSG:32643); nodata never filled",
            "processing_git_commit": self.processing.get("git_commit"), "attribution": ATTRIBUTION,
        }


def _spec_accuracy() -> str:
    base = paths.raw_dir() / RAW_SOURCE
    try:
        for d in sorted(base.iterdir(), reverse=True):
            m = d / "manifest.json"
            if m.exists():
                s = json.loads(m.read_text()).get("spec_accuracy")
                if s:
                    return s
    except OSError:
        pass
    return SPEC_ACCURACY_FALLBACK


def dem_version_dir() -> Path:
    want = os.environ.get("URBANOS_DEM_VERSION", DEFAULT_VERSION)
    d = paths.derived_version_dir(DATASET_ID, want)
    if d is None or not (d / DEM_FILE).exists():
        d = next((p for p in reversed(paths.derived_versions(DATASET_ID)) if (p / DEM_FILE).exists()), None)
    if d is None:
        raise DemUnavailable(f"No {DATASET_ID} DEM under {paths.derived_dir()} - run python -m datasets.pipelines.elevation")
    return d


def get_dem() -> Dem:
    d = dem_version_dir()
    key = str(d / DEM_FILE)
    with _lock:
        if key not in _cache:
            _cache.clear()
            _cache[key] = Dem(d)
        return _cache[key]


def registry_version(db, dataset_id: str, version_label: str) -> dict | None:
    """The registry row for a derived version dir (latest registration of that label)."""
    try:
        from sqlalchemy import select

        from datasets.models import DsDatasetVersionEntity as V
        rows = list(db.scalars(select(V).where(V.dataset_id == dataset_id, V.version_label == version_label)))
    except Exception:  # pragma: no cover - registry tables absent
        return None
    if not rows:
        return None
    rows.sort(key=lambda r: str(r.created_at or ""))
    r = rows[-1]
    return {"id": r.id, "review_status": r.review_status}
