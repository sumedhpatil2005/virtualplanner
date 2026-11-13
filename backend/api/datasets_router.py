"""
Dataset registry API (`/api/datasets`; docs/urbanos/DATA_QUALITY_AND_PROVENANCE.md §6).

Read: catalogue, one dataset with versions / files / processing / quality / update checks, features with
ready | partial | blocked and why. Write (all audited): register a version, review (activate / reject) a pending
version, run quality checks, run an update check, import the URBANOS_DATA_DIR tree, re-sync the mirrored catalogues.
A version is never edited or deleted.
"""
from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from database.connection import get_db
from datasets import importer, quality, registry, updates
from datasets.models import DsDatasetEntity, DsDatasetVersionEntity, DsFeatureEntity, DsSourceEntity, ImmutableVersionError
from datasets.seed import sync_catalogues
from datasets.vocab import (ACCESS_METHODS, CHECK_STATUSES, DATA_CLASSES, ENGINEERING_CRS, FEATURE_STATUSES, PUNE_BBOX,
                            REVIEW_STATUSES, SUITABILITY, THEMES, data_root, norm_theme)
from planning.audit import acting_as

router = APIRouter(prefix="/datasets", tags=["datasets"])


@router.get("/vocabulary")
def vocabulary():
    return {"data_classes": DATA_CLASSES, "suitability": SUITABILITY, "access_methods": ACCESS_METHODS,
            "review_statuses": REVIEW_STATUSES, "check_statuses": CHECK_STATUSES, "feature_statuses": FEATURE_STATUSES,
            "themes": THEMES, "pune_bbox": PUNE_BBOX, "engineering_crs": ENGINEERING_CRS, "data_root": data_root(),
            "rules": ["A newer version is registered as pending_review; it never replaces the active version silently.",
                      "SYNTHETIC data never satisfies a feature dependency.",
                      "Engineering suitability needs a stated accuracy and an official source.",
                      "Missing licence = UNKNOWN; missing coverage = UNKNOWN (absence of features proves nothing)."]}


@router.get("/sources")
def sources(db: Session = Depends(get_db)):
    return [registry.source_dict(s) for s in db.scalars(select(DsSourceEntity).order_by(DsSourceEntity.id))]


@router.get("/features")
def features(db: Session = Depends(get_db)):
    rows = db.scalars(select(DsFeatureEntity).order_by(DsFeatureEntity.capability, DsFeatureEntity.id)).all()
    out = [registry.feature_status(db, f) for f in rows]
    summary = {s: sum(1 for f in out if f["status"] == s) for s in FEATURE_STATUSES}
    return {"features": out, "summary": summary}


@router.get("/features/{feature_id}")
def feature(feature_id: str, db: Session = Depends(get_db)):
    f = db.get(DsFeatureEntity, feature_id)
    if f is None:
        raise HTTPException(404, "feature not found")
    return registry.feature_status(db, f)


class ImportBody(BaseModel):
    root: Optional[str] = None
    dry_run: bool = False
    actor: str = "anonymous"


@router.post("/import")
def import_tree(body: ImportBody, db: Session = Depends(get_db)):
    root = body.root or data_root()
    if not os.path.isdir(root):
        return {"root": os.path.abspath(root), "exists": False, "entries": [], "summary": {}}
    with acting_as(body.actor):
        rep = importer.scan(db, root)
        if body.dry_run:
            db.rollback()
        else:
            db.commit()
    return rep


@router.post("/sync-catalogues")
def sync(db: Session = Depends(get_db)):
    with acting_as("system (catalogue sync)"):
        n = sync_catalogues(db)
        db.commit()
    return n


@router.get("")
def list_datasets(theme: Optional[str] = None, status: Optional[str] = None, q: Optional[str] = None, db: Session = Depends(get_db)):
    with acting_as("system (catalogue sync)"):
        sync_catalogues(db)
        db.commit()
    rows = db.scalars(select(DsDatasetEntity).order_by(DsDatasetEntity.theme, DsDatasetEntity.id)).all()
    out = []
    for d in rows:
        if theme and d.theme != theme:
            continue
        item = registry.dataset_dict(db, d, full=False)
        if status and item["status"] != status:
            continue
        if q and q.lower() not in f"{d.id} {d.title} {d.description}".lower():
            continue
        out.append(item)
    return out


@router.get("/versions/{version_id}")
def get_version(version_id: str, db: Session = Depends(get_db)):
    v = db.get(DsDatasetVersionEntity, version_id)
    if v is None:
        raise HTTPException(404, "version not found")
    return registry.version_dict(db, v, full=True)


class ReviewBody(BaseModel):
    decision: str
    reviewer: str
    note: str = ""
    data_class: Optional[str] = None
    suitability: Optional[str] = None


@router.post("/versions/{version_id}/review")
def review(version_id: str, body: ReviewBody, db: Session = Depends(get_db)):
    try:
        with acting_as(body.reviewer):
            v = registry.review_version(db, version_id, body.decision, body.reviewer, body.note, body.data_class, body.suitability)
            if body.data_class or body.suitability:
                quality.run_checks(db, v)
            db.commit()
    except KeyError:
        raise HTTPException(404, "version not found")
    except (ValueError, ImmutableVersionError) as e:
        db.rollback()
        raise HTTPException(400, str(e))
    return registry.version_dict(db, v, full=True)


class QualityBody(BaseModel):
    hash_files: bool = True


@router.post("/versions/{version_id}/quality")
def run_quality(version_id: str, body: QualityBody = QualityBody(), db: Session = Depends(get_db)):
    v = db.get(DsDatasetVersionEntity, version_id)
    if v is None:
        raise HTTPException(404, "version not found")
    res = quality.run_checks(db, v, hash_files=body.hash_files)
    db.commit()
    return {"version_id": v.id, "checks": res}


class VersionBody(BaseModel):
    registered_by: str
    version_label: Optional[str] = None
    observation_start: Optional[str] = None
    observation_end: Optional[str] = None
    published_date: Optional[str] = None
    source_updated_date: Optional[str] = None
    retrieved_at: Optional[str] = None
    sha256: Optional[str] = None
    coverage_bbox: Optional[list[float]] = Field(default=None, min_length=4, max_length=4)
    crs: Optional[str] = None
    resolution: Optional[str] = None
    format: Optional[str] = None
    size_bytes: Optional[int] = None
    data_class: Optional[str] = None
    suitability: Optional[str] = None
    accuracy_statement: str = ""
    licence_text: str = "UNKNOWN"
    licence_url: str = ""
    notes: str = ""
    files: list[dict] = []


class DatasetBody(BaseModel):
    id: str
    title: str
    theme: str = "other"
    description: str = ""
    source_id: Optional[str] = None
    limitations: str = ""
    max_age_days: Optional[int] = None
    created_by: str


@router.post("", status_code=201)
def create_dataset(body: DatasetBody, db: Session = Depends(get_db)):
    if db.get(DsDatasetEntity, body.id) is not None:
        raise HTTPException(409, "dataset exists")
    if body.source_id and db.get(DsSourceEntity, body.source_id) is None:
        raise HTTPException(400, "unknown source")
    with acting_as(body.created_by):
        d = registry.ensure_dataset(db, body.id, title=body.title, theme=norm_theme(body.theme), description=body.description,
                                    source_id=body.source_id, limitations=body.limitations, max_age_days=body.max_age_days, origin="api")
        db.commit()
    return registry.dataset_dict(db, d, full=True)


@router.post("/{dataset_id}/versions", status_code=201)
def register_version(dataset_id: str, body: VersionBody, db: Session = Depends(get_db)):
    if db.get(DsDatasetEntity, dataset_id) is None:
        raise HTTPException(404, "dataset not found")
    data = body.model_dump()
    files = [{"path": f.get("path"), "sha256": f.get("sha256"), "size_bytes": f.get("size_bytes"), "format": f.get("format"),
              "url": f.get("url"), "role": f.get("role", "raw")} for f in data.pop("files") if f.get("path")]
    who = data.pop("registered_by")
    bbox = data.pop("coverage_bbox")
    with acting_as(who):
        v = registry.add_version(db, dataset_id, files=files, origin="api", coverage_bbox_json=bbox,
                                 fingerprint=registry.fingerprint("api", dataset_id, data, files), **data)
        quality.run_checks(db, v)
        db.commit()
    return registry.version_dict(db, v, full=True)


class UpdateBody(BaseModel):
    checked_by: str = "anonymous"


@router.post("/{dataset_id}/update-check")
def update_check(dataset_id: str, body: UpdateBody = UpdateBody(), db: Session = Depends(get_db)):
    try:
        with acting_as(body.checked_by):
            row = updates.check(db, dataset_id, body.checked_by)
            db.commit()
    except KeyError:
        raise HTTPException(404, "dataset not found")
    return registry.update_check_dict(row)


@router.get("/{dataset_id}")
def get_dataset(dataset_id: str, db: Session = Depends(get_db)):
    d = db.get(DsDatasetEntity, dataset_id)
    if d is None:
        raise HTTPException(404, "dataset not found")
    return registry.dataset_dict(db, d, full=True)
