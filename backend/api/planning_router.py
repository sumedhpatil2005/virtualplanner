"""
Planning & Approval Workspace API (`/api/planning`, docs/PLANNING_WORKSPACE.md).

Projects reference existing records (scenarios, scenario versions, runs, traffic datasets, feasibility assessments)
through links; nothing is copied. The audit log is written by planning.audit session hooks for every router.
A decision is "a planning decision recorded in this tool": never an engineering assessment or statutory approval.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from api.scenario_router import baseline_fingerprint
from database.connection import get_db
from feasibility.models import EvidenceEntity, FeasibilityAssessmentEntity, InvestigationDocumentEntity, ReviewRecordEntity
from models.models import AreaEntity, ScenarioEntity, ScenarioRunEntity, ScenarioVersionEntity
from planning import audit
from planning.models import (
    DECISION_KIND_LABEL, EVIDENCE_REF_TYPES, LINK_TYPES, PROJECT_STATUS_LABEL, PROJECT_STATUSES, AuditLogEntity,
    PlanningDecisionEntity, PlanningProjectEntity, PlanningProjectLinkEntity,
)
from traffic_data.models import TrafficDatasetEntity

router = APIRouter(prefix="/planning", tags=["planning"])


def _iso(d: datetime.datetime | None) -> str | None:
    return d.isoformat() + "Z" if d else None


# ── schemas ───────────────────────────────────────────────────────────────────

class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    area_id: Optional[str] = None
    bbox: Optional[list[float]] = Field(default=None, description="[minLon, minLat, maxLon, maxLat]")
    created_by: str = Field(min_length=1)


class ProjectPatch(BaseModel):
    edited_by: str = Field(min_length=1)
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    status: Optional[Literal["draft", "under_study", "under_review"]] = None  # 'decision_recorded' only by recording a decision
    preferred_scenario_id: Optional[str] = Field(default=None, description="an attached scenario; '' clears. A working flag, not a decision")


class LinkIn(BaseModel):
    entity_type: Literal["scenario", "scenario_version", "run", "dataset", "assessment"]
    entity_id: str = Field(min_length=1)
    note: str = ""
    added_by: str = Field(min_length=1)


class EvidenceRef(BaseModel):
    type: Literal["evidence", "review", "document", "assessment", "dataset", "run", "scenario_version"]
    id: str


class DecisionIn(BaseModel):
    decision_text: str = Field(min_length=1)
    decided_by: str = Field(min_length=1)
    role: str = ""
    organisation: str = ""
    scenario_version_id: Optional[str] = None
    evidence_refs: list[EvidenceRef] = []
    supersedes: Optional[str] = None


# ── helpers ───────────────────────────────────────────────────────────────────

_ENTITY = {
    "scenario": ScenarioEntity, "scenario_version": ScenarioVersionEntity, "run": ScenarioRunEntity,
    "dataset": TrafficDatasetEntity, "assessment": FeasibilityAssessmentEntity, "evidence": EvidenceEntity,
    "review": ReviewRecordEntity, "document": InvestigationDocumentEntity,
}


def _get_project(db: Session, pid: str) -> PlanningProjectEntity:
    p = db.get(PlanningProjectEntity, pid)
    if not p:
        raise HTTPException(404, "Project not found")
    return p


def _links(db: Session, pid: str) -> list[PlanningProjectLinkEntity]:
    return db.query(PlanningProjectLinkEntity).filter(PlanningProjectLinkEntity.project_id == pid).order_by(PlanningProjectLinkEntity.id).all()


def _link_label(db: Session, t: str, eid: str) -> str:
    e = db.get(_ENTITY[t], eid)
    if e is None:
        return "(record no longer exists)"
    if t == "scenario":
        return e.name
    if t == "scenario_version":
        return f"v{e.number} {e.label} (scenario {e.scenario_id})"
    if t == "run":
        return f"run of {e.scenario_id} at {_iso(e.created_at)}"
    if t == "dataset":
        return f"{e.name} [{e.kind}{', synthetic' if e.synthetic else ''}]"
    if t == "assessment":
        return f"{e.name} ({e.proposal_type})"
    return eid


def _link_out(db: Session, l: PlanningProjectLinkEntity) -> dict:
    return {"id": l.id, "entity_type": l.entity_type, "entity_id": l.entity_id, "label": _link_label(db, l.entity_type, l.entity_id),
            "exists": db.get(_ENTITY[l.entity_type], l.entity_id) is not None, "note": l.note, "added_by": l.added_by, "added_at": _iso(l.added_at)}


def _decision_out(d: PlanningDecisionEntity) -> dict:
    return {"id": d.id, "seq": d.seq, "project_id": d.project_id, "decision_text": d.decision_text, "decided_by": d.decided_by,
            "role": d.role, "organisation": d.organisation, "scenario_id": d.scenario_id, "scenario_version_id": d.scenario_version_id,
            "evidence_refs": json.loads(d.evidence_refs_json), "supersedes": d.supersedes, "created_at": _iso(d.created_at),
            "kind": "planning_decision_recorded_in_tool", "kind_label": DECISION_KIND_LABEL,
            "is_statutory_approval": False, "is_engineering_assessment": False}


def _project_out(db: Session, p: PlanningProjectEntity, full: bool = False) -> dict:
    d = {"id": p.id, "name": p.name, "description": p.description, "area_id": p.area_id,
         "bbox": [p.min_lon, p.min_lat, p.max_lon, p.max_lat] if p.min_lon is not None else None,
         "baseline_id": p.baseline_id, "baseline_fingerprint": p.baseline_fingerprint, "status": p.status,
         "status_label": PROJECT_STATUS_LABEL[p.status], "preferred_scenario_id": p.preferred_scenario_id, "created_by": p.created_by, "created_at": _iso(p.created_at), "updated_at": _iso(p.updated_at),
         "link_count": db.query(func.count(PlanningProjectLinkEntity.id)).filter(PlanningProjectLinkEntity.project_id == p.id).scalar()}
    if full:
        cur = baseline_fingerprint(db, p.baseline_id)
        d["baseline_current_fingerprint"] = cur
        d["baseline_changed_since_created"] = cur != p.baseline_fingerprint
        d["links"] = [_link_out(db, l) for l in _links(db, p.id)]
        d["decisions"] = [_decision_out(x) for x in db.query(PlanningDecisionEntity).filter(PlanningDecisionEntity.project_id == p.id).order_by(PlanningDecisionEntity.seq)]
        if p.area_id:
            a = db.get(AreaEntity, p.area_id)
            d["area"] = {"id": a.id, "name": a.name, "bbox": [a.min_lon, a.min_lat, a.max_lon, a.max_lat]} if a else None
    return d


def linked_scope(db: Session, pid: str) -> list[tuple[str, str]]:
    """(entity_type, id) pairs whose audit events belong to the project's timeline (incl. the scenarios of linked versions/runs)."""
    pairs = {("project", pid)}
    for l in _links(db, pid):
        pairs.add((l.entity_type, l.entity_id))
        if l.entity_type in ("scenario_version", "run"):
            e = db.get(_ENTITY[l.entity_type], l.entity_id)
            if e is not None:
                pairs.add(("scenario", e.scenario_id))
    return sorted(pairs)


def _audit_out(a: AuditLogEntity) -> dict:
    return {"id": a.id, "at": _iso(a.at), "actor": a.actor, "actor_source": a.actor_source, "action": a.action,
            "entity_type": a.entity_type, "entity_id": a.entity_id, "parent_type": a.parent_type, "parent_id": a.parent_id,
            "label": a.label, "changed_fields": json.loads(a.changed_fields) if a.changed_fields else None,
            "before_hash": a.before_hash, "after_hash": a.after_hash}


def project_events(db: Session, pid: str, limit: int | None = 500) -> list[AuditLogEntity]:
    conds = []
    for t, i in linked_scope(db, pid):
        conds.append(and_(AuditLogEntity.entity_type == t, AuditLogEntity.entity_id == i))
        conds.append(and_(AuditLogEntity.parent_type == t, AuditLogEntity.parent_id == i))
    q = db.query(AuditLogEntity).filter(or_(*conds)).order_by(AuditLogEntity.id.desc())
    return q.limit(limit).all() if limit else q.all()


# ── projects ──────────────────────────────────────────────────────────────────

@router.get("/status-vocabulary")
def vocabulary():
    return {"project_statuses": [{"value": s, "label": PROJECT_STATUS_LABEL[s]} for s in PROJECT_STATUSES],
            "decision_kind_label": DECISION_KIND_LABEL, "has_approved_status": False, "link_types": list(LINK_TYPES)}


@router.get("/projects")
def list_projects(db: Session = Depends(get_db)):
    return [_project_out(db, p) for p in db.query(PlanningProjectEntity).order_by(PlanningProjectEntity.created_at.desc())]


@router.post("/projects", status_code=201)
def create_project(body: ProjectIn, db: Session = Depends(get_db)):
    if body.area_id and not db.get(AreaEntity, body.area_id):
        raise HTTPException(422, "Study area not found")
    bbox = body.bbox
    if bbox is not None:
        if len(bbox) != 4 or not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
            raise HTTPException(422, "bbox must be [minLon, minLat, maxLon, maxLat] with min < max")
    elif body.area_id:
        a = db.get(AreaEntity, body.area_id)
        bbox = [a.min_lon, a.min_lat, a.max_lon, a.max_lat]
    p = PlanningProjectEntity(id=f"prj_{uuid.uuid4().hex[:12]}", name=body.name.strip(), description=body.description,
                              area_id=body.area_id, baseline_id="base", baseline_fingerprint=baseline_fingerprint(db, "base"),
                              status="draft", created_by=body.created_by.strip(),
                              **(dict(zip(("min_lon", "min_lat", "max_lon", "max_lat"), bbox)) if bbox else {}))
    db.add(p)
    db.commit()
    return _project_out(db, p, full=True)


@router.get("/projects/{pid}")
def get_project(pid: str, db: Session = Depends(get_db)):
    return _project_out(db, _get_project(db, pid), full=True)


@router.patch("/projects/{pid}")
def patch_project(pid: str, body: ProjectPatch, db: Session = Depends(get_db)):
    p = _get_project(db, pid)
    with audit.acting_as(body.edited_by):
        for k in ("name", "description", "status"):
            v = getattr(body, k)
            if v is not None:
                setattr(p, k, v)
        if body.preferred_scenario_id is not None:
            sid = body.preferred_scenario_id or None
            if sid and not db.query(PlanningProjectLinkEntity).filter_by(project_id=pid, entity_type="scenario", entity_id=sid).first():
                raise HTTPException(422, "preferred_scenario_id must be a scenario attached to the project")
            p.preferred_scenario_id = sid
        db.commit()
    return _project_out(db, p, full=True)


@router.post("/projects/{pid}/links", status_code=201)
def add_link(pid: str, body: LinkIn, db: Session = Depends(get_db)):
    _get_project(db, pid)
    if db.get(_ENTITY[body.entity_type], body.entity_id) is None:
        raise HTTPException(422, f"{body.entity_type} {body.entity_id} not found")
    if db.query(PlanningProjectLinkEntity).filter_by(project_id=pid, entity_type=body.entity_type, entity_id=body.entity_id).first():
        raise HTTPException(409, "Already linked")
    l = PlanningProjectLinkEntity(project_id=pid, entity_type=body.entity_type, entity_id=body.entity_id, note=body.note, added_by=body.added_by.strip())
    db.add(l)
    db.commit()
    return _link_out(db, l)


@router.delete("/projects/{pid}/links/{link_id}")
def remove_link(pid: str, link_id: int, removed_by: str = Query(min_length=1), db: Session = Depends(get_db)):
    l = db.get(PlanningProjectLinkEntity, link_id)
    if not l or l.project_id != pid:
        raise HTTPException(404, "Link not found")
    with audit.acting_as(removed_by):
        db.delete(l)
        db.commit()
    return {"status": "unlinked", "note": "Only the link was removed; the linked record is unchanged."}


@router.get("/linkable")
def linkable(db: Session = Depends(get_db)):
    """Existing records that can be attached (read from their own tables)."""
    return {
        "scenario": [{"id": s.id, "label": s.name, "kind": s.kind} for s in db.query(ScenarioEntity).order_by(ScenarioEntity.name)],
        "scenario_version": [{"id": v.id, "label": f"v{v.number} {v.label}", "scenario_id": v.scenario_id} for v in db.query(ScenarioVersionEntity).order_by(ScenarioVersionEntity.created_at.desc()).limit(300)],
        "run": [{"id": r.id, "label": f"{r.scenario_id} {_iso(r.created_at)}", "scenario_id": r.scenario_id} for r in db.query(ScenarioRunEntity).order_by(ScenarioRunEntity.created_at.desc()).limit(300)],
        "dataset": [{"id": d.id, "label": d.name, "kind": d.kind, "synthetic": bool(d.synthetic)} for d in db.query(TrafficDatasetEntity).order_by(TrafficDatasetEntity.created_at.desc())],
        "assessment": [{"id": a.id, "label": f"{a.name} ({a.proposal_type})", "scenario_id": a.scenario_id} for a in db.query(FeasibilityAssessmentEntity).order_by(FeasibilityAssessmentEntity.created_at.desc()).limit(300)],
    }


# ── decisions ─────────────────────────────────────────────────────────────────

@router.post("/projects/{pid}/decisions", status_code=201)
def record_decision(pid: str, body: DecisionIn, db: Session = Depends(get_db)):
    p = _get_project(db, pid)
    links = _links(db, pid)
    linked_scenarios = {l.entity_id for l in links if l.entity_type == "scenario"}
    scenario_id = None
    if body.scenario_version_id:
        v = db.get(ScenarioVersionEntity, body.scenario_version_id)
        if not v:
            raise HTTPException(422, "Scenario version not found")
        linked_versions = {l.entity_id for l in links if l.entity_type == "scenario_version"}
        if v.scenario_id not in linked_scenarios and v.id not in linked_versions:
            raise HTTPException(422, "The scenario version must belong to a scenario attached to this project (attach it first)")
        scenario_id = v.scenario_id
    for r in body.evidence_refs:
        if db.get(_ENTITY[r.type], r.id) is None:
            raise HTTPException(422, f"Evidence reference {r.type} {r.id} not found")
    prev = db.query(PlanningDecisionEntity).filter(PlanningDecisionEntity.project_id == pid).order_by(PlanningDecisionEntity.seq.desc()).first()
    if body.supersedes and (not prev or not db.query(PlanningDecisionEntity).filter_by(id=body.supersedes, project_id=pid).first()):
        raise HTTPException(422, "supersedes must name an earlier decision of this project")
    d = PlanningDecisionEntity(id=f"dec_{uuid.uuid4().hex[:12]}", project_id=pid, seq=(prev.seq + 1) if prev else 1,
                               decision_text=body.decision_text.strip(), decided_by=body.decided_by.strip(), role=body.role, organisation=body.organisation,
                               scenario_id=scenario_id, scenario_version_id=body.scenario_version_id,
                               evidence_refs_json=json.dumps([r.model_dump() for r in body.evidence_refs]),
                               supersedes=body.supersedes or (prev.id if prev else None))
    db.add(d)
    with audit.acting_as(body.decided_by):
        p.status = "decision_recorded"
        db.commit()
    return _decision_out(d)


@router.get("/projects/{pid}/decisions")
def list_decisions(pid: str, db: Session = Depends(get_db)):
    _get_project(db, pid)
    return [_decision_out(x) for x in db.query(PlanningDecisionEntity).filter(PlanningDecisionEntity.project_id == pid).order_by(PlanningDecisionEntity.seq)]


# ── audit ─────────────────────────────────────────────────────────────────────

@router.get("/projects/{pid}/audit")
def project_audit(pid: str, limit: int = Query(default=300, le=5000), db: Session = Depends(get_db)):
    _get_project(db, pid)
    ev = project_events(db, pid, limit)
    return {"scope": [{"entity_type": t, "entity_id": i} for t, i in linked_scope(db, pid)], "events": [_audit_out(a) for a in ev]}


@router.get("/audit")
def audit_log(entity_type: Optional[str] = None, entity_id: Optional[str] = None, limit: int = Query(default=200, le=5000), db: Session = Depends(get_db)):
    q = db.query(AuditLogEntity)
    if entity_type:
        q = q.filter(AuditLogEntity.entity_type == entity_type)
    if entity_id:
        q = q.filter(or_(AuditLogEntity.entity_id == entity_id, AuditLogEntity.parent_id == entity_id))
    return [_audit_out(a) for a in q.order_by(AuditLogEntity.id.desc()).limit(limit)]


# ── report ────────────────────────────────────────────────────────────────────

@router.get("/projects/{pid}/report")
def export_report(pid: str, format: Literal["pdf", "docx"] = "pdf", requested_by: str = Query(default=""), db: Session = Depends(get_db)):
    from planning import report

    p = _get_project(db, pid)
    model = report.build_model(db, p)
    data = report.render(model, format)
    sha = hashlib.sha256(data).hexdigest()
    audit.record(db, action="export", entity_type="project_report", entity_id=p.id, actor=requested_by or None,
                 label=f"{format.upper()} report", parent_type="project", parent_id=p.id, after_hash=f"sha256:{sha}")
    db.commit()
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in p.name)[:60] or "project"
    mt = "application/pdf" if format == "pdf" else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return Response(content=data, media_type=mt, headers={
        "Content-Disposition": f'attachment; filename="planning-report-{safe}.{format}"', "X-Report-SHA256": sha,
        "Access-Control-Expose-Headers": "X-Report-SHA256, Content-Disposition"})
