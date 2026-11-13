"""Shared helpers for UrbanOS dataset pipelines.

Conventions (docs/urbanos/catalogue/global.md, urbanos-p2 brief):
- raw originals: $URBANOS_RAW_DIR/<source_id>/<YYYY-MM-DD>/<original filename> + manifest.json (never modified)
- derived:       $URBANOS_DERIVED_DIR/<dataset_id>/<version>/... + processing.json
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any, Iterable

# Pune study area (WGS84) and engineering CRS — fixed by the brief.
PUNE_BBOX = (73.70, 18.40, 74.05, 18.70)  # (min_lon, min_lat, max_lon, max_lat)
ENGINEERING_EPSG = 32643
IST = _dt.timezone(_dt.timedelta(hours=5, minutes=30), "IST")

DATA_ROOT = Path(os.environ.get("URBANOS_DATA_ROOT", "/workspace/work/urbanos-data"))
RAW_DIR = Path(os.environ.get("URBANOS_RAW_DIR", DATA_ROOT / "raw"))
DERIVED_DIR = Path(os.environ.get("URBANOS_DERIVED_DIR", DATA_ROOT / "derived"))
USER_AGENT = "UrbanOS-dataset-pipeline/0.1 (research; contact: repository owner)"


def now_ist() -> str:
    return _dt.datetime.now(IST).isoformat(timespec="seconds")


def today_ist() -> str:
    return _dt.datetime.now(IST).date().isoformat()


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=Path(__file__).parent, text=True
        ).strip()
    except Exception:  # pragma: no cover
        return "UNKNOWN"


def git_dirty() -> bool | None:
    """True if backend/datasets has uncommitted changes (processing.json then cannot pin exact code)."""
    try:
        out = subprocess.check_output(["git", "status", "--porcelain", "--", "."], cwd=Path(__file__).parents[1], text=True)
        return bool(out.strip())
    except Exception:  # pragma: no cover
        return None


def bbox_intersects(a: Iterable[float], b: Iterable[float]) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1


def bbox_coverage_fraction(data_bbox: Iterable[float], study_bbox: Iterable[float] = PUNE_BBOX) -> float:
    """Fraction of study_bbox area (in degrees², fine for small boxes) covered by data_bbox."""
    dx0, dy0, dx1, dy1 = data_bbox
    sx0, sy0, sx1, sy1 = study_bbox
    w = max(0.0, min(dx1, sx1) - max(dx0, sx0))
    h = max(0.0, min(dy1, sy1) - max(dy0, sy0))
    area = (sx1 - sx0) * (sy1 - sy0)
    return 0.0 if area <= 0 else (w * h) / area


def one_degree_tiles(bbox: Iterable[float]) -> list[tuple[int, int]]:
    """(lat_floor, lon_floor) of every 1°x1° tile the bbox touches (exclusive of exact upper edges)."""
    import math

    x0, y0, x1, y1 = bbox
    lats = range(math.floor(y0), math.ceil(y1))
    lons = range(math.floor(x0), math.ceil(x1))
    return [(la, lo) for la in lats for lo in lons]


def raw_dir(source_id: str, date: str | None = None) -> Path:
    d = RAW_DIR / source_id / (date or today_ist())
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load_manifest(d: Path) -> dict:
    m = d / "manifest.json"
    return json.loads(m.read_text()) if m.exists() else {"files": []}


def write_manifest(d: Path, source: dict, files: list[dict]) -> Path:
    """Merge file entries (keyed by filename) into d/manifest.json."""
    man = _load_manifest(d)
    man.update(source)
    by_name = {f["filename"]: f for f in man.get("files", [])}
    for f in files:
        by_name[f["filename"]] = f
    man["files"] = sorted(by_name.values(), key=lambda f: f["filename"])
    man["manifest_updated_at"] = now_ist()
    p = d / "manifest.json"
    p.write_text(json.dumps(man, indent=2))
    return p


def download(url: str, dest_dir: Path, filename: str | None = None, *, retries: int = 3,
             timeout: int = 120, note: str = "") -> dict:
    """Stream url to dest_dir/filename (skip if present with same size). Returns a manifest file entry."""
    import requests

    filename = filename or url.split("?")[0].rstrip("/").split("/")[-1]
    dest = dest_dir / filename
    headers_keep = ("content-length", "last-modified", "etag", "content-type", "x-amz-version-id")
    last_err = None
    for attempt in range(retries):
        try:
            with requests.get(url, stream=True, timeout=timeout, headers={"User-Agent": USER_AGENT}) as r:
                if r.status_code == 429:
                    time.sleep(10 * (attempt + 1))
                    last_err = "HTTP 429"
                    continue
                r.raise_for_status()
                hdrs = {k: v for k, v in r.headers.items() if k.lower() in headers_keep}
                clen = int(r.headers.get("content-length", -1))
                if not (dest.exists() and clen > 0 and dest.stat().st_size == clen):
                    tmp = dest.with_suffix(dest.suffix + ".part")
                    with open(tmp, "wb") as f:
                        for block in r.iter_content(1 << 20):
                            f.write(block)
                    tmp.rename(dest)
            entry = {"filename": filename, "url": url, "retrieved_at": now_ist(), "http_headers": hdrs,
                     "size_bytes": dest.stat().st_size, "sha256": sha256_file(dest)}
            if note:
                entry["notes"] = note
            return entry
        except Exception as e:  # pragma: no cover - network
            last_err = repr(e)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"download failed {url}: {last_err}")


def head(url: str) -> dict:
    import requests

    r = requests.head(url, timeout=30, allow_redirects=True, headers={"User-Agent": USER_AGENT})
    return {"status": r.status_code, **{k.lower(): v for k, v in r.headers.items()
                                         if k.lower() in ("content-length", "last-modified", "etag")}}


def file_entry(path: Path, **extra: Any) -> dict:
    return {"filename": path.name, "size_bytes": path.stat().st_size, "sha256": sha256_file(path), **extra}


def write_processing(out_dir: Path, *, pipeline: str, inputs: list[Path], parameters: dict,
                     outputs: list[Path], validation: dict, classification: str = "derived",
                     suitability: str = "screening", notes: str = "") -> Path:
    doc = {
        "pipeline": pipeline,
        "git_commit": git_commit(),
        "git_dirty_datasets": git_dirty(),
        "run_at": now_ist(),
        "classification": classification,
        "suitability": suitability,
        "inputs": [{"path": str(p), "sha256": sha256_file(p), "size_bytes": p.stat().st_size} for p in inputs],
        "parameters": parameters,
        "outputs": [{"path": str(p.relative_to(out_dir)) if p.is_relative_to(out_dir) else str(p),
                     "sha256": sha256_file(p), "size_bytes": p.stat().st_size} for p in outputs],
        "validation": validation,
        "notes": notes,
    }
    p = out_dir / "processing.json"
    p.write_text(json.dumps(doc, indent=2, default=str))
    return p
