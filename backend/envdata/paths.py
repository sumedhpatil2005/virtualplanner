"""Where the Environment workspace reads derived datasets from.

Canonical env: URBANOS_DATA_DIR (registry convention). Aliases honoured for the pipelines' older names:
URBANOS_DATA_ROOT, URBANOS_DATA_HOME. URBANOS_DERIVED_DIR overrides the derived/ tree directly.
Default: backend/data/urbanos when it holds a derived/ tree, else /workspace/work/urbanos-data (the sandbox store).
"""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]


def data_dir() -> Path:
    for k in ("URBANOS_DATA_DIR", "URBANOS_DATA_ROOT", "URBANOS_DATA_HOME"):
        v = os.environ.get(k)
        if v:
            return Path(v)
    local = _BACKEND / "data" / "urbanos"
    if (local / "derived").is_dir():
        return local
    return Path("/workspace/work/urbanos-data")


def derived_dir() -> Path:
    v = os.environ.get("URBANOS_DERIVED_DIR")
    return Path(v) if v else data_dir() / "derived"


def derived(dataset: str, version: str, name: str = "") -> Path:
    p = derived_dir() / dataset / version
    return p / name if name else p


def cache_dir() -> Path:
    p = Path(os.environ.get("URBANOS_RENDER_CACHE", "/tmp/urbanos-render-cache"))
    p.mkdir(parents=True, exist_ok=True)
    return p


@lru_cache(maxsize=64)
def _processing(dataset: str, version: str, mtime: float) -> dict | None:
    p = derived(dataset, version, "processing.json")
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def processing(dataset: str, version: str) -> dict | None:
    p = derived(dataset, version, "processing.json")
    try:
        m = p.stat().st_mtime
    except OSError:
        return None
    return _processing(dataset, version, m)


def output_sha(dataset: str, version: str, filename: str) -> str | None:
    pj = processing(dataset, version) or {}
    for o in pj.get("outputs", []):
        if os.path.basename(o.get("path") or o.get("file") or "") == filename:
            return o.get("sha256")
    return None
