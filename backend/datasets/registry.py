"""
Registry service: register sources / datasets / immutable versions, review a pending version, compute feature status.
Everything returned to the API goes through the serialisers here.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import uuid
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (DsDatasetEntity, DsDatasetVersionEntity, DsFeatureDependencyEntity, DsFeatureEntity, DsFileEntity,
                     DsProcessingRunEntity, DsQualityCheckEntity, DsSourceEntity, DsUpdateCheckEntity)
from .vocab import DATA_CLASSES, SUITABILITY, SUITABILITY_RANK


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _j(text: str | None, default: Any = None) -> Any:
    if text in (None, ""):
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default


def fingerprint(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


# ── sources / datasets ──────────────────────────────────────────────────────────────────────────────────────────────
def ensure_source(db: Session, sid: str, **fields) -> DsSourceEntity:
    s = db.get(DsSourceEntity, sid)
    if s is None:
        s = DsSourceEntity(id=sid, name=fields.pop("name", sid), **{k: v for k, v in fields.items() if v is not None})
        db.add(s)
        db.flush()
    return s


def ensure_dataset(db: Session, did: str, **fields) -> DsDatasetEntity:
    d = db.get(DsDatasetEntity, did)
    if d is None:
        for k in ("backs_catalogue_json", "recommended_sources_json", "update_check_json"):
            if k in fields and not isinstance(fields[k], str):
                fields[k] = json.dumps(fields[k])
        d = DsDatasetEntity(id=did, title=fields.pop("title", did), **{k: v for k, v in fields.items() if v is not None})
        db.add(d)
        db.flush()
    return d


def versions_of(db: Session, dataset_id: str) -> list[DsDatasetVersionEntity]:
    return list(db.scalars(select(DsDatasetVersionEntity).where(DsDatasetVersionEntity.dataset_id == dataset_id)
                           .order_by(DsDatasetVersionEntity.created_at, DsDatasetVersionEntity.id)))


def active_version(db: Session, dataset_id: str) -> DsDatasetVersionEntity | None:
    for v in reversed(versions_of(db, dataset_id)):
        if v.review_status == "active":
            return v
    return None


def find_version_by_fingerprint(db: Session, fp: str) -> DsDatasetVersionEntity | None:
    return db.scalars(select(DsDatasetVersionEntity).where(DsDatasetVersionEntity.fingerprint == fp)).first()


def add_version(db: Session, dataset_id: str, *, files: Iterable[dict] = (), activate_if_first: bool = True,
                warnings: list[str] | None = None, **fields) -> DsDatasetVersionEntity:
    """Registers a new immutable version. The first version of a dataset becomes active (nothing to replace); any later
    version is `pending_review` and never replaces the active one silently."""
    warnings = warnings if warnings is not None else []
    for k in ("coverage_bbox_json", "http_json", "stats_json"):
        if k in fields and fields[k] is not None and not isinstance(fields[k], str):
            fields[k] = json.dumps(fields[k])
    dc = fields.get("data_class")
    if dc is not None and dc not in DATA_CLASSES:
        warnings.append(f"data class '{dc}' is not in the vocabulary; left unclassified")
        fields["data_class"] = None
    su = fields.get("suitability")
    if su is not None and su not in SUITABILITY:
        warnings.append(f"suitability '{su}' is not in the vocabulary; left unstated")
        fields["suitability"] = None
    if fields.get("suitability") == "engineering":
        src = None
        ds = db.get(DsDatasetEntity, dataset_id)
        if ds and ds.source_id:
            src = db.get(DsSourceEntity, ds.source_id)
        if not (fields.get("accuracy_statement") or "").strip() or not (src and src.official):
            warnings.append("engineering suitability needs a stated accuracy and an official source; recorded as screening")
            fields["suitability"] = "screening"
    existing = versions_of(db, dataset_id)
    has_active = any(v.review_status == "active" for v in existing)
    status = "active" if (activate_if_first and not has_active) else "pending_review"
    notes = fields.pop("notes", "") or ""
    if warnings:
        notes = (notes + ("\n" if notes else "") + "Registration warnings: " + "; ".join(warnings)).strip()
    v = DsDatasetVersionEntity(id=fields.pop("id", None) or new_id("dsv"), dataset_id=dataset_id, review_status=status,
                               notes=notes, version_label=fields.pop("version_label", None) or f"v{len(existing) + 1}",
                               supersedes_id=(existing[-1].id if existing else None), **fields)
    if status == "active":
        v.reviewed_by, v.reviewed_at = "system (first version of the dataset)", _utcnow()
    db.add(v)
    db.flush()
    for f in files:
        db.add(DsFileEntity(id=new_id("dsf"), version_id=v.id, **f))
    db.flush()
    return v


def _utcnow():
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


def review_version(db: Session, version_id: str, decision: str, reviewer: str, note: str = "",
                   data_class: str | None = None, suitability: str | None = None) -> DsDatasetVersionEntity:
    """decision: activate | reject. Activating supersedes the previously active version (kept, readable)."""
    if not reviewer.strip():
        raise ValueError("reviewer is required")
    v = db.get(DsDatasetVersionEntity, version_id)
    if v is None:
        raise KeyError(version_id)
    if decision not in ("activate", "reject"):
        raise ValueError("decision must be activate or reject")
    if v.review_status not in ("pending_review",) and not (decision == "activate" and v.review_status == "superseded"):
        raise ValueError(f"version is {v.review_status}; only a pending (or superseded, to roll back) version can be reviewed")
    if data_class is not None:
        if v.data_class is not None:
            raise ValueError("data class is already recorded and is immutable")
        if data_class not in DATA_CLASSES:
            raise ValueError("unknown data class")
        v.data_class = data_class
    if suitability is not None:
        if v.suitability is not None:
            raise ValueError("suitability is already recorded and is immutable")
        if suitability not in SUITABILITY:
            raise ValueError("unknown suitability")
        if suitability == "engineering":
            raise ValueError("engineering suitability can only come from the registration with a stated accuracy and an official source")
        v.suitability = suitability
    now = _utcnow()
    if decision == "activate":
        for other in versions_of(db, v.dataset_id):
            if other.id != v.id and other.review_status == "active":
                other.review_status, other.reviewed_by, other.reviewed_at = "superseded", reviewer, now
                other.review_note = f"superseded by {v.id}"
        v.review_status = "active"
    else:
        v.review_status = "rejected"
    v.reviewed_by, v.reviewed_at, v.review_note = reviewer, now, note or None
    db.flush()
    return v


# ── serialisers ─────────────────────────────────────────────────────────────────────────────────────────────────────
def source_dict(s: DsSourceEntity | None) -> dict | None:
    if s is None:
        return None
    return {"id": s.id, "name": s.name, "publisher": s.publisher, "url": s.url, "access_method": s.access_method,
            "licence_text": s.licence_text, "licence_url": s.licence_url, "robots_notes": s.robots_notes,
            "tos_notes": s.tos_notes, "official": bool(s.official), "registration_required": bool(s.registration_required),
            "notes": s.notes, "origin": s.origin}


def latest_checks(db: Session, version_id: str) -> list[dict]:
    rows = db.scalars(select(DsQualityCheckEntity).where(DsQualityCheckEntity.version_id == version_id)
                      .order_by(DsQualityCheckEntity.run_at, DsQualityCheckEntity.id)).all()
    latest: dict[str, DsQualityCheckEntity] = {}
    for r in rows:
        latest[r.check] = r
    return [{"check": r.check, "status": r.status, "value": r.value, "detail": r.detail,
             "run_at": r.run_at.isoformat() + "Z" if r.run_at else None} for r in latest.values()]


def version_dict(db: Session, v: DsDatasetVersionEntity, full: bool = True) -> dict:
    d = {"id": v.id, "dataset_id": v.dataset_id, "version_label": v.version_label, "review_status": v.review_status,
         "observation_start": v.observation_start, "observation_end": v.observation_end,
         "published_date": v.published_date, "source_updated_date": v.source_updated_date, "retrieved_at": v.retrieved_at,
         "sha256": v.sha256, "coverage_bbox": _j(v.coverage_bbox_json), "has_coverage_polygon": bool(v.coverage_geojson),
         "crs": v.crs, "resolution": v.resolution, "format": v.format, "size_bytes": v.size_bytes,
         "data_class": v.data_class, "suitability": v.suitability, "accuracy_statement": v.accuracy_statement,
         "licence_text": v.licence_text, "licence_url": v.licence_url, "http": _j(v.http_json, {}),
         "stats": _j(v.stats_json, {}), "notes": v.notes, "origin": v.origin, "origin_path": v.origin_path,
         "supersedes_id": v.supersedes_id, "reviewed_by": v.reviewed_by,
         "reviewed_at": v.reviewed_at.isoformat() + "Z" if v.reviewed_at else None, "review_note": v.review_note,
         "created_at": v.created_at.isoformat() + "Z" if v.created_at else None}
    if full:
        d["coverage_geojson"] = _j(v.coverage_geojson)
        d["files"] = [{"id": f.id, "role": f.role, "path": f.path, "sha256": f.sha256, "size_bytes": f.size_bytes,
                       "format": f.format, "url": f.url}
                      for f in db.scalars(select(DsFileEntity).where(DsFileEntity.version_id == v.id))]
        d["processing_runs"] = [processing_dict(p) for p in db.scalars(
            select(DsProcessingRunEntity).where(DsProcessingRunEntity.version_id == v.id))]
    d["quality_checks"] = latest_checks(db, v.id)
    return d


def processing_dict(p: DsProcessingRunEntity) -> dict:
    return {"id": p.id, "version_id": p.version_id, "pipeline": p.pipeline, "git_commit": p.git_commit,
            "params": _j(p.params_json, {}), "inputs": _j(p.inputs_json, []), "outputs": _j(p.outputs_json, []),
            "validation": _j(p.validation_json, {}), "started_at": p.started_at, "finished_at": p.finished_at,
            "origin_path": p.origin_path}


def dataset_status(db: Session, d: DsDatasetEntity) -> dict:
    vs = versions_of(db, d.id)
    act = next((v for v in reversed(vs) if v.review_status == "active"), None)
    pending = [v.id for v in vs if v.review_status == "pending_review"]
    if act is None:
        status = "pending_review" if pending else "not_acquired"
    else:
        status = "synthetic" if act.data_class == "synthetic" else "available"
    return {"status": status, "active_version_id": act.id if act else None, "pending_version_ids": pending,
            "version_count": len(vs)}


def dataset_dict(db: Session, d: DsDatasetEntity, full: bool = False) -> dict:
    st = dataset_status(db, d)
    out = {"id": d.id, "title": d.title, "description": d.description, "theme": d.theme, "source_id": d.source_id,
           "source": source_dict(db.get(DsSourceEntity, d.source_id)) if d.source_id else None,
           "catalogue_ref": d.catalogue_ref, "backs_catalogue": _j(d.backs_catalogue_json, []),
           "recommended_sources": _j(d.recommended_sources_json, []), "limitations": d.limitations,
           "max_age_days": d.max_age_days, "update_check": _j(d.update_check_json, {}), "origin": d.origin, **st}
    act = db.get(DsDatasetVersionEntity, st["active_version_id"]) if st["active_version_id"] else None
    out["active_version"] = version_dict(db, act, full=full) if act else None
    if full:
        out["versions"] = [version_dict(db, v, full=True) for v in versions_of(db, d.id)]
        out["update_checks"] = [update_check_dict(u) for u in db.scalars(
            select(DsUpdateCheckEntity).where(DsUpdateCheckEntity.dataset_id == d.id).order_by(DsUpdateCheckEntity.checked_at.desc()))]
        out["used_by_features"] = sorted({dep.feature_id for dep in db.scalars(select(DsFeatureDependencyEntity).where(
            (DsFeatureDependencyEntity.dataset_id == d.id) | ((DsFeatureDependencyEntity.dataset_id.is_(None)) & (DsFeatureDependencyEntity.theme == d.theme))))})
    return out


def update_check_dict(u: DsUpdateCheckEntity) -> dict:
    return {"id": u.id, "dataset_id": u.dataset_id, "method": u.method, "url": u.url, "etag": u.etag,
            "last_modified": u.last_modified, "catalogue_modified": u.catalogue_modified, "content_length": u.content_length,
            "result": u.result, "detail": u.detail, "new_version_id": u.new_version_id, "checked_by": u.checked_by,
            "checked_at": u.checked_at.isoformat() + "Z" if u.checked_at else None}


# ── feature status ──────────────────────────────────────────────────────────────────────────────────────────────────
DEP_STATE_ORDER = {"satisfied": 4, "insufficient_quality": 3, "quality_fail": 2, "unclassified": 2, "synthetic_only": 1,
                   "pending_review": 1, "missing": 0}


def _evaluate_candidate(db: Session, d: DsDatasetEntity, required_quality: str) -> dict:
    st = dataset_status(db, d)
    base = {"dataset_id": d.id, "dataset_title": d.title}
    if st["active_version_id"] is None:
        state = "pending_review" if st["pending_version_ids"] else "missing"
        why = (f"{d.title}: a version is registered but pending review" if state == "pending_review"
               else f"{d.title}: not acquired")
        return {**base, "state": state, "reason": why, "version_id": None}
    v = db.get(DsDatasetVersionEntity, st["active_version_id"])
    checks = {c["check"]: c for c in latest_checks(db, v.id)}
    base["version_id"] = v.id
    if v.data_class == "synthetic":
        return {**base, "state": "synthetic_only", "reason": f"{d.title}: SYNTHETIC — never counts as data"}
    if v.data_class is None or v.suitability is None:
        return {**base, "state": "unclassified", "reason": f"{d.title}: data class or suitability not recorded"}
    fails = [c for c in checks.values() if c["status"] == "fail" and c["check"] in ("checksum", "classification", "pune_coverage", "crs", "geometry_validity")]
    if fails:
        return {**base, "state": "quality_fail", "reason": f"{d.title}: quality check failed — " + "; ".join(f"{c['check']}: {c['detail']}" for c in fails)}
    if SUITABILITY_RANK[v.suitability] < SUITABILITY_RANK[required_quality]:
        return {**base, "state": "insufficient_quality",
                "reason": f"{d.title}: suitable for {v.suitability}, {required_quality} needed"}
    warn = [c for c in checks.values() if c["status"] in ("warn", "fail")]
    reason = f"{d.title}: {v.suitability}, {v.data_class}"
    if warn:
        reason += " (" + "; ".join(f"{c['check']} {c['status']}" for c in warn) + ")"
    return {**base, "state": "satisfied", "reason": reason}


def evaluate_dependency(db: Session, dep: DsFeatureDependencyEntity) -> dict:
    if dep.dataset_id:
        cands = [x for x in [db.get(DsDatasetEntity, dep.dataset_id)] if x is not None]
        if dep.theme:
            cands += [x for x in db.scalars(select(DsDatasetEntity).where(DsDatasetEntity.theme == dep.theme)) if x.id != dep.dataset_id]
    else:
        cands = list(db.scalars(select(DsDatasetEntity).where(DsDatasetEntity.theme == dep.theme)))
    evals = [_evaluate_candidate(db, c, dep.required_quality) for c in cands]
    evals.sort(key=lambda e: -DEP_STATE_ORDER[e["state"]])
    best = evals[0] if evals else {"state": "missing", "reason": f"no dataset of theme '{dep.theme}' registered",
                                   "dataset_id": None, "dataset_title": None, "version_id": None}
    return {"dependency_id": dep.id, "theme": dep.theme, "preferred_dataset_id": dep.dataset_id,
            "required_quality": dep.required_quality, "required": bool(dep.required), "note": dep.note,
            "state": best["state"], "reason": best["reason"], "dataset_id": best["dataset_id"],
            "dataset_title": best["dataset_title"], "version_id": best["version_id"],
            "candidates": [{k: e[k] for k in ("dataset_id", "state")} for e in evals]}


def feature_status(db: Session, f: DsFeatureEntity) -> dict:
    deps = list(db.scalars(select(DsFeatureDependencyEntity).where(DsFeatureDependencyEntity.feature_id == f.id)
                           .order_by(DsFeatureDependencyEntity.id)))
    evals = [evaluate_dependency(db, d) for d in deps]
    req = [e for e in evals if e["required"]]
    unmet = [e for e in req if e["state"] != "satisfied"]
    usable = [e for e in req if e["state"] in ("satisfied", "insufficient_quality")]
    if not unmet:
        status = "ready"
    elif usable:
        status = "partial"
    else:
        status = "blocked"
    reasons = [e["reason"] for e in unmet]
    capped = False
    if f.status_cap and status == "ready" and f.status_cap in ("partial", "blocked"):
        status, capped = f.status_cap, True
        reasons.insert(0, f.status_cap_reason or "capped")
    elif f.status_cap_reason:
        reasons.append(f.status_cap_reason)
    for e in evals:
        if not e["required"] and e["state"] != "satisfied":
            reasons.append(f"optional: {e['reason']}")
    return {"id": f.id, "workspace": f.workspace, "capability": f.capability, "name": f.name, "description": f.description,
            "status": status, "capped": capped, "status_cap": f.status_cap, "status_cap_reason": f.status_cap_reason,
            "reasons": reasons, "dependencies": evals}
