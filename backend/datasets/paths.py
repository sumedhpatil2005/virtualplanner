"""Single source of truth for where UrbanOS dataset files live (raw originals + derived outputs).

Resolution order for the data root (first match wins; read at CALL time so tests can monkeypatch env):
  1. ``URBANOS_DATA_DIR``   - canonical name (registry, importer, APIs, pipelines)
  2. ``URBANOS_DATA_ROOT``  - deprecated alias (geo pipelines, Wave 1)
  3. ``URBANOS_DATA_HOME``  - deprecated alias (gov pipelines, Wave 1)
  4. ``/workspace/work/urbanos-data`` if that directory exists (the shared sandbox data store; raw files are
     never committed, so this is where the real downloads are)
  5. ``backend/data/urbanos`` (repo-relative fallback; empty in a fresh clone)

Sub-roots: ``URBANOS_RAW_DIR`` / ``URBANOS_DERIVED_DIR`` override ``<root>/raw`` and ``<root>/derived``.
Documented in docs/urbanos/DATA_INGESTION_ARCHITECTURE.md and TERRAIN_AND_SUBSURFACE_DATA.md.
No third-party imports here: the API, registry and pipelines all import this module.
"""
from __future__ import annotations

import os
from pathlib import Path

CANONICAL_ENV = "URBANOS_DATA_DIR"
ALIAS_ENVS = ("URBANOS_DATA_ROOT", "URBANOS_DATA_HOME")
SANDBOX_DEFAULT = Path("/workspace/work/urbanos-data")
REPO_DEFAULT = Path(__file__).resolve().parents[1] / "data" / "urbanos"


def data_dir_info() -> dict:
    """{'path': Path, 'source': env name | 'sandbox_default' | 'repo_default'}"""
    for name in (CANONICAL_ENV, *ALIAS_ENVS):
        v = os.environ.get(name)
        if v:
            return {"path": Path(v), "source": name}
    if SANDBOX_DEFAULT.is_dir():
        return {"path": SANDBOX_DEFAULT, "source": "sandbox_default"}
    return {"path": REPO_DEFAULT, "source": "repo_default"}


def data_dir() -> Path:
    return data_dir_info()["path"]


def raw_dir() -> Path:
    v = os.environ.get("URBANOS_RAW_DIR")
    return Path(v) if v else data_dir() / "raw"


def derived_dir() -> Path:
    v = os.environ.get("URBANOS_DERIVED_DIR")
    return Path(v) if v else data_dir() / "derived"


def derived_versions(dataset_id: str) -> list[Path]:
    """Version directories of a derived dataset that carry a processing.json, sorted by name."""
    base = derived_dir() / dataset_id
    if not base.is_dir():
        return []
    return sorted(p for p in base.iterdir() if p.is_dir() and (p / "processing.json").exists())


def derived_version_dir(dataset_id: str, version: str | None = None) -> Path | None:
    """A specific version dir, or the latest by name when version is None. None if absent."""
    vs = derived_versions(dataset_id)
    if version is not None:
        for p in vs:
            if p.name == version:
                return p
        return None
    return vs[-1] if vs else None
