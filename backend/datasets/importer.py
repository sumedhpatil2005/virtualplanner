"""
Registers acquisitions that follow the storage convention (docs/urbanos/DATA_INGESTION_ARCHITECTURE.md §3):

    <root>/raw/<source_id>/<YYYY-MM-DD>/<files> + manifest.json
    <root>/derived/<dataset_id>/<version>/<files> + processing.json (+ optional manifest.json)

Robust and idempotent:
- one directory = one registration; its fingerprint is the sha256 of its manifest/processing content. Re-running with
  unchanged files registers nothing. A changed manifest in the same directory registers a NEW version (pending review);
  the earlier version is never edited.
- unreadable / half-written JSON is reported and skipped (other agents write these files concurrently; run again later).
- unknown keys are kept in the version's stats under `manifest_extra`; synonyms written by different agents are accepted.
- data class / suitability / licence are recorded only as the manifest states them (missing = not classified / UNKNOWN).

CLI: `python -m datasets.importer [--root DIR] [--dry-run]` (default root: URBANOS_DATA_DIR).
"""
from __future__ import annotations

import argparse
import json
import os
from typing import Any

from sqlalchemy.orm import Session

from .models import DsDatasetVersionEntity, DsFileEntity, DsProcessingRunEntity
from .quality import run_checks
from .registry import add_version, ensure_dataset, ensure_source, find_version_by_fingerprint, fingerprint, new_id
from .vocab import ACCESS_METHODS, data_root, norm_theme

MANIFEST = "manifest.json"
PROCESSING = "processing.json"


def _first(d: dict, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, "", [], {}):
            return d[k]
    return default


def _licence(m: dict) -> tuple[str, str]:
    lic = _first(m, "licence", "license", "licence_text", "license_text")
    url = _first(m, "licence_url", "license_url", default="")
    if isinstance(lic, dict):
        url = url or _first(lic, "url", "href", default="")
        lic = _first(lic, "text", "name", "as_stated", "title", "id")
    return (str(lic) if lic else "UNKNOWN"), str(url or "")


def _bbox(m: dict):
    b = _first(m, "coverage_bbox", "bbox", "clip_bbox", "study_bbox")
    cov = m.get("coverage") if isinstance(m.get("coverage"), dict) else None
    if b is None and cov:
        b = _first(cov, "bbox", "coverage_bbox")
    if isinstance(b, dict):
        b = [b.get(k) for k in ("min_lon", "min_lat", "max_lon", "max_lat")] if "min_lon" in b else [b.get(k) for k in ("west", "south", "east", "north")]
    if isinstance(b, (list, tuple)) and len(b) == 4:
        try:
            return [float(x) for x in b]
        except (TypeError, ValueError):
            return None
    return None


def _polygon(m: dict):
    p = _first(m, "coverage_geojson", "coverage_polygon", "footprint")
    cov = m.get("coverage") if isinstance(m.get("coverage"), dict) else None
    if p is None and cov:
        p = _first(cov, "geojson", "polygon", "geometry")
    return p if isinstance(p, dict) and p.get("type") else None


def _files(m: dict, d: str) -> list[dict]:
    out = []
    lst = _first(m, "files", "outputs", "artifacts", default=[])
    if isinstance(lst, dict):
        lst = [{"path": k, **(v if isinstance(v, dict) else {"sha256": v})} for k, v in lst.items()]
    for f in lst if isinstance(lst, list) else []:
        if isinstance(f, str):
            f = {"path": f}
        if not isinstance(f, dict):
            continue
        name = _first(f, "path", "name", "filename", "file")
        if not name:
            continue
        p = name if os.path.isabs(name) else os.path.join(d, name)
        out.append({"path": p, "sha256": _first(f, "sha256", "sha256sum", "checksum"),
                    "size_bytes": _int(_first(f, "size", "size_bytes", "bytes")),
                    "format": _first(f, "format", "type", default=os.path.splitext(name)[1].lstrip(".") or None),
                    "url": _first(f, "url", "source_url")})
    if not out:
        name = _first(m, "filename", "file", "original_filename", "file_name")
        if name:
            p = name if os.path.isabs(name) else os.path.join(d, name)
            out.append({"path": p, "sha256": _first(m, "sha256", "sha256sum"), "size_bytes": _int(_first(m, "size", "size_bytes")),
                        "format": _first(m, "format", default=os.path.splitext(name)[1].lstrip(".") or None),
                        "url": _first(m, "url", "source_url", "download_url")})
    return out


def _int(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _read_json(path: str) -> tuple[dict | None, str | None, str | None]:
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        return None, None, f"unreadable: {e}"
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        return None, None, f"invalid or incomplete JSON ({e}); skipped, run the importer again later"
    if not isinstance(doc, dict):
        return None, None, "top level is not an object; skipped"
    import hashlib
    return doc, hashlib.sha256(raw).hexdigest(), None


KNOWN = {"dataset_id", "dataset", "source_id", "source", "title", "name", "description", "publisher", "provider", "url",
         "source_url", "download_url", "retrieved_at", "downloaded_at", "accessed_at", "http_headers", "headers", "etag",
         "last_modified", "sha256", "size", "size_bytes", "licence", "license", "licence_url", "license_url", "notes",
         "files", "outputs", "inputs", "crs", "resolution", "scale", "format", "data_class", "class", "suitability",
         "theme", "category", "domain", "coverage", "coverage_bbox", "bbox", "coverage_geojson", "version",
         "observation_start", "observation_end", "observed_from", "observed_to", "published", "published_date",
         "source_updated", "source_updated_date", "updated", "pipeline", "script", "git_commit", "commit", "parameters",
         "params", "validation", "validation_results", "started_at", "finished_at", "created_at", "access_method",
         "accuracy", "accuracy_statement", "official", "robots", "robots_txt", "tos", "terms", "registration_required",
         "filename", "file", "max_age_days", "limitations"}


def register_dir(db: Session, d: str, kind: str, root: str) -> dict:
    """kind: raw | derived. Returns a report entry."""
    rel = os.path.relpath(d, root)
    parts = rel.split(os.sep)
    man_p, proc_p = os.path.join(d, MANIFEST), os.path.join(d, PROCESSING)
    man, man_sha, err1 = _read_json(man_p) if os.path.exists(man_p) else (None, None, None)
    proc, proc_sha, err2 = _read_json(proc_p) if os.path.exists(proc_p) else (None, None, None)
    if err1 or err2:
        return {"dir": rel, "result": "skipped", "reason": err1 or err2}
    if man is None and proc is None:
        return {"dir": rel, "result": "skipped", "reason": "no manifest.json / processing.json"}
    fp = fingerprint("dir-registration", rel, man_sha, proc_sha)
    existing = find_version_by_fingerprint(db, fp)
    if existing is not None:
        return {"dir": rel, "result": "unchanged", "version_id": existing.id, "dataset_id": existing.dataset_id}

    m: dict[str, Any] = {**(proc or {}), **(man or {})}   # manifest wins for metadata; processing adds lineage
    source_id = _first(m, "source_id") or (parts[1] if kind == "raw" and len(parts) > 1 else None)
    src_meta = m.get("source") if isinstance(m.get("source"), dict) else {}
    if isinstance(src_meta, dict) and src_meta.get("id"):
        source_id = source_id or src_meta["id"]
    dataset_id = _first(m, "dataset_id") or (m["dataset"] if isinstance(m.get("dataset"), str) else None) \
        or (parts[1] if len(parts) > 1 else rel.replace(os.sep, "_"))
    version_label = str(_first(m, "version") or (parts[2] if len(parts) > 2 else "v?"))
    lic, lic_url = _licence(m)
    warnings: list[str] = []

    if source_id:
        access = _first(m, "access_method", default=_first(src_meta, "access_method"))
        if access not in ACCESS_METHODS:
            if access:
                warnings.append(f"access method '{access}' not in vocabulary")
            access = "download" if _first(m, "url", "source_url", "download_url") else "manual"
        ensure_source(db, source_id, name=str(_first(src_meta, "name") or _first(m, "publisher", "provider") or source_id),
                      publisher=str(_first(src_meta, "publisher") or _first(m, "publisher", "provider") or "UNKNOWN"),
                      url=str(_first(src_meta, "url", "homepage") or _first(m, "source_url", "url", default="")),
                      access_method=access, licence_text=lic, licence_url=lic_url,
                      robots_notes=str(_first(m, "robots", "robots_txt", default=_first(src_meta, "robots", default="")) or ""),
                      tos_notes=str(_first(m, "tos", "terms", default=_first(src_meta, "tos", default="")) or ""),
                      official=bool(_first(m, "official", default=_first(src_meta, "official", default=False))),
                      registration_required=bool(_first(m, "registration_required", default=False)),
                      origin="manifest", notes=f"registered from {rel}")

    theme = norm_theme(_first(m, "theme", "category", "domain"))
    ensure_dataset(db, dataset_id, title=str(_first(m, "title", "name") or dataset_id), theme=theme,
                   description=str(_first(m, "description", default="")), source_id=source_id,
                   limitations=str(_first(m, "limitations", default="")), max_age_days=_int(_first(m, "max_age_days")),
                   update_check={"method": "http_head", "url": _first(m, "url", "download_url", "source_url")}
                   if _first(m, "url", "download_url", "source_url") else {},
                   origin="manifest")

    headers = _first(m, "http_headers", "headers", default={}) or {}
    if not isinstance(headers, dict):
        headers = {}
    hl = {str(k).lower(): v for k, v in headers.items()}
    http = {"etag": _first(m, "etag") or hl.get("etag"), "last_modified": _first(m, "last_modified") or hl.get("last-modified"),
            "content_length": hl.get("content-length"), "url": _first(m, "url", "download_url", "source_url")}
    files = _files(man or {}, d) if man else []
    out_files = _files({"files": (proc or {}).get("outputs")} if proc else {}, d) if proc else []
    roles = [dict(f, role="raw" if kind == "raw" else "derived") for f in files]
    have = {f["path"] for f in roles}
    roles += [dict(f, role="derived") for f in out_files if f["path"] not in have]
    if man:
        roles.append({"path": man_p, "sha256": man_sha, "role": "manifest", "format": "json", "size_bytes": os.path.getsize(man_p)})
    if proc:
        roles.append({"path": proc_p, "sha256": proc_sha, "role": "manifest", "format": "json", "size_bytes": os.path.getsize(proc_p)})
    data_files = [f for f in roles if f["role"] != "manifest"]
    if not data_files:
        warnings.append("manifest lists no data files")
    for f in data_files:
        if not os.path.exists(f["path"]):
            warnings.append(f"listed file missing: {os.path.relpath(f['path'], root)}")
        elif f.get("size_bytes") is None:
            f["size_bytes"] = os.path.getsize(f["path"])
        if not f.get("sha256"):
            warnings.append(f"no sha256 recorded for {os.path.basename(f['path'])}")
    primary_sha = data_files[0]["sha256"] if len(data_files) == 1 else (man_sha or proc_sha)
    total = sum(f.get("size_bytes") or 0 for f in data_files) or None

    # licence inheritance for derived data (lineage by input sha256)
    inputs = _first(proc or {}, "inputs", default=[]) or []
    if isinstance(inputs, dict):
        inputs = [{"path": k, **(v if isinstance(v, dict) else {"sha256": v})} for k, v in inputs.items()]
    inputs = [i if isinstance(i, dict) else {"path": str(i)} for i in inputs]
    for i in inputs:
        sha = i.get("sha256")
        if sha:
            hit = db.query(DsFileEntity).filter(DsFileEntity.sha256 == sha).first()
            if hit:
                i["version_id"] = hit.version_id
                if lic == "UNKNOWN":
                    pv = db.get(DsDatasetVersionEntity, hit.version_id)
                    if pv and pv.licence_text and pv.licence_text != "UNKNOWN":
                        lic, lic_url = pv.licence_text, pv.licence_url
                        warnings.append(f"licence inherited from input version {pv.id} — verify share-alike / attribution terms")

    extra = {k: v for k, v in m.items() if k not in KNOWN}
    stats = {"manifest_extra": extra} if extra else {}
    if proc and _first(proc, "validation", "validation_results"):
        stats["validation"] = _first(proc, "validation", "validation_results")
    acc = _first(m, "accuracy_statement", "accuracy", default="")
    v = add_version(
        db, dataset_id, files=[{k: f.get(k) for k in ("path", "sha256", "size_bytes", "format", "url", "role")} for f in roles],
        warnings=warnings, version_label=version_label,
        observation_start=_s(_first(m, "observation_start", "observed_from")),
        observation_end=_s(_first(m, "observation_end", "observed_to")),
        published_date=_s(_first(m, "published_date", "published")),
        source_updated_date=_s(_first(m, "source_updated_date", "source_updated", "updated") or http["last_modified"]),
        retrieved_at=_s(_first(m, "retrieved_at", "downloaded_at", "accessed_at", "created_at", "finished_at")),
        sha256=primary_sha, coverage_bbox_json=_bbox(m), coverage_geojson=json.dumps(_polygon(m)) if _polygon(m) else None,
        crs=_s(_first(m, "crs")), resolution=_s(_first(m, "resolution", "scale")), format=_s(_first(m, "format")),
        size_bytes=total, data_class=_first(m, "data_class", "class"), suitability=_first(m, "suitability"),
        accuracy_statement=str(acc if isinstance(acc, str) else json.dumps(acc)), licence_text=lic, licence_url=lic_url,
        http_json={k: v for k, v in http.items() if v}, stats_json=stats, notes=str(_first(m, "notes", default="")),
        origin="processing" if proc and not man else "manifest", origin_path=d, fingerprint=fp)
    if proc:
        db.add(DsProcessingRunEntity(
            id=new_id("dsp"), version_id=v.id, pipeline=str(_first(proc, "pipeline", "script", default="UNKNOWN")),
            git_commit=_s(_first(proc, "git_commit", "commit")),
            params_json=json.dumps(_first(proc, "parameters", "params", default={})),
            inputs_json=json.dumps(inputs), outputs_json=json.dumps(_first(proc, "outputs", default=[])),
            validation_json=json.dumps(_first(proc, "validation", "validation_results", default={})),
            started_at=_s(_first(proc, "started_at")), finished_at=_s(_first(proc, "finished_at", "created_at")), origin_path=d))
    db.flush()
    run_checks(db, v)
    return {"dir": rel, "result": "registered", "dataset_id": dataset_id, "version_id": v.id,
            "review_status": v.review_status, "warnings": warnings}


def _s(v):
    if v is None:
        return None
    return v if isinstance(v, str) else json.dumps(v)


def scan(db: Session, root: str | None = None) -> dict:
    root = os.path.abspath(root or data_root())
    report: list[dict] = []
    if not os.path.isdir(root):
        return {"root": root, "exists": False, "entries": [], "summary": {}}
    for kind in ("raw", "derived"):
        base = os.path.join(root, kind)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames.sort()
            if MANIFEST in filenames or PROCESSING in filenames:
                try:
                    with db.begin_nested():
                        report.append(register_dir(db, dirpath, kind, root))
                except Exception as e:  # noqa: BLE001 — one bad directory never stops the scan
                    report.append({"dir": os.path.relpath(dirpath, root), "result": "error", "reason": str(e)[:400]})
    summary: dict[str, int] = {}
    for r in report:
        summary[r["result"]] = summary.get(r["result"], 0) + 1
    return {"root": root, "exists": True, "entries": report, "summary": summary}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description="Register <root>/{raw,derived}/**/manifest.json|processing.json in the dataset registry")
    ap.add_argument("--root", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    import main as app_main  # noqa: F401  (creates tables, seeds)
    from database.connection import SessionLocal
    with SessionLocal() as db:
        rep = scan(db, a.root)
        if a.dry_run:
            db.rollback()
        else:
            db.commit()
    print(json.dumps(rep, indent=1, default=str))


if __name__ == "__main__":
    main()
