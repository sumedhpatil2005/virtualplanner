"""Shared helpers for the Indian-government / Pune source pipelines.

Storage convention (docs/urbanos/PUNE_DATA_AVAILABILITY.md §0):
  raw     : $URBANOS_DATA_DIR/raw/<source_id>/<YYYY-MM-DD>/<original filename> + manifest.json
  derived : $URBANOS_DATA_DIR/derived/<dataset_id>/<version>/... + processing.json
URBANOS_DATA_DIR (aliases URBANOS_DATA_ROOT, URBANOS_DATA_HOME) - resolved by datasets/paths.py;
URBANOS_RAW_DIR / URBANOS_DERIVED_DIR override the two sub-roots (outside the repo; raw files
are never committed and never modified after download).

Only the standard library + shapely/pyproj are used so the pipelines run in the
sandbox without GDAL.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any, Iterable

IST = _dt.timezone(_dt.timedelta(hours=5, minutes=30), "IST")
USER_AGENT = "UrbanOS-data-research/0.1 (Pune planning research; contact adityagawali16@gmail.com)"
MIN_REQUEST_INTERVAL_S = 1.2  # brief: >= 1 s between requests

# Pune study area (brief): lon 73.70-74.05, lat 18.40-18.70, WGS84
PUNE_BBOX = (73.70, 18.40, 74.05, 18.70)

_last_request = [0.0]


def data_home() -> Path:
    """Delegates to datasets/paths.py: URBANOS_DATA_DIR canonical; URBANOS_DATA_ROOT / URBANOS_DATA_HOME aliases."""
    from .. import paths
    return paths.data_dir()


def raw_root() -> Path:
    from .. import paths
    return paths.raw_dir()


def derived_root() -> Path:
    from .. import paths
    return paths.derived_dir()


def now_ist() -> str:
    return _dt.datetime.now(IST).isoformat(timespec="seconds")


def today_ist() -> str:
    return _dt.datetime.now(IST).date().isoformat()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=Path(__file__).parent, text=True
        ).strip()
    except Exception:  # pragma: no cover
        return "UNKNOWN"


def raw_dir(source_id: str, date: str | None = None) -> Path:
    d = raw_root() / source_id / (date or today_ist())
    d.mkdir(parents=True, exist_ok=True)
    return d


def derived_dir(dataset_id: str, version: str) -> Path:
    d = derived_root() / dataset_id / version
    d.mkdir(parents=True, exist_ok=True)
    return d


def polite_sleep() -> None:
    wait = globals()['MIN_REQUEST_INTERVAL_S'] - (time.time() - _last_request[0])
    if wait > 0:
        time.sleep(wait)
    _last_request[0] = time.time()


def http_download(url: str, dest: Path, data: bytes | None = None, timeout: int = 180, retries: int = 3) -> dict:
    """Stream url to dest (rate limited, retried on truncated transfers). Returns headers + status."""
    last_exc: Exception | None = None
    for attempt in range(retries):
        polite_sleep()
        req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
        tmp = dest.with_suffix(dest.suffix + ".part")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                with open(tmp, "wb") as out:
                    while True:
                        chunk = resp.read(1 << 20)
                        if not chunk:
                            break
                        out.write(chunk)
                tmp.replace(dest)
                return {"status": resp.status, "headers": {k.lower(): v for k, v in resp.headers.items()},
                        "attempts": attempt + 1}
        except Exception as e:  # IncompleteRead, timeouts, resets
            last_exc = e
            tmp.unlink(missing_ok=True)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"download failed after {retries} attempts: {url}") from last_exc


def manifest_entry(path: Path, url: str, *, retrieved_at: str | None = None, http: dict | None = None,
                   method: str = "GET", licence: str = "UNKNOWN", licence_url: str | None = None,
                   notes: str = "", extra: dict | None = None) -> dict:
    e = {
        "file": path.name,
        "url": url,
        "method": method,
        "retrieved_at": retrieved_at or now_ist(),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
        "http": http or {},
        "licence_as_stated": licence,
        "licence_url": licence_url,
        "notes": notes,
    }
    if extra:
        e.update(extra)
    return e


def write_manifest(directory: Path, source: dict, entries: Iterable[dict]) -> Path:
    """Merge entries (by file name) into directory/manifest.json."""
    mpath = directory / "manifest.json"
    existing: dict[str, Any] = {}
    if mpath.exists():
        existing = json.loads(mpath.read_text())
    files = {f["file"]: f for f in existing.get("files", [])}
    for e in entries:
        files[e["file"]] = e
    doc = {"source": source, "files": sorted(files.values(), key=lambda f: f["file"])}
    mpath.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
    return mpath


def write_processing(directory: Path, *, pipeline: str, inputs: list[dict], parameters: dict,
                     outputs: list[Path], validation: dict, notes: str = "") -> Path:
    doc = {
        "pipeline": pipeline,
        "git_commit": git_commit(),
        "run_at": now_ist(),
        "inputs": inputs,
        "parameters": parameters,
        "outputs": [{"file": p.name, "sha256": sha256_file(p), "size_bytes": p.stat().st_size} for p in outputs],
        "validation": validation,
        "notes": notes,
    }
    p = directory / "processing.json"
    p.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
    return p
